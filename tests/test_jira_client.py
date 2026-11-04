import httpx
import pytest
import respx

from app import jira_client
from app.jira_client import (
    JiraAuthError, JiraBadRequestError, JiraClient, JiraForbiddenError, JiraUnavailableError,
)
from tests.conftest import BASE, FAKE_PAT


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    async def fake_sleep(_):
        return None
    monkeypatch.setattr(jira_client.asyncio, "sleep", fake_sleep)


@pytest.fixture
async def client(settings):
    c = JiraClient(settings)
    yield c
    await c.aclose()


@respx.mock
async def test_sends_bearer_and_json_accept(client):
    route = respx.get(f"{BASE}/rest/api/2/myself").mock(return_value=httpx.Response(200, json={"name": "me"}))
    assert (await client.myself())["name"] == "me"
    req = route.calls.last.request
    assert req.headers["Authorization"] == f"Bearer {FAKE_PAT}"
    assert req.headers["Accept"] == "application/json"


@respx.mock
@pytest.mark.parametrize("status,exc", [(401, JiraAuthError), (403, JiraForbiddenError), (400, JiraBadRequestError)])
async def test_error_mapping_without_retry(client, status, exc):
    route = respx.get(f"{BASE}/rest/api/2/myself").mock(
        return_value=httpx.Response(status, json={"errorMessages": ["bad jql"]})
    )
    with pytest.raises(exc):
        await client.myself()
    assert route.call_count == 1


@respx.mock
async def test_bad_request_carries_jira_message(client):
    respx.post(f"{BASE}/rest/api/2/search").mock(
        return_value=httpx.Response(400, json={"errorMessages": ["Field 'x' does not exist"]})
    )
    with pytest.raises(JiraBadRequestError) as info:
        await client.search("x = 1", ["summary"], 0, 10)
    assert "Field 'x' does not exist" in str(info.value)


@respx.mock
async def test_retries_5xx_then_succeeds(client):
    route = respx.get(f"{BASE}/rest/api/2/myself").mock(
        side_effect=[httpx.Response(503), httpx.Response(200, json={"name": "me"})]
    )
    assert (await client.myself())["name"] == "me"
    assert route.call_count == 2


@respx.mock
async def test_gives_up_after_retries(client):
    route = respx.get(f"{BASE}/rest/api/2/myself").mock(return_value=httpx.Response(500))
    with pytest.raises(JiraUnavailableError):
        await client.myself()
    assert route.call_count == 1 + jira_client.MAX_RETRIES


@respx.mock
async def test_timeout_becomes_unavailable(client):
    respx.get(f"{BASE}/rest/api/2/myself").mock(side_effect=httpx.ConnectTimeout("boom"))
    with pytest.raises(JiraUnavailableError):
        await client.myself()


@respx.mock
async def test_error_text_never_contains_pat(client):
    respx.get(f"{BASE}/rest/api/2/myself").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(JiraUnavailableError) as info:
        await client.myself()
    assert FAKE_PAT not in str(info.value)


@respx.mock
async def test_429_honours_retry_after_then_succeeds(client):
    route = respx.get(f"{BASE}/rest/api/2/myself").mock(
        side_effect=[httpx.Response(429, headers={"Retry-After": "2"}), httpx.Response(200, json={})]
    )
    await client.myself()
    assert route.call_count == 2


@respx.mock
async def test_labels_primary_endpoint(client):
    respx.get(f"{BASE}/rest/api/1.0/labels/suggest").mock(
        return_value=httpx.Response(200, json={"suggestions": [{"label": "bug"}, {"label": "backend"}]})
    )
    assert await client.labels("b") == ["bug", "backend"]


@respx.mock
async def test_labels_falls_back_when_primary_returns_xml(client):
    respx.get(f"{BASE}/rest/api/1.0/labels/suggest").mock(
        return_value=httpx.Response(200, text="<xml/>", headers={"Content-Type": "application/xml"})
    )
    respx.get(f"{BASE}/rest/api/2/jql/autocompletedata/suggestions").mock(
        return_value=httpx.Response(200, json={"results": [{"value": "bug"}]})
    )
    assert await client.labels("b") == ["bug"]


@respx.mock
async def test_labels_falls_back_on_404(client):
    respx.get(f"{BASE}/rest/api/1.0/labels/suggest").mock(return_value=httpx.Response(404))
    respx.get(f"{BASE}/rest/api/2/jql/autocompletedata/suggestions").mock(
        return_value=httpx.Response(200, json={"results": [{"value": "x"}]})
    )
    assert await client.labels("x") == ["x"]


@respx.mock
async def test_sprints_paginate_and_tolerate_kanban(client):
    respx.get(f"{BASE}/rest/agile/1.0/board/1/sprint").mock(side_effect=[
        httpx.Response(200, json={"values": [{"id": 1}, {"id": 2}], "isLast": False}),
        httpx.Response(200, json={"values": [{"id": 3}], "isLast": True}),
    ])
    assert [s["id"] for s in await client.sprints(1)] == [1, 2, 3]
    respx.get(f"{BASE}/rest/agile/1.0/board/2/sprint").mock(
        return_value=httpx.Response(400, json={"errorMessages": ["board does not support sprints"]})
    )
    assert await client.sprints(2) == []


@respx.mock
async def test_groups_picker(client):
    route = respx.get(f"{BASE}/rest/api/2/groups/picker").mock(
        return_value=httpx.Response(200, json={"groups": [{"name": "backend"}, {"name": "qa"}], "total": 2})
    )
    assert await client.groups("b") == ["backend", "qa"]
    assert route.calls.last.request.url.params["query"] == "b"


@respx.mock
async def test_groups_forbidden(client):
    respx.get(f"{BASE}/rest/api/2/groups/picker").mock(return_value=httpx.Response(403))
    with pytest.raises(JiraForbiddenError):
        await client.groups("b")


@respx.mock
async def test_latest_comment_and_none(client):
    respx.get(f"{BASE}/rest/api/2/issue/A-1/comment").mock(
        return_value=httpx.Response(200, json={"comments": [{"body": "x"}], "total": 3})
    )
    assert (await client.latest_comment("A-1"))["body"] == "x"
    respx.get(f"{BASE}/rest/api/2/issue/A-2/comment").mock(return_value=httpx.Response(200, json={"comments": []}))
    assert await client.latest_comment("A-2") is None


@respx.mock
async def test_suggest_values(client):
    route = respx.get(f"{BASE}/rest/api/2/jql/autocompletedata/suggestions").mock(
        return_value=httpx.Response(200, json={"results": [{"value": "1.0"}, {"value": "2.0"}]})
    )
    assert await client.suggest("fixVersion", "1") == ["1.0", "2.0"]
    assert route.calls.last.request.url.params["fieldName"] == "fixVersion"
