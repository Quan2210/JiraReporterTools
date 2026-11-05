import asyncio
from dataclasses import replace
from datetime import datetime

import httpx
import pytest
import respx

from app.cache import TTLCache
from app.reminder_scheduler import ReminderScheduler
from app.reminder_service import ReminderService
from app.reminder_store import MAX_REMINDERS, ReminderLimitError, ReminderStore
from tests.conftest import SLACK_URL
from tests.fakes import FakeClient

NOW = datetime(2026, 11, 4, 9, 5)          # Wednesday
SLOT = "2026-11-04T09:00:00"
OLD = "2026-11-01T00:00:00"


def reminder_data(**over):
    data = {"name": "Daily", "enabled": True, "query": {"projects": ["ABC"]}, "template": "{key}: {summary}",
            "channel": "slack", "telegram_chat_id": None, "days": [0, 1, 2, 3, 4], "time": "09:00",
            "condition": "always", "max_lines": 30}
    data.update(over)
    return data


@pytest.fixture
def store(tmp_path):
    s = ReminderStore(tmp_path / "r.db")
    s.init()
    return s


@pytest.fixture
async def make_service(store, ch_settings):
    clients = []

    def _make(total=3, settings=None):
        http = httpx.AsyncClient()
        clients.append(http)
        return ReminderService(store, FakeClient(total=total), TTLCache(), settings or ch_settings, http,
                               retry_delay=0, run_timeout=5)

    yield _make
    for c in clients:
        await c.aclose()


def seed(store, **over):
    """A reminder old enough that today's 09:00 slot is after its active_since."""
    rid = store.create(reminder_data(**over))
    with store._conn() as c:
        c.execute("UPDATE reminders SET active_since=? WHERE id=?", (OLD, rid))
    return rid


@respx.mock
async def test_sent_when_due(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store)
    sched = ReminderScheduler(make_service())
    await asyncio.gather(*await sched.tick(NOW))
    assert route.call_count == 1
    assert b"ABC-1: Task 1" in route.calls[0].request.content
    run = store.list_runs(1)[0]
    assert run["status"] == "sent" and run["row_count"] == 3 and run["scheduled_for"] == SLOT


@respx.mock
async def test_same_slot_never_sent_twice(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store)
    sched = ReminderScheduler(make_service())
    await asyncio.gather(*await sched.tick(NOW))
    await asyncio.gather(*await sched.tick(NOW))
    assert route.call_count == 1 and len(store.list_runs(1)) == 1


@respx.mock
async def test_concurrent_ticks_send_once(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store)
    sched = ReminderScheduler(make_service())
    batches = await asyncio.gather(sched.tick(NOW), sched.tick(NOW))
    await asyncio.gather(*[t for b in batches for t in b])
    assert route.call_count == 1


@respx.mock
async def test_missed_slot_is_recorded_not_sent(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store)
    sched = ReminderScheduler(make_service())
    assert await sched.tick(datetime(2026, 11, 4, 13, 0)) == []
    assert route.call_count == 0 and store.list_runs(1)[0]["status"] == "missed"
    assert await sched.tick(datetime(2026, 11, 4, 13, 1)) == []          # not recorded twice
    assert len(store.list_runs(1)) == 1


@respx.mock
async def test_disabled_and_fresh_reminders_do_not_fire(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, enabled=False)
    store.create(reminder_data(name="Fresh"))        # active_since = real now, after NOW's slot -> ignored
    sched = ReminderScheduler(make_service())
    assert await sched.tick(NOW) == [] and route.call_count == 0


@respx.mock
async def test_only_if_results_skips_empty(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, condition="only_if_results")
    sched = ReminderScheduler(make_service(total=0))
    await asyncio.gather(*await sched.tick(NOW))
    assert route.call_count == 0 and store.list_runs(1)[0]["status"] == "skipped_empty"


