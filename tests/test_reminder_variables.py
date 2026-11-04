import json
import re
import sqlite3
from datetime import date

import httpx
import respx
from fastapi.testclient import TestClient

from app.cache import TTLCache
from app.main import create_app
from app.message import placeholders, render_line, render_title
from app.reminder_service import ReminderService
from app.reminder_store import ReminderStore
from tests.conftest import SLACK_URL
from tests.fakes import FakeClient

ROW = {"key": "ABC-1", "summary": "Fix\nlogin", "status": "Open", "url": "https://j/ABC-1",
       "cells": {"issuekey": "ABC-1", "assignee": "An Nguyen", "labels": "bug, ui", "customfield_10111": "5"}}


def test_render_line_uses_any_loaded_jira_field():
    assert render_line("{key} {assignee} [{labels}] {customfield_10111}", ROW) == "ABC-1 An Nguyen [bug, ui] 5"
    assert render_line("{issuekey}: {summary}", ROW) == "ABC-1: Fix login"
    assert render_line("{reporter} {nope}", ROW) == "{reporter} {nope}"             # not loaded / unknown: left as written
    assert render_line("{assignee}", {"key": "A-1"}) == "{assignee}"                # row without cells
    assert render_line("{assignee}", {"key": "A-1", "cells": {"assignee": None}}) == ""


def test_builtins_win_over_cells():
    row = {**ROW, "cells": {**ROW["cells"], "status": "from-cells", "summary": "from-cells"}}
    assert render_line("{status} {summary}", row) == "Open Fix login"


def test_placeholders_are_distinct_and_ordered():
    assert placeholders("{a} {b} {a} {c}x") == ["a", "b", "c"]
    assert placeholders("") == [] and placeholders(None) == []


def test_render_title():
    today = date(2026, 11, 4)
    assert render_title(None, "Daily", 12, today) == "Daily (12 issue)"
    assert render_title("  ", "Daily", 3, today) == "Daily (3 issue)"
    assert render_title("{name} - {date}: {count}", "Daily", 3, today) == "Daily - 04/11/2026: 3"
    assert render_title("Báo cáo {unknown} {name}", "X", 1, today) == "Báo cáo {unknown} X"


def make_service(tmp_path, ch_settings, total=2):
    store = ReminderStore(tmp_path / "v.db")
    store.init()
    return ReminderService(store, FakeClient(total=total), TTLCache(), ch_settings, httpx.AsyncClient(), retry_delay=0, run_timeout=5)


async def test_columns_include_only_known_fields_mentioned_in_the_template(tmp_path, ch_settings):
    service = make_service(tmp_path, ch_settings)
    assert await service._columns("{key}: {summary} [{status}] {url}") == ["issuekey", "summary", "status"]
    cols = await service._columns("{assignee} {customfield_10111} {assignee} {not_a_field} {issuekey} {note}")
    assert cols == ["issuekey", "summary", "status", "assignee", "customfield_10111"]
    await service._query({"projects": ["ABC"]}, "{assignee} {labels}")
    assert service.client.search_calls[0]["fields"] == ["summary", "status", "assignee", "labels"]


async def test_message_uses_custom_title_and_fields(tmp_path, ch_settings):
    service = make_service(tmp_path, ch_settings, total=3)
    reminder = {"name": "Daily", "title": "{name} {count}", "template": "{key} <{assignee}>", "max_lines": 2}
    result = await service._query({"projects": ["ABC"]}, reminder["template"])
    text = service.build_text(reminder, result)
    assert text.splitlines()[0] == "Daily 3"
    assert text.splitlines()[1] == "ABC-1 <>"                          # FakeClient issues have no assignee: empty, not literal
    assert text.endswith("… và 1 issue nữa")


BODY = {"name": "Daily", "query": {"projects": ["ABC"], "columns": ["issuekey"]}, "channel": "slack",
        "days": [0], "time": "09:00"}


def client(ch_settings, tmp_path):
    return TestClient(create_app(settings=ch_settings, client=FakeClient(total=2), reminder_db_path=tmp_path / "t.db"))


def test_title_is_saved_and_empty_means_default(ch_settings, tmp_path):
    with client(ch_settings, tmp_path) as c:
        assert c.post("/api/reminders", json=BODY).json()["title"] is None
        got = c.post("/api/reminders", json={**BODY, "title": "  {name} / {date}  "}).json()
        assert got["title"] == "{name} / {date}"
        rid = got["id"]
        assert c.put(f"/api/reminders/{rid}", json={**BODY, "title": ""}).json()["title"] is None
        assert c.post("/api/reminders", json={**BODY, "title": "x" * 201}).status_code == 422


@respx.mock
def test_preview_and_send_test_use_title_and_fields(ch_settings, tmp_path):
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    payload = {"query": BODY["query"], "template": "{key} {assignee}", "title": "Hôm nay {date} có {count}", "name": "N"}
    with client(ch_settings, tmp_path) as c:
        lines = c.post("/api/reminders/preview", json=payload).json()["text"].splitlines()
        assert re.fullmatch(r"Hôm nay \d\d/\d\d/\d{4} có 2", lines[0])
        assert lines[1:] == ["ABC-1", "ABC-2"] or lines[1:] == ["ABC-1 ", "ABC-2 "]        # FakeClient issues have no assignee
        r = c.post("/api/reminders/send-test", json={**payload, "channel": "slack"})
    assert r.json()["status"] == "sent"
    sent = json.loads(route.calls[0].request.content)["text"].splitlines()
    assert re.fullmatch(r"\[Gửi thử\] Hôm nay \d\d/\d\d/\d{4} có 2", sent[0])   # marker is added even to a custom title



def test_migration_adds_title_column(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, enabled INTEGER NOT NULL,
          query_json TEXT NOT NULL, template TEXT NOT NULL, channel TEXT NOT NULL, telegram_chat_id TEXT,
          days_json TEXT NOT NULL, time_hhmm TEXT NOT NULL, condition TEXT NOT NULL, max_lines INTEGER NOT NULL,
          active_since TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          schedule_kind TEXT NOT NULL DEFAULT 'weekly', run_at TEXT);
        CREATE TABLE reminder_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id INTEGER NOT NULL,
          kind TEXT NOT NULL, scheduled_for TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL, row_count INTEGER, error TEXT);
        INSERT INTO reminders VALUES (1,'Old',1,'{"projects":["ABC"]}','{key}','slack',NULL,'[0]','09:00','always',30,
          '2026-11-01T00:00:00','2026-11-01T00:00:00','2026-11-01T00:00:00','weekly',NULL);
    """)
    conn.commit()
    conn.close()
    store = ReminderStore(path)
    store.init()
    store.init()
    assert store.get(1)["title"] is None and store.get(1)["name"] == "Old"
