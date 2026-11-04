"""Python port of static/js/lib/message.js `renderLine` (same rules, shared test cases), plus the title line.

`{note}` is not available server-side (notes live in the browser's localStorage), so it renders empty.
Besides the built-ins, any Jira field id that the report loaded (e.g. {assignee}, {created}, {customfield_10020}) fills
from the row's display value; unknown placeholders are left as written.
"""
import re
from datetime import date

DEFAULT_TEMPLATE = "{key}: {summary} [{status}] {url}"
DEFAULT_TITLE = "{name} ({count} issue)"
BUILTIN_VARIABLES = ("key", "issuekey", "summary", "status", "url", "note")
TITLE_VARIABLES = ("name", "count", "date")

_PLACEHOLDER = re.compile(r"\{(\w+)\}")
_NEWLINES = re.compile(r"\s*[\r\n]+\s*")


def _one_line(value) -> str:
    return _NEWLINES.sub(" ", "" if value is None else str(value)).strip()


def placeholders(template: str) -> list[str]:
    """Distinct placeholder names in order of appearance."""
    return list(dict.fromkeys(_PLACEHOLDER.findall(template or "")))


def render_line(template: str, row: dict, note: str = "") -> str:
    cells = row.get("cells") or {}
    values = {
        "key": row.get("key"),
        "issuekey": row.get("key"),
        "summary": row.get("summary"),
        "note": note,
        "status": row.get("status"),
        "url": row.get("url") or "",
    }

    def sub(match: re.Match) -> str:
        name = match.group(1)
        if name in values:
            return _one_line(values[name])
        if name in cells:
            return _one_line(cells[name])
        return match.group(0)

    return _PLACEHOLDER.sub(sub, template)


def render_title(template: str | None, name: str, count: int, today: date | None = None) -> str:
    """The first line of a reminder message: {name}, {count} (issues in the report), {date} (dd/MM/yyyy)."""
    day = (today or date.today()).strftime("%d/%m/%Y")
    values = {"name": name, "count": str(count), "date": day}
    return _PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), (template or "").strip() or DEFAULT_TITLE)
