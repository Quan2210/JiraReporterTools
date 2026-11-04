import asyncio

from fastapi import APIRouter, HTTPException, Query, Request

from app.jira_client import JiraError
from app.jql import JqlError, clause_name, field_type
from app.report_service import get_field_meta

router = APIRouter(prefix="/api/meta")


def _deps(request: Request):
    return request.app.state.client, request.app.state.cache


@router.get("/projects")
async def projects(request: Request):
    client, cache = _deps(request)
    data = await cache.get("projects", client.projects)
    return sorted(({"key": p["key"], "name": p["name"]} for p in data), key=lambda p: p["key"])


@router.get("/fields")
async def fields(request: Request):
    client, cache = _deps(request)
    data = await cache.get("fields", client.fields)
    return sorted(
        (
            {
                "id": f["id"],
                "name": f["name"],
                "custom": f.get("custom", False),
                "type": field_type(f),
                "searchable": bool(f.get("searchable")) and f["id"] != "issuekey",
            }
            for f in data
        ),
        key=lambda f: f["name"].lower(),
    )


@router.get("/statuses")
async def statuses(request: Request):
    client, cache = _deps(request)
    data = await cache.get("statuses", client.statuses)
    unique: dict[str, str] = {}
    for s in data:
        unique.setdefault(s["name"], (s.get("statusCategory") or {}).get("key", ""))
    return [{"name": n, "category": c} for n, c in sorted(unique.items(), key=lambda kv: kv[0].lower())]


@router.get("/issuetypes")
async def issue_types(request: Request):
    client, cache = _deps(request)
    data = await cache.get("issuetypes", client.issue_types)
    return sorted({t["name"] for t in data}, key=str.lower)


@router.get("/labels")
async def labels(request: Request, q: str = Query("", max_length=100)):
    client, _ = _deps(request)
    return await client.labels(q)


@router.get("/users")
async def users(request: Request, q: str = Query("", max_length=100)):
    client, _ = _deps(request)
    data = await client.users(q)
    return [
        {"username": u.get("name") or u.get("key"), "displayName": u.get("displayName", "")}
        for u in data
        if u.get("name") or u.get("key")
    ]


@router.get("/groups")
async def groups(request: Request, q: str = Query("", max_length=100)):
    client, _ = _deps(request)
    return await client.groups(q)


@router.get("/suggest")
async def suggest(
    request: Request,
    field: str = Query(..., pattern=r"^[A-Za-z0-9_.\-]{1,100}$"),
    q: str = Query("", max_length=100),
):
    """Value suggestions for a custom filter. Best effort: any failure just means 'type it yourself'."""
    client, cache = _deps(request)
    meta = (await get_field_meta(client, cache)).get(field)
    if meta is None:
        raise HTTPException(status_code=404, detail="Field không tồn tại")
    try:
        return await client.suggest(clause_name(meta), q)
    except (JiraError, JqlError):
        return []


@router.get("/sprints")
async def sprints(request: Request, project: str = Query(..., pattern=r"^[A-Za-z][A-Za-z0-9_]{0,49}$")):
    client, cache = _deps(request)

    async def load():
        boards = await client.boards(project)
        results = await asyncio.gather(*(client.sprints(b["id"]) for b in boards[:10]))
        seen: dict[int, dict] = {}
        for board, board_sprints in zip(boards, results):
            for s in board_sprints:
                seen.setdefault(
                    s["id"],
                    {"id": s["id"], "name": s["name"], "state": s.get("state", ""), "board": board["name"]},
                )
        return sorted(seen.values(), key=lambda s: s["id"], reverse=True)

    return await cache.get(f"sprints:{project.upper()}", load)
