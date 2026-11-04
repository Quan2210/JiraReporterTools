import json
import re
from typing import Any

from app.jql import field_type

# Jira Server returns Sprint values as strings such as
# "com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=12,rapidViewId=3,state=ACTIVE,name=Sprint 5,startDate=...]"
_SPRINT_NAME_RE = re.compile(r"name=(.*?)(?=,\w+=|\])")
_DISPLAY_KEYS = ("displayName", "name", "value", "key")
_ISSUE_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*-\d+$")
COMMENT_MAX_CHARS = 500


def _sprint_name(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("name") or "")
    text = str(item)
    match = _SPRINT_NAME_RE.search(text)
    return match.group(1) if match else text


_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def _format_date(text: str) -> str:
    # "2024-05-01..." -> "01/05/2024"
    m = _DATE_RE.match(text)
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else text


def _format_datetime(text: str) -> str:
    # "2024-05-01T10:15:30.000+0700" -> "01/05/2024 10:15"; without a time part -> "01/05/2024"
    if not _DATE_RE.match(text):
        return text
    day = _format_date(text)
    if len(text) >= 16 and text[10] == "T":
        return f"{day} {text[11:16]}"
    return day


def _iso_value(text: str, ctype: str) -> str:
    """Sortable ISO form kept next to the display text: 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD'."""
    if not _DATE_RE.match(text):
        return ""
    if ctype == "datetime" and len(text) >= 16 and text[10] == "T":
        return text[:16]
    return text[:10]


def _flatten(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ", ".join(part for part in (_flatten(v) for v in value) if part)
    if isinstance(value, dict):
        for key in _DISPLAY_KEYS:
            if value.get(key):
                return str(value[key])
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def column_type(meta: dict | None) -> str:
    return field_type(meta) if meta else "string"


def format_comment(comment: dict) -> str:
    """'Author (YYYY-MM-DD HH:MM): body' on one line, capped for table display."""
    author = (comment.get("author") or {}).get("displayName") or ""
    created = _format_datetime(comment.get("created") or "")
    body = " ".join(str(comment.get("body") or "").split())
    if len(body) > COMMENT_MAX_CHARS:
        body = body[: COMMENT_MAX_CHARS - 1] + "…"
    head = f"{author} ({created}): " if author or created else ""
    return f"{head}{body}"


def latest_comment(value: Any) -> dict | None:
    comments = (value or {}).get("comments") if isinstance(value, dict) else None
    if not comments:
        return None
    # do not rely on array order: pick the newest by creation time
    return max(comments, key=lambda c: c.get("created") or "")


def comment_page_truncated(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return (value.get("total") or 0) > len(value.get("comments") or [])


def normalize_value(value: Any, meta: dict | None) -> str:
    if value is None:
        return ""
    ctype = column_type(meta)
    if ctype == "sprint":
        items = value if isinstance(value, list) else [value]
        return ", ".join(name for name in (_sprint_name(i) for i in items) if name)
    if ctype == "comments-page":
        newest = latest_comment(value)
        return format_comment(newest) if newest else ""
    text = _flatten(value)
    if ctype == "datetime":
        return _format_datetime(text)
    if ctype == "date":
        return _format_date(text)
    return text


def _atoms(value: Any, meta: dict | None) -> list[str]:
    """Individual values of a multi-valued field (labels, sprints...) used for grouping/pivot."""
    if value is None:
        return []
    ctype = column_type(meta)
    items = value if isinstance(value, list) else [value]
    if ctype == "sprint":
        return [n for n in (_sprint_name(i) for i in items) if n]
    return [a for a in (_flatten(i) for i in items) if a]


def normalize_issue(issue: dict, columns: list[str], field_meta: dict[str, dict], base_url: str = "") -> dict:
    fields = issue.get("fields") or {}
    key = issue.get("key", "")
    cells: dict[str, str] = {}
    atoms: dict[str, list[str]] = {}
    raw: dict[str, str] = {}
    for col in columns:
        meta = field_meta.get(col)
        if col == "issuekey":
            cells[col] = key
            continue
        value = fields.get(col)
        cells[col] = normalize_value(value, meta)
        ctype = column_type(meta)
        if ctype in ("array", "sprint"):
            atoms[col] = _atoms(value, meta)
        elif ctype in ("date", "datetime") and isinstance(value, str) and (iso := _iso_value(value, ctype)):
            raw[col] = iso
    return {
        "key": key,
        "url": f"{base_url}/browse/{key}" if base_url and _ISSUE_KEY_RE.match(key) else None,
        "summary": _flatten(fields.get("summary")),
        "status": _flatten(fields.get("status")),
        "cells": cells,
        "atoms": atoms,
        "raw": raw,
    }
