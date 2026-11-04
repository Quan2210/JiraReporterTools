import logging
from pathlib import Path

import httpx
import respx
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import FAKE_PAT, SLACK_URL, TG_TOKEN
from tests.fakes import FakeClient

ROOT = Path(__file__).resolve().parent.parent
BODY = {"name": "Daily", "query": {"projects": ["ABC"], "columns": ["issuekey"]}, "channel": "slack",
        "days": [4, 0, 0], "time": "09:00"}


def make(ch_settings, tmp_path, fake=None, **kw):
    return TestClient(create_app(settings=ch_settings, client=fake or FakeClient(total=3),
                                 reminder_db_path=tmp_path / "api.db", **kw))


def test_crud_roundtrip(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        r = c.post("/api/reminders", json=BODY)
        assert r.status_code == 201
        created = r.json()
        assert created["days"] == [0, 4] and created["template"].startswith("{key}") and created["enabled"] is True
        assert c.get("/api/reminders").json()["reminders"][0]["name"] == "Daily"
        r = c.put(f"/api/reminders/{created['id']}", json={**BODY, "name": "Renamed", "time": "10:30"})
        assert r.json()["name"] == "Renamed" and r.json()["time"] == "10:30"
        assert c.delete(f"/api/reminders/{created['id']}").status_code == 204
        assert c.get("/api/reminders").json()["reminders"] == []
        assert c.delete("/api/reminders/99").status_code == 404
        assert c.put("/api/reminders/99", json=BODY).status_code == 404


def test_validation(ch_settings, tmp_path):
    bad = [
        {"time": "9:00"}, {"time": "24:00"}, {"days": []}, {"days": [7]}, {"name": "  "}, {"name": "x" * 101},
        {"max_lines": 0}, {"max_lines": 101}, {"template": ""}, {"channel": "email"},
        {"channel": "telegram"}, {"channel": "telegram", "telegram_chat_id": "abc"},
    ]
    with make(ch_settings, tmp_path) as c:
        for override in bad:
            assert c.post("/api/reminders", json={**BODY, **override}).status_code == 422, override


def test_unconfigured_channel_cannot_be_enabled(settings, tmp_path):
    with make(settings, tmp_path) as c:          # `settings` has no Slack/Telegram secrets
        assert c.get("/api/channels").json() == {"slack": {"configured": False}, "telegram": {"configured": False}}
        assert c.post("/api/reminders", json=BODY).status_code == 422
        assert c.post("/api/reminders", json={**BODY, "enabled": False}).status_code == 201


def test_channels_status_never_exposes_secrets(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        r = c.get("/api/channels")
    assert r.json() == {"slack": {"configured": True}, "telegram": {"configured": True}}
    assert "SECRETSLACKPART" not in r.text and TG_TOKEN not in r.text


@respx.mock
def test_preview_does_not_send(ch_settings, tmp_path):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    with make(ch_settings, tmp_path) as c:
        r = c.post("/api/reminders/preview", json={"query": {"projects": ["ABC"], "columns": ["issuekey"]}, "template": "{key}"})
    assert r.status_code == 200 and "ABC-1" in r.json()["text"] and r.json()["row_count"] == 3
    assert route.call_count == 0


@respx.mock
def test_send_test_twice_and_history(ch_settings, tmp_path):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    with make(ch_settings, tmp_path) as c:
        rid = c.post("/api/reminders", json={**BODY, "condition": "only_if_results"}).json()["id"]
        assert c.post(f"/api/reminders/{rid}/test").json()["status"] == "sent"
        assert c.post(f"/api/reminders/{rid}/test").json()["status"] == "sent"
        runs = c.get(f"/api/reminders/{rid}/runs").json()["runs"]
        assert c.post("/api/reminders/99/test").status_code == 404
    assert route.call_count == 2 and [r["kind"] for r in runs] == ["manual", "manual"]


@respx.mock
def test_send_test_reports_channel_failure_without_secrets(ch_settings, tmp_path):
    respx.post(SLACK_URL).mock(return_value=httpx.Response(404, text=SLACK_URL))
    with make(ch_settings, tmp_path) as c:
        rid = c.post("/api/reminders", json=BODY).json()["id"]
        r = c.post(f"/api/reminders/{rid}/test")
    assert r.json()["status"] == "failed" and "404" in r.json()["error"] and "SECRETSLACKPART" not in r.text


@respx.mock
def test_telegram_chat_discovery_endpoint(ch_settings, tmp_path):
    respx.post(f"https://api.telegram.org/bot{TG_TOKEN}/getUpdates").mock(return_value=httpx.Response(
        200, json={"ok": True, "result": [{"message": {"chat": {"id": 7, "type": "private", "first_name": "An"}}}]}))
    with make(ch_settings, tmp_path) as c:
        r = c.post("/api/channels/telegram/chats")
    assert r.json()["chats"] == [{"id": "7", "title": "An", "type": "private"}]
    assert TG_TOKEN not in r.text


@respx.mock
def test_secrets_never_in_logs_or_db(ch_settings, tmp_path, caplog):
    respx.post(SLACK_URL).mock(return_value=httpx.Response(500, text="boom"))
    respx.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage").mock(return_value=httpx.Response(500))
    with caplog.at_level(logging.DEBUG), make(ch_settings, tmp_path) as c:
        for body in (BODY, {**BODY, "channel": "telegram", "telegram_chat_id": "5"}):
            rid = c.post("/api/reminders", json=body).json()["id"]
            c.post(f"/api/reminders/{rid}/test")
    haystack = caplog.text + (tmp_path / "api.db").read_bytes().decode("latin-1")
    for secret in ("SECRETSLACKPART", TG_TOKEN, FAKE_PAT):
        assert secret not in haystack


@respx.mock
def test_jira_pat_is_never_sent_to_channels(ch_settings, tmp_path):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    with make(ch_settings, tmp_path) as c:
        rid = c.post("/api/reminders", json=BODY).json()["id"]
        c.post(f"/api/reminders/{rid}/test")
    assert "authorization" not in route.calls[0].request.headers


# ---- local-only guard -------------------------------------------------------

def test_foreign_host_and_origin_are_rejected(ch_settings, tmp_path):
    from app.main import DEFAULT_ALLOWED_HOSTS
    hosts = DEFAULT_ALLOWED_HOSTS
    with make(ch_settings, tmp_path, allowed_hosts=hosts) as c:
        assert c.get("/api/reminders", headers={"Host": "evil.example"}).status_code == 403          # DNS rebinding
        assert c.get("/api/reminders", headers={"Host": "127.0.0.1:8000"}).status_code == 200        # any port
        assert c.get("/api/reminders", headers={"Host": "localhost:9999"}).status_code == 200
        assert c.get("/api/reminders", headers={"Host": "[::1]:8000"}).status_code == 200
        post = lambda origin: c.post("/api/reminders", json={**BODY, "enabled": False},
                                     headers={"Host": "127.0.0.1:8000", **({"Origin": origin} if origin else {})})
        assert post("http://evil.example").status_code == 403
        assert post("null").status_code == 403
        assert post("http://localhost:8000").status_code == 403           # other local origin is still cross-origin
        assert post("http://127.0.0.1:8000").status_code == 201           # the app's own page
        assert post(None).status_code == 201                              # curl-like, no Origin
        assert c.get("/", headers={"Host": "evil.example"}).status_code == 200     # static page is not guarded


def test_main_app_enables_scheduler_and_tests_do_not_touch_repo_data(ch_settings):
    source = (ROOT / "app" / "main.py").read_text(encoding="utf-8")
    assert "app = create_app(scheduler=True)" in source
    real_db = ROOT / "data" / "reminders.db"          # may exist if the user runs the real app on this checkout
    before = (real_db.stat().st_mtime_ns, real_db.stat().st_size) if real_db.exists() else None
    with TestClient(create_app(settings=ch_settings, client=FakeClient(total=1))) as c:      # default db path
        c.post("/api/reminders", json={**BODY, "enabled": False})
    after = (real_db.stat().st_mtime_ns, real_db.stat().st_size) if real_db.exists() else None
    assert after == before


def test_scheduler_runs_only_when_enabled(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        assert c.app.state.reminder_scheduler is not None
    with make(ch_settings, tmp_path, scheduler=True) as c:
        assert c.get("/api/channels").status_code == 200


# ---- one-time reminders, send-test, stored queries ---------------------------

from datetime import datetime, timedelta     # noqa: E402


def _when(**delta):
    return (datetime.now() + timedelta(**delta)).strftime("%Y-%m-%dT%H:%M")


ONCE = {**BODY, "schedule_kind": "once"}
ONCE.pop("days"), ONCE.pop("time")


def test_once_create_validation_and_derived_fields(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        assert c.post("/api/reminders", json={**ONCE, "run_at": _when(hours=-1)}).status_code == 422       # past
        for bad in (None, "", "2026-13-01T10:00", "2026-11-05 10:00", "2026-11-05T25:00"):
            assert c.post("/api/reminders", json={**ONCE, "run_at": bad}).status_code == 422, bad
        r = c.post("/api/reminders", json={**ONCE, "run_at": _when(hours=2), "days": [1, 2]})
        assert r.status_code == 201
        got = r.json()
        assert got["schedule_kind"] == "once" and got["days"] == [] and got["state"] == "active"
        assert got["time"] == got["run_at"][11:] and got["next_run"].startswith(got["run_at"])
        # a weekly body still needs days and time
        assert c.post("/api/reminders", json={**BODY, "days": []}).status_code == 422
        assert c.post("/api/reminders", json={**BODY, "time": None}).status_code == 422


def test_once_update_rules(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        rid = c.post("/api/reminders", json={**ONCE, "run_at": _when(hours=2)}).json()["id"]
        past = {**ONCE, "run_at": _when(hours=-1)}
        assert c.put(f"/api/reminders/{rid}", json=past).status_code == 422                 # moved into the past
        assert c.put(f"/api/reminders/{rid}", json={**ONCE, "run_at": _when(hours=3), "name": "x"}).status_code == 200
        # make it "done"-like: off with a past time. Renaming it is fine, turning it on is not.
        with c.app.state.reminders.store._conn() as conn:
            conn.execute("UPDATE reminders SET run_at=?, enabled=0 WHERE id=?", (_when(hours=-5), rid))
        stale = {**ONCE, "run_at": _when(hours=-5), "name": "renamed"}
        assert c.put(f"/api/reminders/{rid}", json={**stale, "enabled": False}).status_code == 200
        r = c.put(f"/api/reminders/{rid}", json={**stale, "enabled": True})
        assert r.status_code == 422 and "đã qua" in r.json()["detail"]
        assert c.put(f"/api/reminders/{rid}", json={**ONCE, "run_at": _when(hours=4), "enabled": True}).status_code == 200


def test_weekly_response_has_state_and_next_run(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        created = c.post("/api/reminders", json=BODY).json()
        listed = c.get("/api/reminders").json()["reminders"][0]
    assert created["state"] == "active" and created["next_run"] and created["schedule_kind"] == "weekly"
    assert listed["next_run"] == created["next_run"]


def test_query_is_sanitised_and_tokens_survive(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        body = {**BODY, "query": {"projects": ["ABC"], "columns": ["issuekey"], "junk": "x", "created_from": "today-7"}}
        got = c.post("/api/reminders", json=body).json()
        assert got["query"]["created_from"] == "today-7" and "junk" not in got["query"]
        assert c.post("/api/reminders", json={**BODY, "query": {"created_from": "today-x", "columns": ["a"]}}).status_code == 422
        assert c.post("/api/reminders", json={**BODY, "query": {"created_from": "today-3661", "columns": ["a"]}}).status_code == 422
        big = {"projects": ["ABC"], "columns": ["issuekey"], "jql": "x" * 4000}
        assert c.post("/api/reminders", json={**BODY, "query": {**big, "labels": ["l" * 200] * 400}}).status_code == 422


SEND = {"name": "Try", "query": {"projects": ["ABC"], "columns": ["issuekey"]}, "channel": "slack", "template": "{key}"}


@respx.mock
def test_send_test_now_sends_without_history(ch_settings, tmp_path):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    with make(ch_settings, tmp_path) as c:
        r = c.post("/api/reminders/send-test", json=SEND)
        assert c.get("/api/reminders").json()["reminders"] == []
    assert r.status_code == 200 and r.json() == {"status": "sent", "row_count": 3, "error": None}
    assert route.call_count == 1 and "[Gửi thử] Try".encode() in route.calls[0].request.content


@respx.mock
def test_send_test_now_validates_like_a_reminder(ch_settings, settings, tmp_path):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    with make(ch_settings, tmp_path) as c:
        for bad in ({"channel": "telegram", "telegram_chat_id": "abc"}, {"channel": "telegram"}, {"max_lines": 101},
                    {"template": ""}, {"name": " "}, {"channel": "email"},
                    {"query": {"created_from": "today-9999", "columns": ["a"]}}):
            assert c.post("/api/reminders/send-test", json={**SEND, **bad}).status_code == 422, bad
    with make(settings, tmp_path) as c:                                  # no channel configured
        assert c.post("/api/reminders/send-test", json=SEND).status_code == 422
    assert route.call_count == 0


@respx.mock
def test_send_test_now_failures_are_reported_without_secrets(ch_settings, tmp_path):
    respx.post(SLACK_URL).mock(return_value=httpx.Response(500, text=SLACK_URL))
    with make(ch_settings, tmp_path) as c:
        r = c.post("/api/reminders/send-test", json=SEND)
        jira_down = FakeClient(total=1)
        jira_down.fail_on_call = 1
    assert r.json()["status"] == "failed" and "500" in r.json()["error"] and "SECRETSLACKPART" not in r.text
    with make(ch_settings, tmp_path, fake=jira_down) as c:
        r = c.post("/api/reminders/send-test", json=SEND)
    assert r.json()["status"] == "failed" and r.json()["error"]


@respx.mock
def test_send_test_now_times_out(ch_settings, tmp_path):
    import asyncio

    class Slow(FakeClient):
        async def search(self, *a, **k):
            await asyncio.sleep(5)

    respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    with make(ch_settings, tmp_path, fake=Slow(total=1)) as c:
        c.app.state.reminders.run_timeout = 0.2
        r = c.post("/api/reminders/send-test", json=SEND)
    assert r.json() == {"status": "failed", "row_count": None, "error": "Quá thời gian chờ"}


def test_send_test_now_does_not_log_pat_or_secrets(ch_settings, tmp_path, caplog):
    with respx.mock:
        respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
        with caplog.at_level(logging.DEBUG), make(ch_settings, tmp_path) as c:
            c.post("/api/reminders/send-test", json=SEND)
    assert "SECRETSLACKPART" not in caplog.text and FAKE_PAT not in caplog.text


def test_static_files_are_always_revalidated(ch_settings, tmp_path):
    with make(ch_settings, tmp_path) as c:
        assert c.get("/js/main.js").headers["cache-control"] == "no-cache"
        assert c.get("/").headers["cache-control"] == "no-cache"
        assert "cache-control" not in c.get("/api/channels").headers
