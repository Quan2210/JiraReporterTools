import re
from datetime import date, timedelta

from app.schemas import CustomFilter, ReportQuery

MAX_VALUE_LEN = 255
_SIMPLE_CLAUSE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")
_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$")
_OP_SYMBOL = {"eq": "=", "neq": "!=", "contains": "~", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
_ORDERED_OPS = {"gt", "gte", "lt", "lte"}


class JqlError(ValueError):
    pass


def quote(value: str) -> str:
    """Quote a value as a JQL string literal, escaping backslash and double quote."""
    if not isinstance(value, str) or not value.strip():
        raise JqlError("Giá trị lọc không được rỗng")
    if len(value) > MAX_VALUE_LEN:
        raise JqlError("Giá trị lọc quá dài")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise JqlError("Giá trị lọc chứa ký tự điều khiển")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _in_clause(field: str, values: list[str]) -> str:
    return f"{field} in ({', '.join(quote(v) for v in values)})"


def _user_clause(field: str, users: list[str], groups: list[str]) -> str | None:
    parts = []
    if users:
        parts.append(_in_clause(field, users))
    parts.extend(f"{field} in membersOf({quote(g)})" for g in groups)
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else f"({' OR '.join(parts)})"


def field_type(meta: dict) -> str:
    schema = meta.get("schema") or {}
    if "gh-sprint" in (schema.get("custom") or ""):
        return "sprint"
    return schema.get("type") or "string"


def clause_name(meta: dict) -> str:
    """JQL clause for a Jira field, taken from Jira's own field metadata (never from user text)."""
    fid = meta["id"]
    if fid.startswith("customfield_"):
        return f"cf[{fid.split('_', 1)[1]}]"
    names = meta.get("clauseNames") or []
    if not names:
        raise JqlError(f"Field {meta.get('name', fid)} không hỗ trợ lọc bằng JQL")
    name = names[0]
    return name if _SIMPLE_CLAUSE_RE.match(name) else quote(name)


def _render_value(value: str, ftype: str, ordered: bool) -> str:
    if ftype == "number" or (ordered and _NUMBER_RE.match(value)):
        if not _NUMBER_RE.match(value):
            raise JqlError(f"Giá trị phải là số: {value!r}")
        return value
    if ftype in ("date", "datetime"):
        if not _DATETIME_RE.match(value):
            raise JqlError(f"Giá trị phải là ngày (YYYY-MM-DD): {value!r}")
        return quote(value)
    if ordered:
        raise JqlError("Toán tử so sánh chỉ dùng cho field số hoặc ngày")
    return quote(value)


def _custom_clause(flt: CustomFilter, field_meta: dict[str, dict]) -> str:
    meta = field_meta.get(flt.field_id)
    if meta is None:
        raise JqlError(f"Field không tồn tại trong Jira: {flt.field_id}")
    name = clause_name(meta)
    ftype = field_type(meta)
    op = flt.operator
    if op == "empty":
        return f"{name} is EMPTY"
    if op == "not_empty":
        return f"{name} is not EMPTY"
    if op in ("in", "not_in"):
        rendered = ", ".join(_render_value(v, ftype, False) for v in flt.values)
        return f"{name} {'in' if op == 'in' else 'not in'} ({rendered})"
    return f"{name} {_OP_SYMBOL[op]} {_render_value(flt.values[0], ftype, op in _ORDERED_OPS)}"


def _date_range(field: str, start: date | None, end: date | None) -> list[str]:
    clauses = []
    if start:
        clauses.append(f'{field} >= "{start.isoformat()}"')
    if end:
        # inclusive end date: strictly before the start of the following day
        clauses.append(f'{field} < "{(end + timedelta(days=1)).isoformat()}"')
    return clauses


def build_jql(query: ReportQuery, field_meta: dict[str, dict] | None = None) -> str:
    if query.jql:
        return query.jql

    clauses: list[str] = []
    if query.projects:
        clauses.append(_in_clause("project", query.projects))
    if query.labels:
        clauses.append(_in_clause("labels", query.labels))
    if query.sprints:
        clauses.append(f"sprint in ({', '.join(str(int(s)) for s in query.sprints)})")
    for field, users, groups in (
        ("reporter", query.reporters, query.reporter_groups),
        ("assignee", query.assignees, query.assignee_groups),
    ):
        clause = _user_clause(field, users, groups)
        if clause:
            clauses.append(clause)
    if query.statuses:
        clauses.append(_in_clause("status", query.statuses))
    if query.issue_types:
        clauses.append(_in_clause("issuetype", query.issue_types))
    clauses += _date_range("created", query.created_from, query.created_to)
    clauses += _date_range("updated", query.updated_from, query.updated_to)
    if query.custom_filters:
        if field_meta is None:
            raise JqlError("Thiếu metadata field để dựng bộ lọc tuỳ chỉnh")
        clauses += [_custom_clause(f, field_meta) for f in query.custom_filters]

    where = " AND ".join(clauses)
    order = "ORDER BY created DESC"
    return f"{where} {order}" if where else order
