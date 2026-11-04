from datetime import date

import pytest

import app.schemas as schemas
from app.jql import build_jql
from app.schemas import MAX_DATE_OFFSET_DAYS, ReportQuery, query_for_storage, resolve_date_token

TODAY = date(2026, 11, 4)


def test_resolve_tokens():
    assert resolve_date_token("today", TODAY) == TODAY
    assert resolve_date_token("today-7", TODAY) == date(2026, 10, 28)
    assert resolve_date_token("today+3", TODAY) == date(2026, 11, 7)
    assert resolve_date_token("today+0", TODAY) == TODAY
    assert resolve_date_token(" today-1 ", TODAY) == date(2026, 11, 3)


def test_resolve_crosses_month_year_and_leap_day():
    assert resolve_date_token("today-4", date(2026, 3, 2)) == date(2026, 2, 26)
    assert resolve_date_token("today+1", date(2026, 12, 31)) == date(2027, 1, 1)
    assert resolve_date_token("today-1", date(2024, 3, 1)) == date(2024, 2, 29)


def test_offset_limit_is_inclusive():
    assert MAX_DATE_OFFSET_DAYS == 3660
    resolve_date_token("today-3660", TODAY)
    resolve_date_token("today+3660", TODAY)
    for bad in ("today-3661", "today+3661"):
        with pytest.raises(ValueError):
            resolve_date_token(bad, TODAY)


@pytest.mark.parametrize("bad", ["", "now", "today-", "today+x", "today--1", "today 7", "Today", "tomorrow", "today-1d", "2026-13-01"])
def test_bad_tokens(bad):
    with pytest.raises(ValueError):
        resolve_date_token(bad, TODAY)


def test_report_query_resolves_tokens_per_build(monkeypatch):
    raw = {"projects": ["ABC"], "created_from": "today-7", "created_to": "today", "columns": ["issuekey"]}
    monkeypatch.setattr(schemas, "_today", lambda: date(2026, 11, 4))
    q1 = ReportQuery(**raw)
    monkeypatch.setattr(schemas, "_today", lambda: date(2026, 11, 5))
    q2 = ReportQuery(**raw)
    assert (q1.created_from, q1.created_to) == (date(2026, 10, 28), date(2026, 11, 4))
    assert (q2.created_from, q2.created_to) == (date(2026, 10, 29), date(2026, 11, 5))
    assert "2026-10-28" in build_jql(q1) and "2026-10-29" in build_jql(q2)


def test_report_query_still_accepts_plain_dates_and_rejects_bad_tokens():
    assert ReportQuery(created_from="2026-01-02", columns=["a"]).created_from == date(2026, 1, 2)
    with pytest.raises(ValueError):
        ReportQuery(created_from="today-x", columns=["a"])
    with pytest.raises(ValueError):                       # resolved from > to is still caught
        ReportQuery(created_from="today", created_to="today-1", columns=["a"])


def test_query_for_storage_keeps_tokens_and_drops_unknown_keys():
    stored = query_for_storage({"projects": ["ABC"], "created_from": "today-3", "updated_to": "2026-05-01",
                                "junk": "x" * 100, "columns": ["issuekey"]})
    assert stored["created_from"] == "today-3"             # token preserved, resolved again on every run
    assert stored["updated_to"] == "2026-05-01"
    assert "junk" not in stored and stored["projects"] == ["ABC"]
