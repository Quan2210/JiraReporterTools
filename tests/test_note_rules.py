import asyncio
import json
import sqlite3
from datetime import datetime

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.cache import TTLCache
from app.main import create_app
from app.message import render_line
from app.note_rules import arrange, evaluate, field_values, rule_matches
from app.reminder_scheduler import ReminderScheduler
from app.reminder_service import ReminderService, fields_used, prepare
from app.reminder_store import ReminderStore
from tests.conftest import SLACK_URL
from tests.fakes import FakeClient
from tests.test_reminder_service import OLD, reminder_data

ISSUES = [  # key, status, assignee, labels, story points, created
    ("ABC-1", "Done", "An Nguyen", ["bug"], 5, "2026-10-01T09:00:00.000+0700"),
    ("ABC-2", "Open", "Binh Tran", [], 13, "2026-10-03T09:00:00.000+0700"),
    ("ABC-3", "In Review", "An Nguyen", ["ui", "bug"], 8, "2026-10-02T09:00:00.000+0700"),
    ("ABC-4", "Open", None, ["ui"], None, "2026-10-04T09:00:00.000+0700"),
]


def issue(key, status, assignee, labels, points, created):
    return {"key": key, "fields": {
        "summary": f"Task {key}", "status": {"name": status}, "assignee": {"displayName": assignee} if assignee else None,
        "labels": labels, "customfield_10111": points, "created": created}}


class RuleClient(FakeClient):
    async def search(self, jql, fields, start_at, max_results):
        self.search_calls.append({"jql": jql, "fields": fields, "start_at": start_at, "max_results": max_results})
        rows = [issue(*i) for i in ISSUES][start_at:start_at + max_results]
        return {"total": len(ISSUES), "issues": rows}


@pytest.fixture
async def rows(ch_settings):
    """Normalised rows (with assignee/labels/story points/created loaded) as the service sees them."""
    service = make_service(ReminderStore.__new__(ReminderStore), ch_settings)
    result = await service._query({"projects": ["ABC"]}, "", ["assignee", "labels", "customfield_10111", "created"])
    return result["rows"]


def make_service(store, ch_settings, client=None):
    return ReminderService(store, client or RuleClient(), TTLCache(), ch_settings, httpx.AsyncClient(), retry_delay=0, run_timeout=5)


def rule(field="status", op="in", values=("Done",), action="note", text="x"):
    return {"field": field, "op": op, "values": list(values), "action": action, "text": text}


# ---- rule matching -----------------------------------------------------------------------------------------------

async def test_rule_operators(rows):
    by = {r["key"]: r for r in rows}
    assert rule_matches(rule(values=["done"]), by["ABC-1"])                                    # case-insensitive
    assert not rule_matches(rule(values=["Done"]), by["ABC-2"])
    assert rule_matches(rule(op="in", values=["Open", "Done"]), by["ABC-2"])
    assert rule_matches(rule(op="not_in", values=["Done"]), by["ABC-2"])
    assert not rule_matches(rule(op="not_in", values=["Done"]), by["ABC-1"])
    assert rule_matches(rule(field="assignee", op="contains", values=["nguy"]), by["ABC-1"])
    assert rule_matches(rule(field="assignee", op="empty", values=[]), by["ABC-4"])
    assert rule_matches(rule(field="assignee", op="not_empty", values=[]), by["ABC-1"])
    assert rule_matches(rule(field="labels", op="in", values=["ui"]), by["ABC-3"])             # one of several labels
    assert not rule_matches(rule(field="labels", op="in", values=["ui"]), by["ABC-1"])
    assert rule_matches(rule(field="labels", op="empty", values=[]), by["ABC-2"])
    assert not rule_matches(rule(field="not_loaded", op="in", values=["a"]), by["ABC-1"])      # unknown field: no values
    assert rule_matches(rule(field="not_loaded", op="empty", values=[]), by["ABC-1"])
    assert field_values(by["ABC-3"], "labels") == ["ui", "bug"]


