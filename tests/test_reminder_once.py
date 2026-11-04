import asyncio
import sqlite3
from datetime import date, datetime, timedelta

import httpx
import pytest
import respx

import app.schemas as schemas
from app.cache import TTLCache
from app.reminder_schedule import due_for, next_run
from app.reminder_scheduler import ReminderScheduler
from app.reminder_service import ReminderService
from app.reminder_store import ReminderStore
from tests.conftest import SLACK_URL
from tests.fakes import FakeClient
from tests.test_reminder_service import OLD, reminder_data

CATCHUP = timedelta(minutes=120)
RUN_AT = "2026-11-05T09:00"
SLOT = "2026-11-05T09:00:00"
AT = datetime(2026, 11, 5, 9, 5)


def once_data(**over):
    data = reminder_data(schedule_kind="once", run_at=RUN_AT, days=[], time="09:00")
    data.update(over)
    return data


@pytest.fixture
def store(tmp_path):
    s = ReminderStore(tmp_path / "once.db")
    s.init()
    return s


@pytest.fixture
async def make_service(store, ch_settings):
    clients = []

    def _make(total=3):
        http = httpx.AsyncClient()
        clients.append(http)
        return ReminderService(store, FakeClient(total=total), TTLCache(), ch_settings, http, retry_delay=0, run_timeout=5)

    yield _make
    for c in clients:
        await c.aclose()


def seed_once(store, **over):
    rid = store.create(once_data(**over))
    with store._conn() as c:
        c.execute("UPDATE reminders SET active_since=? WHERE id=?", (OLD, rid))
    return rid


# ---- schedule maths ---------------------------------------------------------

def reminder(**over):
    base = {"schedule_kind": "once", "run_at": RUN_AT, "enabled": True, "days": [], "time": "09:00",
            "active_since": OLD}
    base.update(over)
    return base


def test_once_not_due_before_its_time():
    assert due_for(reminder(), datetime(2026, 11, 5, 8, 59), CATCHUP) is None


def test_once_due_inside_window_and_missed_after():
    assert due_for(reminder(), AT, CATCHUP) == ("run", datetime(2026, 11, 5, 9, 0))
    assert due_for(reminder(), datetime(2026, 11, 5, 11, 1), CATCHUP) == ("missed", datetime(2026, 11, 5, 9, 0))


def test_once_slot_not_after_active_since_is_ignored():
    assert due_for(reminder(active_since="2026-11-05T09:30:00"), AT, CATCHUP) is None


def test_weekly_still_works_through_due_for():
    r = {"schedule_kind": "weekly", "days": [0, 1, 2, 3, 4], "time": "09:00", "active_since": OLD, "enabled": True}
    assert due_for(r, datetime(2026, 11, 4, 9, 5), CATCHUP) == ("run", datetime(2026, 11, 4, 9, 0))


def test_next_run():
    assert next_run(reminder(), AT) == datetime(2026, 11, 5, 9, 0)
    assert next_run(reminder(enabled=False), AT) is None
    weekly = {"schedule_kind": "weekly", "days": [0, 4], "time": "09:00", "enabled": True, "active_since": OLD}
    assert next_run(weekly, datetime(2026, 11, 4, 12, 0)) == datetime(2026, 11, 6, 9, 0)      # Wed -> Fri
    assert next_run(weekly, datetime(2026, 11, 6, 9, 0)) == datetime(2026, 11, 9, 9, 0)       # strictly after
    assert next_run({**weekly, "days": []}, AT) is None


# ---- one-time reminders end to end -----------------------------------------

