import asyncio
import logging
from typing import Any

import httpx

from app.config import Settings

log = logging.getLogger("jira_report.client")

MAX_RETRIES = 2
MAX_RETRY_AFTER = 30.0


class JiraError(Exception):
    status_code = 502
    message = "Lỗi khi gọi Jira"

    def __init__(self, detail: str | None = None):
        self.detail = detail
        super().__init__(detail or self.message)


class JiraAuthError(JiraError):
    status_code = 401
    message = "PAT không hợp lệ hoặc đã hết hạn"


class JiraForbiddenError(JiraError):
    status_code = 403
    message = "Không đủ quyền truy cập dữ liệu này trên Jira"


class JiraBadRequestError(JiraError):
    status_code = 422
    message = "Jira từ chối truy vấn"


class JiraNotFoundError(JiraError):
    status_code = 404
    message = "Không tìm thấy tài nguyên trên Jira"


class JiraUnavailableError(JiraError):
    status_code = 502
    message = "Không kết nối được tới Jira"


class JiraInvalidResponseError(JiraUnavailableError):
    message = "Phản hồi của Jira không phải JSON"


def _error_detail(resp: httpx.Response) -> str | None:
    try:
        data = resp.json()
    except ValueError:
        return None
    messages = data.get("errorMessages") or []
    errors = data.get("errors") or {}
    parts = [str(m) for m in messages] + [str(v) for v in errors.values()]
    return "; ".join(parts) or None


class JiraClient:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self._client = httpx.AsyncClient(
            base_url=settings.jira_base_url,
            headers={
                "Authorization": f"Bearer {settings.jira_pat}",
                "Accept": "application/json",
            },
            timeout=httpx.Timeout(60.0, connect=10.0),
            verify=settings.ca_bundle or True,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        last_error: JiraError | None = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                resp = await self._client.request(method, path, **kwargs)
            except httpx.TransportError as exc:
                last_error = JiraUnavailableError(type(exc).__name__)
                log.warning("Jira transport error on %s %s: %s", method, path, type(exc).__name__)
            else:
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_error = JiraUnavailableError(f"HTTP {resp.status_code}")
                    log.warning("Jira HTTP %s on %s %s", resp.status_code, method, path)
                    if attempt < MAX_RETRIES and resp.status_code == 429:
                        await asyncio.sleep(_retry_after(resp))
                        continue
                elif resp.status_code == 401:
                    raise JiraAuthError()
                elif resp.status_code == 403:
                    raise JiraForbiddenError()
                elif resp.status_code == 404:
                    raise JiraNotFoundError(path)
                elif resp.status_code >= 400:
                    raise JiraBadRequestError(_error_detail(resp))
                else:
                    try:
                        return resp.json()
                    except ValueError:
                        raise JiraInvalidResponseError(path) from None
            if attempt < MAX_RETRIES:
                await asyncio.sleep(0.5 * (2**attempt))
        assert last_error is not None
        raise last_error

    # ---- health / metadata -------------------------------------------------

    async def myself(self) -> dict:
        return await self._request("GET", "/rest/api/2/myself")

    async def projects(self) -> list[dict]:
        return await self._request("GET", "/rest/api/2/project")

    async def fields(self) -> list[dict]:
        return await self._request("GET", "/rest/api/2/field")

    async def statuses(self) -> list[dict]:
        return await self._request("GET", "/rest/api/2/status")

    async def issue_types(self) -> list[dict]:
        return await self._request("GET", "/rest/api/2/issuetype")

    async def users(self, query: str) -> list[dict]:
        # Jira Server: "username" matches username, display name and e-mail
        return await self._request(
            "GET", "/rest/api/2/user/search", params={"username": query or ".", "maxResults": 50}
        )

    async def labels(self, query: str) -> list[str]:
        """Label suggestions. Jira Server has no endpoint listing all labels."""
        try:
            data = await self._request("GET", "/rest/api/1.0/labels/suggest", params={"query": query})
            return [s["label"] for s in data.get("suggestions", []) if s.get("label")]
        except (JiraNotFoundError, JiraBadRequestError, JiraInvalidResponseError):
            log.info("labels/suggest unavailable, falling back to JQL autocomplete")
        data = await self._request(
            "GET",
            "/rest/api/2/jql/autocompletedata/suggestions",
            params={"fieldName": "labels", "fieldValue": query},
        )
        return [r["value"] for r in data.get("results", []) if r.get("value")]

    async def groups(self, query: str) -> list[str]:
        data = await self._request(
            "GET", "/rest/api/2/groups/picker", params={"query": query, "maxResults": 50}
        )
        return [g["name"] for g in data.get("groups", []) if g.get("name")]

    async def suggest(self, clause: str, query: str) -> list[str]:
        """Value suggestions for a JQL clause (e.g. 'labels', 'cf[10111]')."""
        data = await self._request(
            "GET",
            "/rest/api/2/jql/autocompletedata/suggestions",
            params={"fieldName": clause, "fieldValue": query},
        )
        return [r["value"] for r in data.get("results", []) if r.get("value")]

    async def latest_comment(self, key: str) -> dict | None:
        data = await self._request(
            "GET", f"/rest/api/2/issue/{key}/comment", params={"orderBy": "-created", "maxResults": 1}
        )
        comments = data.get("comments") or []
        return comments[0] if comments else None

    async def boards(self, project_key: str) -> list[dict]:
        boards: list[dict] = []
        start = 0
        while True:
            data = await self._request(
                "GET",
                "/rest/agile/1.0/board",
                params={"projectKeyOrId": project_key, "startAt": start, "maxResults": 50},
            )
            boards.extend(data.get("values", []))
            if data.get("isLast", True) or not data.get("values"):
                return boards
            start += len(data["values"])

    async def sprints(self, board_id: int) -> list[dict]:
        sprints: list[dict] = []
        start = 0
        while True:
            try:
                data = await self._request(
                    "GET",
                    f"/rest/agile/1.0/board/{board_id}/sprint",
                    params={"startAt": start, "maxResults": 50},
                )
            except JiraBadRequestError:
                return sprints  # e.g. kanban board does not support sprints
            sprints.extend(data.get("values", []))
            if data.get("isLast", True) or not data.get("values"):
                return sprints
            start += len(data["values"])

    # ---- search ------------------------------------------------------------

    async def search(self, jql: str, fields: list[str], start_at: int, max_results: int) -> dict:
        body = {"jql": jql, "fields": fields, "startAt": start_at, "maxResults": max_results}
        return await self._request("POST", "/rest/api/2/search", json=body)


def _retry_after(resp: httpx.Response) -> float:
    try:
        return min(float(resp.headers.get("Retry-After", "1")), MAX_RETRY_AFTER)
    except ValueError:
        return 1.0