async def test_first_matching_rule_wins_and_hide_removes_rows(rows):
    rules = [rule(values=["Done"], action="hide"), rule(values=["Open"], text="Mở: {assignee}"), rule(op="not_empty", field="status", values=[], text="khác")]
    entries, hidden = evaluate(rows, rules, "mặc định", lambda t, r: render_line(t, r))
    assert hidden == 1 and [e.row["key"] for e in entries] == ["ABC-2", "ABC-3", "ABC-4"]
    assert [e.note for e in entries] == ["Mở: Binh Tran", "khác", "Mở: "]            # an empty {assignee} renders empty
    assert entries[2].matched


async def test_default_note_for_rows_without_a_match(rows):
    entries, hidden = evaluate(rows, [rule(values=["Done"], text="xong")], "chưa xong", lambda t, r: t)
    assert hidden == 0
    assert [(e.row["key"], e.note, e.matched) for e in entries] == [
        ("ABC-1", "xong", True), ("ABC-2", "chưa xong", False), ("ABC-3", "chưa xong", False), ("ABC-4", "chưa xong", False)]
    assert [e.note for e in evaluate(rows, [], None, lambda t, r: t)[0]] == ["", "", "", ""]


# ---- grouping and sorting ----------------------------------------------------------------------------------------

async def test_group_and_sort(rows):
    entries, _ = evaluate(rows, [], None, lambda t, r: t)
    names = lambda sections: [(n, [e.row["key"] for e in items]) for n, items in sections]
    assert names(arrange(entries, None, "name", None, "asc")) == [(None, ["ABC-1", "ABC-2", "ABC-3", "ABC-4"])]
    assert names(arrange(entries, "status", "name", None, "asc")) == [
        ("Done", ["ABC-1"]), ("In Review", ["ABC-3"]), ("Open", ["ABC-2", "ABC-4"])]
    assert names(arrange(entries, "status", "count", None, "asc"))[0] == ("Open", ["ABC-2", "ABC-4"])
    by_assignee = names(arrange(entries, "assignee", "name", None, "asc"))
    assert by_assignee[-1] == ("", ["ABC-4"]) and by_assignee[0][0] == "An Nguyen"             # empty group last
    # numbers sort as numbers (13 after 8), empty values last whatever the direction
    assert names(arrange(entries, None, "name", "customfield_10111", "asc"))[0][1] == ["ABC-1", "ABC-3", "ABC-2", "ABC-4"]
    assert names(arrange(entries, None, "name", "customfield_10111", "desc"))[0][1] == ["ABC-2", "ABC-3", "ABC-1", "ABC-4"]
    # dates sort by their ISO value, not the displayed text
    assert names(arrange(entries, None, "name", "created", "desc"))[0][1] == ["ABC-4", "ABC-2", "ABC-3", "ABC-1"]
    assert names(arrange(entries, None, "name", "summary", "desc"))[0][1][0] == "ABC-4"


async def test_fields_used_and_columns_requested(ch_settings, tmp_path):
    reminder = {"template": "{key} {labels} {note}", "note_rules": [rule(field="assignee", op="empty", values=[], text="cho {customfield_10111}")],
                "default_note": "mặc định {created}", "group_by": "status", "sort_by": "fixVersions"}
    assert fields_used(reminder) == ["labels", "assignee", "customfield_10111", "created", "fixVersions"]
    store = ReminderStore(tmp_path / "f.db")
    store.init()
    service = make_service(store, ch_settings)
    await service._fetch({**reminder, "query": {"projects": ["ABC"]}})
    assert service.client.search_calls[0]["fields"] == ["summary", "status", "labels", "assignee", "customfield_10111", "created", "fixVersions"]


# ---- the message ---------------------------------------------------------------------------------------------------

async def build(ch_settings, tmp_path, **options):
    store = ReminderStore(tmp_path / "m.db")
    store.init()
    service = make_service(store, ch_settings)
    reminder = {"name": "R", "template": "{key} ==> {note}", "max_lines": 30, "query": {"projects": ["ABC"]}, **options}
    result = await service._fetch(reminder)
    return service.build_text(reminder, result).splitlines()


async def test_message_with_notes_hiding_and_title_count(ch_settings, tmp_path):
    lines = await build(ch_settings, tmp_path, note_rules=[rule(values=["Done"], text="Done pilot"), rule(values=["Open"], action="hide")],
                        default_note="đang làm")
    assert lines == ["R (2 issue)", "ABC-1 ==> Done pilot", "ABC-3 ==> đang làm"]


