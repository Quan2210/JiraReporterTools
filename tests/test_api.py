import csv
import io

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.jira_client import JiraAuthError, JiraForbiddenError
from app.main import create_app
from tests.fakes import FakeClient

BODY = {"projects": ["ABC"], "columns": ["issuekey", "summary"]}
TABLE = {"headers": ["STT", "Key", "Ghi chú"], "rows": [["1", "ABC-1", "ok"], ["2", "ABC-2", ""]]}


@pytest.fixture
def make_client(settings):
    def _make(fake=None):
        app = create_app(settings=settings, client=fake or FakeClient(total=3))
        return TestClient(app)
    return _make


def test_health_ok(make_client):
    with make_client() as c:
        r = c.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "user": "Me", "jira_base_url": "https://jira.test", "max_rows": 250}


def test_health_bad_pat_returns_401(make_client):
    fake = FakeClient()

    async def myself():
        raise JiraAuthError()

    fake.myself = myself
    with make_client(fake) as c:
        r = c.get("/api/health")
    assert r.status_code == 401 and "PAT" in r.json()["detail"]


def test_meta_endpoints(make_client):
    with make_client() as c:
        assert c.get("/api/meta/projects").json() == [{"key": "ABC", "name": "Alpha"}]
        assert c.get("/api/meta/statuses").json() == [
            {"name": "Done", "category": "done"}, {"name": "Open", "category": "new"}]
        assert c.get("/api/meta/issuetypes").json() == ["Bug"]
        assert c.get("/api/meta/labels?q=b").json() == ["bug"]
        assert c.get("/api/meta/users?q=al").json() == [{"username": "alice", "displayName": "Alice"}]
        assert c.get("/api/meta/groups?q=b").json() == ["backend", "frontend"]
        assert c.get("/api/meta/sprints?project=ABC").json()[0]["id"] == 7


def test_meta_fields_have_type_and_searchable(make_client):
    with make_client() as c:
        fields = {f["id"]: f for f in c.get("/api/meta/fields").json()}
    assert fields["customfield_10111"]["type"] == "number" and fields["customfield_10111"]["searchable"]
    assert fields["customfield_10020"]["type"] == "sprint"
    assert fields["issuekey"]["searchable"] is False


def test_suggest_uses_clause_from_metadata(make_client):
    with make_client() as c:
        assert c.get("/api/meta/suggest", params={"field": "customfield_10111", "q": "x"}).json() == ["cf[10111]-value"]
        assert c.get("/api/meta/suggest", params={"field": "labels"}).json() == ["labels-value"]
        assert c.get("/api/meta/suggest", params={"field": "nope"}).status_code == 404
        assert c.get("/api/meta/suggest", params={"field": 'a"b'}).status_code == 422


def test_suggest_failure_degrades_to_empty_list(make_client):
    fake = FakeClient()

    async def boom(clause, q):
        raise JiraForbiddenError()

    fake.suggest = boom
    with make_client(fake) as c:
        assert c.get("/api/meta/suggest", params={"field": "labels"}).json() == []


def test_groups_permission_error_is_reported(make_client):
    fake = FakeClient()

    async def boom(q):
        raise JiraForbiddenError()

    fake.groups = boom
    with make_client(fake) as c:
        r = c.get("/api/meta/groups?q=a")
    assert r.status_code == 403


def test_sprints_rejects_bad_project_key(make_client):
    with make_client() as c:
        assert c.get("/api/meta/sprints", params={"project": 'A"B'}).status_code == 422


def test_query_returns_rows_and_jql(make_client):
    with make_client() as c:
        r = c.post("/api/report/query", json=BODY)
    data = r.json()
    assert r.status_code == 200
    assert len(data["rows"]) == 3 and data["total"] == 3 and data["truncated"] is False
    assert data["rows"][0]["url"] == "https://jira.test/browse/ABC-1"
    assert "project in" in data["jql"]


def test_query_validation_errors_return_422(make_client):
    with make_client() as c:
        assert c.post("/api/report/query", json={"columns": []}).status_code == 422
        assert c.post("/api/report/query", json={**BODY, "sprints": ["x"]}).status_code == 422
        r = c.post("/api/report/query", json={"columns": ["summary", "bogus"]})
        assert r.status_code == 422 and "bogus" in r.json()["detail"]
        r = c.post("/api/report/query", json={**BODY, "custom_filters": [
            {"field_id": "customfield_10111", "operator": "gte", "values": ["abc"]}]})
        assert r.status_code == 422 and "số" in r.json()["detail"]


