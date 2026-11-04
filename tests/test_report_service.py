import pytest

from app.cache import TTLCache
from app.jira_client import JiraError, JiraUnavailableError
from app.report_service import InvalidColumnError, run_query
from app.schemas import ReportQuery
from tests.fakes import FakeClient


def query(**kw) -> ReportQuery:
    kw.setdefault("columns", ["issuekey", "summary", "created"])
    return ReportQuery(**kw)


async def test_single_page(settings):
    client = FakeClient(total=3)
    result = await run_query(query(projects=["ABC"]), client, TTLCache(), settings)
    assert result["total"] == 3 and not result["truncated"]
    assert [r["key"] for r in result["rows"]] == ["ABC-1", "ABC-2", "ABC-3"]
    first = result["rows"][0]
    assert first["cells"]["created"] == "01/05/2024 10:15"
    assert first["raw"]["created"] == "2024-05-01T10:15"
    assert first["url"] == "https://jira.test/browse/ABC-1"
    assert first["summary"] == "Task 1" and first["status"] == "Done"
    assert [c["name"] for c in result["columns"]] == ["Key", "Summary", "Created"]
    assert [c["type"] for c in result["columns"]] == ["string", "string", "datetime"]
    assert result["jql"].startswith('project in ("ABC")')


async def test_always_requests_summary_and_status_without_duplicates(settings):
    client = FakeClient(total=1)
    await run_query(query(columns=["issuekey", "status"]), client, TTLCache(), settings)
    assert client.search_calls[0]["fields"] == ["status", "summary"]
    client2 = FakeClient(total=1)
    await run_query(query(columns=["summary", "status"]), client2, TTLCache(), settings)
    assert client2.search_calls[0]["fields"] == ["summary", "status"]


async def test_paginates_across_pages(settings):
    client = FakeClient(total=230)
    result = await run_query(query(max_rows=250), client, TTLCache(), settings)
    assert len(result["rows"]) == 230 and not result["truncated"]
    assert [c["start_at"] for c in client.search_calls] == [0, 100, 200]
    assert len({r["key"] for r in result["rows"]}) == 230   # no duplicates between pages


async def test_truncated_when_over_max_rows(settings):
    client = FakeClient(total=1000)
    result = await run_query(query(), client, TTLCache(), settings)   # settings.max_rows == 250
    assert len(result["rows"]) == 250
    assert result["total"] == 1000 and result["truncated"]
    assert client.search_calls[-1]["max_results"] == 50   # last page trimmed to remaining budget


async def test_client_max_rows_cannot_exceed_server_cap(settings):
    client = FakeClient(total=1000)
    result = await run_query(query(max_rows=999999), client, TTLCache(), settings)
    assert len(result["rows"]) == settings.max_rows


async def test_empty_result(settings):
    result = await run_query(query(), FakeClient(total=0), TTLCache(), settings)
    assert result["rows"] == [] and not result["truncated"]


async def test_error_midway_raises_instead_of_partial_data(settings):
    client = FakeClient(total=230, fail_on_call=2)
    with pytest.raises(JiraUnavailableError):
        await run_query(query(), client, TTLCache(), settings)


async def test_unknown_column_rejected_before_calling_search(settings):
    client = FakeClient(total=5)
    with pytest.raises(InvalidColumnError):
        await run_query(query(columns=["summary", "nope"]), client, TTLCache(), settings)
    assert client.search_calls == []


async def test_sprint_and_labels_columns_with_atoms(settings):
    client = FakeClient(total=1)

    async def search(jql, fields, start_at, max_results):
        return {"total": 1, "issues": [{"key": "A-1", "fields": {
            "labels": ["x", "y"],
            "customfield_10020": ["x.Sprint@1[id=7,state=ACTIVE,name=Sprint 7,goal=]"]}}]}

    client.search = search
    result = await run_query(query(columns=["labels", "customfield_10020"]), client, TTLCache(), settings)
    row = result["rows"][0]
    assert row["cells"] == {"labels": "x, y", "customfield_10020": "Sprint 7"}
    assert row["atoms"] == {"labels": ["x", "y"], "customfield_10020": ["Sprint 7"]}


async def test_custom_filter_uses_field_metadata(settings):
    client = FakeClient(total=0)
    q = query(custom_filters=[{"field_id": "customfield_10111", "operator": "gte", "values": ["5"]}])
    result = await run_query(q, client, TTLCache(), settings)
    assert "cf[10111] >= 5" in result["jql"]


async def test_jql_mode_is_sent_verbatim(settings):
    client = FakeClient(total=0)
    await run_query(query(jql="assignee = currentUser()", projects=["ABC"]), client, TTLCache(), settings)
    assert client.search_calls[0]["jql"] == "assignee = currentUser()"


def _comment_client(total_issues, *, fail_for=None):
    client = FakeClient(total=total_issues)

    async def search(jql, fields, start_at, max_results):
        issues = [{"key": f"A-{i}", "fields": {"comment": {"total": 3, "comments": [
            {"author": {"displayName": "Old"}, "created": "2024-01-01T00:00:00.000+0000", "body": "stale"}]}}}
            for i in range(1, total_issues + 1)]
        return {"total": total_issues, "issues": issues}

    client.search = search
    if fail_for:
        async def latest(key):
            if key == fail_for:
                raise JiraUnavailableError("boom")
            return {"author": {"displayName": "Zed"}, "created": "2024-06-01T09:00:00.000+0700", "body": f"new {key}"}
        client.latest_comment = latest
    return client


async def test_truncated_comment_page_uses_per_issue_fallback(settings):
    result = await run_query(query(columns=["comment"]), _comment_client(2), TTLCache(), settings)
    assert result["rows"][0]["cells"]["comment"] == "Zed (01/06/2024 09:00): newest for A-1"
    assert result["rows"][1]["cells"]["comment"] == "Zed (01/06/2024 09:00): newest for A-2"


async def test_comment_fallback_failure_keeps_payload_value(settings):
    result = await run_query(query(columns=["comment"]), _comment_client(2, fail_for="A-1"), TTLCache(), settings)
    assert result["rows"][0]["cells"]["comment"] == "Old (01/01/2024 00:00): stale"
    assert result["rows"][1]["cells"]["comment"].endswith("new A-2")


async def test_no_fallback_when_comments_complete(settings):
    client = FakeClient(total=1)
    calls = []

    async def latest(key):
        calls.append(key)

    async def search(jql, fields, start_at, max_results):
        return {"total": 1, "issues": [{"key": "A-1", "fields": {"comment": {"total": 1, "comments": [
            {"author": {"displayName": "A"}, "created": "2024-01-01T00:00:00.000+0000", "body": "only"}]}}}]}

    client.latest_comment, client.search = latest, search
    result = await run_query(query(columns=["comment"]), client, TTLCache(), settings)
    assert calls == [] and result["rows"][0]["cells"]["comment"].endswith("only")
    assert issubclass(JiraUnavailableError, JiraError)