async def test_message_groups_with_headers_and_shared_line_limit(ch_settings, tmp_path):
    lines = await build(ch_settings, tmp_path, group_by="status", sort_by="created", sort_dir="desc", max_lines=3)
    assert lines == ["R (4 issue)", "▸ Done (1)", "ABC-1 ==> ", "▸ In Review (1)", "ABC-3 ==> ", "▸ Open (2)", "ABC-4 ==> ",
                     "… và 1 issue nữa"]
    lines = await build(ch_settings, tmp_path, group_by="assignee", max_lines=100)
    assert "▸ (trống) (1)" in lines and lines[1] == "▸ An Nguyen (2)"
    # a group that does not fit at all gets no header
    lines = await build(ch_settings, tmp_path, group_by="status", max_lines=1)
    assert lines == ["R (4 issue)", "▸ Done (1)", "ABC-1 ==> ", "… và 3 issue nữa"]


# ---- send conditions -----------------------------------------------------------------------------------------------

@pytest.fixture
def store(tmp_path):
    s = ReminderStore(tmp_path / "c.db")
    s.init()
    return s


def seed(store, **over):
    rid = store.create(reminder_data(**over))
    with store._conn() as c:
        c.execute("UPDATE reminders SET active_since=? WHERE id=?", (OLD, rid))
    return rid


NOW = datetime(2026, 11, 4, 9, 5)       # Wednesday, after the 09:00 slot


@respx.mock
async def test_min_count_condition(store, ch_settings):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, condition="min_count", min_count=5)
    service = make_service(store, ch_settings)
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    assert route.call_count == 0 and store.list_runs(1)[0]["status"] == "skipped_condition"
    store.update(1, {**reminder_data(condition="min_count", min_count=4)})
    with store._conn() as c:
        c.execute("DELETE FROM reminder_runs"); c.execute("UPDATE reminders SET active_since=?", (OLD,))
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    assert route.call_count == 1 and store.list_runs(1)[0]["status"] == "sent"


@respx.mock
async def test_only_if_results_counts_after_hiding(store, ch_settings):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, condition="only_if_results", note_rules=[rule(op="not_empty", values=[], action="hide")])
    await asyncio.gather(*await ReminderScheduler(make_service(store, ch_settings)).tick(NOW))
    assert route.call_count == 0 and store.list_runs(1)[0]["status"] == "skipped_empty"


@respx.mock
async def test_if_rule_condition(store, ch_settings):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, condition="if_rule", note_rules=[rule(values=["Blocked"], text="x")])
    service = make_service(store, ch_settings)
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    assert route.call_count == 0 and store.list_runs(1)[0]["status"] == "skipped_condition"
    store.update(1, reminder_data(condition="if_rule", note_rules=[rule(values=["Done"], text="x")]))
    with store._conn() as c:
        c.execute("DELETE FROM reminder_runs"); c.execute("UPDATE reminders SET active_since=?", (OLD,))
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    assert route.call_count == 1


@respx.mock
async def test_if_changed_sends_then_skips_until_the_list_changes(store, ch_settings):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, condition="if_changed")
    service = make_service(store, ch_settings)
    sched = ReminderScheduler(service)
    await asyncio.gather(*await sched.tick(NOW))                                         # first time: sends
    await asyncio.gather(*await sched.tick(datetime(2026, 11, 5, 9, 5)))                 # next day, same list: skipped
    runs = store.list_runs(1)
    assert route.call_count == 1 and [r["status"] for r in runs] == ["skipped_unchanged", "sent"]
    assert "không đổi" in runs[0]["error"]
    assert store.get(1)["last_signature"]
    ISSUES.append(("ABC-9", "Open", "An Nguyen", [], 1, "2026-10-05T09:00:00.000+0700"))     # the list changes
    try:
        await asyncio.gather(*await sched.tick(datetime(2026, 11, 6, 9, 5)))
    finally:
        ISSUES.pop()
    assert route.call_count == 2 and store.list_runs(1)[0]["status"] == "sent"