def test_jql_parse_endpoint(make_client):
    with make_client() as c:
        r = c.post("/api/jql/parse", json={"jql": 'project = ABC AND labels in ("bug") AND foo = 1 ORDER BY created'})
        assert r.status_code == 200
        data = r.json()
        assert data["filters"]["projects"] == ["ABC"] and data["filters"]["labels"] == ["bug"]
        assert data["unsupported"] == ["foo = 1"] and data["exact"] is False
        assert c.post("/api/jql/parse", json={"jql": ""}).status_code == 422


def test_export_csv_from_client_table(make_client):
    fake = FakeClient()
    with make_client(fake) as c:
        r = c.post("/api/export?format=csv", json=TABLE)
    assert r.status_code == 200 and ".csv" in r.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert rows == [["STT", "Key", "Ghi chú"], ["1", "ABC-1", "ok"], ["2", "ABC-2", ""]]
    assert fake.search_calls == []          # export never goes back to Jira


def test_export_xlsx_with_fills(make_client):
    body = {**TABLE, "fills": [["#FFF2CC", "#FFF2CC", "#FFF2CC"], [None, None, None]]}
    with make_client() as c:
        r = c.post("/api/export?format=xlsx", json=body)
    assert r.status_code == 200 and ".xlsx" in r.headers["content-disposition"]
    ws = load_workbook(io.BytesIO(r.content)).active
    assert ws.max_row == 3 and ws["B2"].value == "ABC-1"
    assert ws["B2"].fill.start_color.rgb.endswith("FFF2CC")
    assert ws["B3"].fill.fill_type is None


@pytest.mark.parametrize("bad", [
    {"headers": ["a"], "rows": [["1", "2"]]},                                   # ragged row
    {"headers": [], "rows": []},                                                 # no columns
    {"headers": ["a"], "rows": [["1"]], "fills": [["#GGGGGG"]]},                 # bad colour
    {"headers": ["a"], "rows": [["1"]], "fills": [["#FFFFFF"], ["#FFFFFF"]]},    # wrong shape
    {"headers": ["a"], "rows": [["1"]], "fills": [["red"]]},
])
def test_export_rejects_malformed_tables(make_client, bad):
    with make_client() as c:
        assert c.post("/api/export?format=xlsx", json=bad).status_code == 422


def test_export_row_limit_and_unknown_format(make_client, settings):
    with make_client() as c:
        too_many = {"headers": ["a"], "rows": [["x"]] * (settings.max_rows + 1)}
        assert c.post("/api/export?format=csv", json=too_many).status_code == 422
        assert c.post("/api/export?format=pdf", json=TABLE).status_code == 422


def test_export_truncates_oversized_cells(make_client):
    with make_client() as c:
        r = c.post("/api/export?format=csv", json={"headers": ["a"], "rows": [["x" * 40000]]})
    cell = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))[1][0]
    assert len(cell) == 32000


def test_old_export_route_is_gone(make_client):
    with make_client() as c:
        assert c.post("/api/report/export?format=csv", json=BODY).status_code in (404, 405)


def test_search_failure_returns_502_not_crash(make_client):
    with make_client(FakeClient(total=230, fail_on_call=1)) as c:
        r = c.post("/api/report/query", json=BODY)
    assert r.status_code == 502 and "Jira" in r.json()["detail"]


def test_frontend_is_served(make_client):
    with make_client() as c:
        r = c.get("/")
    assert r.status_code == 200 and "Jira Report" in r.text


def test_jql_build_endpoint(make_client):
    body = {**BODY, "assignee_groups": ["backend"], "labels": ["bug"]}
    with make_client() as c:
        r = c.post("/api/jql/build", json=body)
        assert r.status_code == 200
        assert r.json()["jql"] == 'project in ("ABC") AND labels in ("bug") AND assignee in membersOf("backend") ORDER BY created DESC'
        bad = c.post("/api/jql/build", json={**BODY, "custom_filters": [
            {"field_id": "nope", "operator": "eq", "values": ["x"]}]})
        assert bad.status_code == 422