@respx.mock
async def test_once_sends_exactly_once_and_turns_off(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    rid = seed_once(store)
    sched = ReminderScheduler(make_service())
    await asyncio.gather(*await sched.tick(AT))
    await asyncio.gather(*await sched.tick(AT + timedelta(minutes=1)))
    assert route.call_count == 1
    got = store.get(rid)
    assert got["enabled"] is False and got["state"] == "done"
    assert store.list_runs(rid)[0]["status"] == "sent"


@respx.mock
async def test_once_turns_off_even_when_sending_fails(store, make_service):
    respx.post(SLACK_URL).mock(return_value=httpx.Response(404))
    rid = seed_once(store)
    await asyncio.gather(*await ReminderScheduler(make_service()).tick(AT))
    assert store.get(rid)["state"] == "done" and store.list_runs(rid)[0]["status"] == "failed"


@respx.mock
async def test_once_missed_turns_off_without_sending(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    rid = seed_once(store)
    assert await ReminderScheduler(make_service()).tick(datetime(2026, 11, 5, 13, 0)) == []
    assert route.call_count == 0
    assert store.get(rid)["state"] == "done" and store.list_runs(rid)[0]["status"] == "missed"


@respx.mock
async def test_concurrent_ticks_send_once_even_for_once_reminders(store, make_service):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed_once(store)
    sched = ReminderScheduler(make_service())
    batches = await asyncio.gather(sched.tick(AT), sched.tick(AT))
    await asyncio.gather(*[t for b in batches for t in b])
    assert route.call_count == 1


def test_claim_and_turn_off_are_one_transaction(store):
    rid = seed_once(store)
    assert store.begin_scheduled_run(rid, SLOT, disable_once=True) is not None
    assert store.get(rid)["enabled"] is False
    # a second claim fails AND must not have changed anything
    rid2 = seed_once(store, name="two")
    store.begin_scheduled_run(rid2, SLOT)
    assert store.begin_scheduled_run(rid2, SLOT, disable_once=True) is None
    assert store.get(rid2)["enabled"] is True


def test_killed_mid_run_does_not_leave_reminder_enabled(store):
    """Old/crashed state: slot claimed but the reminder is still on. init() must fix it."""
    rid = seed_once(store)
    store.begin_scheduled_run(rid, SLOT)              # claim without disabling = what a crash could leave
    assert store.get(rid)["enabled"] is True
    store.init()                                      # next app start
    got = store.get(rid)
    assert got["enabled"] is False and got["state"] == "done"
    assert store.list_runs(rid)[0]["status"] == "failed"


def test_state_rules(store):
    weekly = store.create(reminder_data())
    assert store.get(weekly)["state"] == "active"
    store.update(weekly, reminder_data(enabled=False))
    assert store.get(weekly)["state"] == "off"

    rid = seed_once(store)
    store.begin_manual_run(rid)                                           # a test send never makes it "done"
    store.update(rid, once_data(enabled=False))
    assert store.get(rid)["state"] == "off"

    rid = seed_once(store, name="ran")
    store.begin_scheduled_run(rid, SLOT, disable_once=True)
    assert store.get(rid)["state"] == "done"
    store.update(rid, once_data(name="ran", run_at="2026-11-06T09:00", enabled=False))
    assert store.get(rid)["state"] == "off"                               # new run_at: the old run no longer counts


def test_update_restarts_active_since_for_once(store):
    rid = seed_once(store)
    store.update(rid, once_data(name="renamed"))
    assert store.get(rid)["active_since"] == OLD
    store.update(rid, once_data(run_at="2026-11-06T10:00", time="10:00"))
    assert store.get(rid)["active_since"] != OLD


def test_migration_from_old_schema(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, enabled INTEGER NOT NULL,
          query_json TEXT NOT NULL, template TEXT NOT NULL, channel TEXT NOT NULL, telegram_chat_id TEXT,
          days_json TEXT NOT NULL, time_hhmm TEXT NOT NULL, condition TEXT NOT NULL, max_lines INTEGER NOT NULL,
          active_since TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE reminder_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id INTEGER NOT NULL,
          kind TEXT NOT NULL, scheduled_for TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL, row_count INTEGER, error TEXT);
        INSERT INTO reminders VALUES (1,'Old',1,'{"projects":["ABC"],"columns":["issuekey"]}','{key}','slack',NULL,
          '[0,1]','09:00','always',30,'2026-11-01T00:00:00','2026-11-01T00:00:00','2026-11-01T00:00:00');
    """)
    conn.commit()
    conn.close()
    store = ReminderStore(path)
    store.init()
    store.init()                                       # idempotent
    got = store.get(1)
    assert got["schedule_kind"] == "weekly" and got["run_at"] is None and got["state"] == "active"
    assert got["days"] == [0, 1] and got["name"] == "Old"


# ---- history clean-up --------------------------------------------------------

def _insert_run(store, rid, started, status="sent", kind="scheduled", scheduled_for=None):
    with store._conn() as c:
        c.execute("INSERT INTO reminder_runs(reminder_id, kind, scheduled_for, started_at, status) VALUES (?,?,?,?,?)",
                  (rid, kind, scheduled_for or started, started, status))


def test_prune_history(store):
    rid = seed_once(store, name="a")
    other = store.create(reminder_data(name="b"))
    now = datetime(2026, 12, 4, 12, 0, 0)
    _insert_run(store, other, "2026-10-01T09:00:00")                   # old
    _insert_run(store, other, "2026-11-04T12:00:00")                   # exactly 30 days: kept
    _insert_run(store, other, "2026-11-04T11:59:59")                   # 1s older than 30 days: deleted
    _insert_run(store, other, "2026-10-02T09:00:00", status="running")  # running is never deleted
    _insert_run(store, other, "2026-12-01T09:00:00")                   # recent
    assert store.prune_history(30, now) == 2
    assert [r["started_at"] for r in store.list_runs(other)] == [
        "2026-12-01T09:00:00", "2026-10-02T09:00:00", "2026-11-04T12:00:00"]
    assert store.prune_history(30, now) == 0                           # idempotent
    # the newest run of a reminder survives however old it is
    _insert_run(store, rid, "2026-01-01T09:00:00")
    assert store.prune_history(30, now) == 0 and len(store.list_runs(rid)) == 1


def test_prune_keeps_the_run_that_makes_a_once_reminder_done(store):
    rid = seed_once(store)
    store.begin_scheduled_run(rid, SLOT, disable_once=True)
    with store._conn() as c:
        c.execute("UPDATE reminder_runs SET started_at='2026-01-01T09:00:00', status='sent'")
    _insert_run(store, rid, "2026-01-02T09:00:00", kind="manual", scheduled_for="2026-01-02T09:00:00.1")   # newer manual run
    store.prune_history(30, datetime(2026, 12, 4))
    assert store.get(rid)["state"] == "done"


async def test_scheduler_prunes_once_a_day(store, make_service):
    sched = ReminderScheduler(make_service())
    calls = []
    real = store.prune_history
    store.prune_history = lambda days, now=None: calls.append((days, now)) or real(days, now)
    t0 = datetime(2026, 11, 5, 8, 0)
    await sched.tick(t0)
    await sched.tick(t0 + timedelta(hours=1))
    await sched.tick(t0 + timedelta(hours=23, minutes=59))
    assert len(calls) == 1 and calls[0][0] == 30
    await sched.tick(t0 + timedelta(hours=24))
    assert len(calls) == 2


# ---- dynamic dates are re-resolved on every run -------------------------------

@respx.mock
async def test_token_dates_resolve_again_each_run(store, make_service, monkeypatch):
    respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed_once(store, query={"projects": ["ABC"], "created_from": "today-7", "columns": ["issuekey"]})
    service = make_service()
    reminder = store.get(1)
    assert reminder["query"]["created_from"] == "today-7"
    for day in (date(2026, 11, 4), date(2026, 11, 5)):
        monkeypatch.setattr(schemas, "_today", lambda d=day: d)
        await service._query(reminder["query"])
    jqls = [c["jql"] for c in service.client.search_calls]
    assert '"2026-10-28"' in jqls[0] and '"2026-10-29"' in jqls[1]