@respx.mock
async def test_status_change_counts_as_a_change_and_manual_send_keeps_the_baseline(store, ch_settings):
    respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    seed(store, condition="if_changed")
    service = make_service(store, ch_settings)
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    baseline = store.get(1)["last_signature"]
    original = ISSUES[1]
    ISSUES[1] = ("ABC-2", "Done", *original[2:])                                          # status changed, same keys
    try:
        run_id = store.begin_manual_run(1)
        assert await service.run(store.get(1), run_id, force_send=True) == "sent"        # manual: bypasses, no baseline update
        assert store.get(1)["last_signature"] == baseline
        result = await service._fetch(store.get(1))
        assert prepare(store.get(1), result).signature != baseline
    finally:
        ISSUES[1] = original


# ---- hand-written one-time message ----------------------------------------------------------------------------------

@respx.mock
async def test_custom_message_is_sent_verbatim_without_querying_jira(store, ch_settings):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    rid = seed(store, schedule_kind="once", run_at="2026-11-04T09:00", days=[], time="09:00",
               custom_message="Chào cả nhà,\nhôm nay họp lúc 10h <!channel>", condition="min_count", min_count=99)
    service = make_service(store, ch_settings)
    await asyncio.gather(*await ReminderScheduler(service).tick(NOW))
    assert service.client.search_calls == []                                          # no Jira call, conditions ignored
    text = json.loads(route.calls[0].request.content)["text"]
    assert text == "Chào cả nhà,\nhôm nay họp lúc 10h &lt;!channel&gt;"             # still escaped for Slack
    assert store.list_runs(rid)[0]["status"] == "sent"


# ---- API -------------------------------------------------------------------------------------------------------------

BODY = {"name": "N", "query": {"projects": ["ABC"], "columns": ["issuekey"]}, "channel": "slack", "days": [0], "time": "09:00"}


def client(ch_settings, tmp_path, fake=None):
    return TestClient(create_app(settings=ch_settings, client=fake or RuleClient(), reminder_db_path=tmp_path / "api.db"))


def test_rule_validation(ch_settings, tmp_path):
    bad = [
        [{"field": "status", "op": "in"}],                                              # needs values
        [{"field": "status", "op": "like", "values": ["a"]}],
        [{"field": "bad id", "op": "in", "values": ["a"]}],
        [{"field": "status", "op": "in", "values": ["a"], "action": "delete"}],
        [{"field": "status", "op": "in", "values": ["a"], "text": "x" * 201}],
        [{"field": "status", "op": "in", "values": ["a"]}] * 21,
        [{"field": "status", "op": "in", "values": ["v"] * 21}],
    ]
    with client(ch_settings, tmp_path) as c:
        for rules in bad:
            assert c.post("/api/reminders", json={**BODY, "note_rules": rules}).status_code == 422, rules[:1]
        for key, value in (("group_by", "bad id"), ("sort_by", "x y"), ("group_order", "random"), ("sort_dir", "up"),
                           ("condition", "sometimes"), ("min_count", 0), ("min_count", 1001), ("default_note", "x" * 201)):
            assert c.post("/api/reminders", json={**BODY, key: value}).status_code == 422, key


def test_rules_and_options_roundtrip_and_normalisation(ch_settings, tmp_path):
    body = {**BODY, "default_note": "  mặc định  ", "group_by": " status ", "group_order": "count", "sort_by": "", "sort_dir": "desc",
            "condition": "min_count", "min_count": 3, "note_rules": [
                {"field": "status", "op": "in", "values": [" Done ", "", "Closed"], "text": "xong"},
                {"field": "assignee", "op": "empty", "values": ["ignored"], "text": "ai đó"},
                {"field": "labels", "op": "contains", "values": ["a", "b"], "action": "hide", "text": "ignored"}]}
    with client(ch_settings, tmp_path) as c:
        got = c.post("/api/reminders", json=body).json()
        assert "last_signature" not in got
        assert (got["default_note"], got["group_by"], got["group_order"], got["sort_by"], got["sort_dir"]) == ("mặc định", "status", "count", None, "desc")
        assert (got["condition"], got["min_count"]) == ("min_count", 3)
        assert got["note_rules"] == [
            {"field": "status", "op": "in", "values": ["Done", "Closed"], "action": "note", "text": "xong"},
            {"field": "assignee", "op": "empty", "values": [], "action": "note", "text": "ai đó"},
            {"field": "labels", "op": "contains", "values": ["a"], "action": "hide", "text": ""}]
        again = c.put(f"/api/reminders/{got['id']}", json={**body, "note_rules": [], "condition": "if_changed"}).json()
        assert again["note_rules"] == [] and again["condition"] == "if_changed"


