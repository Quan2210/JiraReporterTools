import asyncio
import logging

from app.cache import TTLCache
from app.config import Settings
from app.jira_client import JiraClient, JiraError
from app.jql import build_jql
from app.normalizer import column_type, comment_page_truncated, format_comment, normalize_issue
from app.schemas import ReportQuery

log = logging.getLogger("jira_report.report")

COMMENT_FALLBACK_CONCURRENCY = 5
COMMENT_FALLBACK_MAX_ISSUES = 300


class InvalidColumnError(ValueError):
    pass


async def get_field_meta(client: JiraClient, cache: TTLCache) -> dict[str, dict]:
    fields = await cache.get("fields", client.fields)
    return {f["id"]: f for f in fields}


async def _fill_truncated_comments(client: JiraClient, keys: list[str], rows_by_key: dict[str, dict]) -> None:
    """Jira normally returns every comment in /search; if a page was cut, fetch the newest one per issue."""
    sem = asyncio.Semaphore(COMMENT_FALLBACK_CONCURRENCY)

    async def one(key: str) -> None:
        async with sem:
            try:
                newest = await client.latest_comment(key)
            except JiraError:
                log.warning("latest comment fallback failed for %s", key)
                return
        if newest:
            rows_by_key[key]["cells"]["comment"] = format_comment(newest)

    await asyncio.gather(*(one(k) for k in keys[:COMMENT_FALLBACK_MAX_ISSUES]))


async def run_query(
    query: ReportQuery, client: JiraClient, cache: TTLCache, settings: Settings
) -> dict:
    field_meta = await get_field_meta(client, cache)
    unknown = [c for c in query.columns if c not in field_meta]
    if unknown:
        raise InvalidColumnError(f"Cột không tồn tại trong Jira: {', '.join(unknown)}")

    jql = build_jql(query, field_meta)
    limit = min(query.max_rows or settings.max_rows, settings.max_rows)
    # summary/status always travel with the row (messages, colours)
    request_fields = list(dict.fromkeys([c for c in query.columns if c != "issuekey"] + ["summary", "status"]))

    rows: list[dict] = []
    truncated_comment_keys: list[str] = []
    total = 0
    start_at = 0
    while len(rows) < limit:
        page_size = min(settings.page_size, limit - len(rows))
        data = await client.search(jql, request_fields, start_at, page_size)
        issues = data.get("issues") or []
        total = data.get("total", total)
        for issue in issues:
            rows.append(normalize_issue(issue, query.columns, field_meta, settings.jira_base_url))
            if "comment" in query.columns and comment_page_truncated((issue.get("fields") or {}).get("comment")):
                truncated_comment_keys.append(issue.get("key", ""))
        start_at += len(issues)
        if not issues or start_at >= total:
            break

    if truncated_comment_keys:
        await _fill_truncated_comments(client, truncated_comment_keys, {r["key"]: r for r in rows})

    log.info("report: %d/%d rows, %d columns", len(rows), total, len(query.columns))
    return {
        "columns": [
            {"id": c, "name": field_meta[c].get("name", c), "type": column_type(field_meta[c])}
            for c in query.columns
        ],
        "rows": rows,
        "total": total,
        "truncated": total > len(rows),
        "jql": jql,
    }