@respx.mock
async def test_always_sends_empty_report(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store)
    await asyncio.gather(*await ReminderScheduler(make_service(total=0)).tick(NOW))
    assert route.call_count == 1


@respx.mock
async def test_truncates_to_max_lines(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, max_lines=2)
    await asyncio.gather(*await ReminderScheduler(make_service(total=5)).tick(NOW))
    text = route.calls[0].request.content.decode()
    assert "ABC-2" in text and "ABC-3" not in text and "3 issue nữa" in text


@respx.mock
async def test_jira_failure_marks_failed(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store)
    service = make_service()
    service.client.fail_on_call = 1
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    assert store.list_runs(1)[0]["status"] == "failed" and route.call_count == 0


@respx.mock
async def test_retries_once_on_5xx_then_succeeds(store, make_service):
    route = respx.post(SLACK_URL).mock(side_effect=[httpx.Response(503), httpx.Response(200, text="ok")])
    seed(store)
    await asyncio.gather(*await ReminderScheduler(make_service()).tick(NOW))
    assert route.call_count == 2 and store.list_runs(1)[0]["status"] == "sent"


@respx.mock
async def test_no_retry_on_4xx(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(404))
    seed(store)
    await asyncio.gather(*await ReminderScheduler(make_service()).tick(NOW))
    run = store.list_runs(1)[0]
    assert route.call_count == 1 and run["status"] == "failed" and "404" in run["error"]


async def test_unconfigured_channel_fails_without_sending(store, make_service, ch_settings):
    seed(store)
    service = make_service(settings=replace(ch_settings, slack_webhook_url=None))
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    assert "chưa được cấu hình" in store.list_runs(1)[0]["error"]


async def test_hung_run_times_out_without_blocking_others(store, make_service):
    seed(store, name="slow")
    seed(store, name="fast")
    service = make_service()
    service.run_timeout = 0.2
    calls = []

    async def fake_query(query, template="", extra=()):
        calls.append(1)
        if len(calls) == 1:
            await asyncio.sleep(5)
        return {"rows": [], "total": 0, "truncated": False}

    async def no_send(reminder, text):
        pass

    service._query, service.deliver = fake_query, no_send
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    statuses = sorted(r["status"] for rid in (1, 2) for r in store.list_runs(rid))
    assert statuses == ["failed", "sent"]


def test_running_rows_become_failed_on_restart(store):
    rid = seed(store)
    run_id = store.begin_scheduled_run(rid, SLOT)
    store.init()
    run = store.list_runs(rid)[0]
    assert run["id"] == run_id and run["status"] == "failed"


def test_update_restarts_active_since_only_when_needed(store):
    rid = seed(store)

    def active():
        return store.get(rid)["active_since"]

    store.update(rid, reminder_data(name="Renamed", template="{key}"))
    assert active() == OLD                                       # cosmetic edit keeps it
    store.update(rid, reminder_data(time="09:30"))
    changed = active()
    assert changed != OLD                                        # rescheduled -> restart
    store.update(rid, reminder_data(time="09:30", enabled=False))
    assert active() == changed                                   # disabling keeps it
    with store._conn() as c:
        c.execute("UPDATE reminders SET active_since=? WHERE id=?", (OLD, rid))
    store.update(rid, reminder_data(time="09:30", enabled=True))
    assert active() != OLD                                       # re-enabled -> restart


def test_manual_runs_do_not_collide_and_do_not_claim_slots(store):
    rid = seed(store)
    assert store.begin_manual_run(rid) != store.begin_manual_run(rid)
    assert store.begin_scheduled_run(rid, SLOT) is not None


def test_limit_and_cascade_delete(store):
    for i in range(MAX_REMINDERS):
        store.create(reminder_data(name=f"r{i}"))
    with pytest.raises(ReminderLimitError):
        store.create(reminder_data())
    store.begin_manual_run(1)
    assert store.delete(1) and store.list_runs(1) == []