def test_custom_message_only_for_one_time_reminders(ch_settings, tmp_path):
    when = "2099-01-01T10:00"
    with client(ch_settings, tmp_path) as c:
        weekly = c.post("/api/reminders", json={**BODY, "custom_message": "viết tay"}).json()
        assert weekly["custom_message"] is None
        once_body = {k: v for k, v in BODY.items() if k not in ("days", "time")}
        once = c.post("/api/reminders", json={**once_body, "schedule_kind": "once", "run_at": when, "custom_message": "viết tay"}).json()
        assert once["custom_message"] == "viết tay"
        blank = c.post("/api/reminders", json={**once_body, "schedule_kind": "once", "run_at": when, "custom_message": "  "}).json()
        assert blank["custom_message"] is None
        assert c.post("/api/reminders", json={**once_body, "schedule_kind": "once", "run_at": when, "custom_message": "x" * 20001}).status_code == 422
        # switching to weekly drops it
        back = c.put(f"/api/reminders/{once['id']}", json={**BODY, "custom_message": "viết tay"}).json()
        assert back["custom_message"] is None


@respx.mock
def test_preview_applies_rules_and_reports_the_decision(ch_settings, tmp_path):
    payload = {"query": BODY["query"], "template": "{key} ==> {note}", "title": "T {count}", "name": "N", "max_lines": 10,
               "note_rules": [{"field": "status", "op": "in", "values": ["Done"], "text": "Done pilot"},
                              {"field": "status", "op": "in", "values": ["Open"], "action": "hide"}],
               "group_by": "status", "condition": "min_count", "min_count": 3}
    with client(ch_settings, tmp_path) as c:
        out = c.post("/api/reminders/preview", json=payload).json()
        assert out["text"].splitlines() == ["T 2", "▸ Done (1)", "ABC-1 ==> Done pilot", "▸ In Review (1)", "ABC-3 ==> "]
        assert (out["row_count"], out["hidden"], out["matched"]) == (2, 2, 1)
        assert out["decision"] == {"send": False, "reason": "Chưa đủ điều kiện gửi"}
        ok = c.post("/api/reminders/preview", json={**payload, "min_count": 2}).json()
        assert ok["decision"] == {"send": True, "reason": None}


@respx.mock
def test_send_test_now_uses_rules_or_the_custom_message(ch_settings, tmp_path):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    body = {"name": "N", "query": BODY["query"], "channel": "slack", "template": "{key} {note}",
            "note_rules": [{"field": "status", "op": "in", "values": ["Done"], "text": "OK"}], "condition": "min_count", "min_count": 999}
    fake = RuleClient()
    with client(ch_settings, tmp_path, fake) as c:
        assert c.post("/api/reminders/send-test", json=body).json()["status"] == "sent"      # conditions never block a test
        sent = json.loads(route.calls[0].request.content)["text"].splitlines()
        assert sent[:2] == ["[Gửi thử] N (4 issue)", "ABC-1 OK"]
        searches = len(fake.search_calls)
        c.post("/api/reminders/send-test", json={**body, "custom_message": "chỉ để thử"})
        assert json.loads(route.calls[1].request.content)["text"] == "[Gửi thử] chỉ để thử"
        assert len(fake.search_calls) == searches


def test_migration_adds_all_new_columns(tmp_path):
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
        INSERT INTO reminders VALUES (1,'Old',1,'{"projects":["ABC"]}','{key}','slack',NULL,'[0]','09:00','only_if_results',30,
          '2026-11-01T00:00:00','2026-11-01T00:00:00','2026-11-01T00:00:00');
    """)
    conn.commit()
    conn.close()
    store = ReminderStore(path)
    store.init()
    store.init()
    got = store.get(1)
    assert (got["note_rules"], got["default_note"], got["group_by"], got["group_order"], got["sort_by"], got["sort_dir"],
            got["min_count"], got["custom_message"], got["title"], got["schedule_kind"]) == ([], None, None, "name", None, "asc", 1, None, None, "weekly")
    assert got["condition"] == "only_if_results" and got["name"] == "Old"
