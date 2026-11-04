"""Best-effort JQL -> structured filters.

Only top-level AND chains of simple clauses are understood. Anything else (OR, functions other than
membersOf, nested parentheses, unknown fields) is reported in `unsupported` instead of being guessed.
"""
import re
from datetime import date, timedelta

from app.schemas import PROJECT_KEY_RE

_AND_RE = re.compile(r"\s+AND\s+", re.I)
_ORDER_RE = re.compile(r"\s+ORDER\s+BY\s+", re.I)
_CLAUSE_RE = re.compile(
    r'^(?P<field>cf\[\d+\]|"(?:[^"\\]|\\.)+"|[A-Za-z_][\w.]*)\s*'
    r"(?P<op>not\s+in|in|is\s+not|is|!=|>=|<=|=|~|>|<)\s*(?P<rest>.+)$",
    re.I | re.S,
)
_MEMBERS_RE = re.compile(r'^membersOf\(\s*"((?:[^"\\]|\\.)+)"\s*\)$', re.I)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BARE_RE = re.compile(r"^[\w.\-@]+$")
_OP_MAP = {"in": "in", "not in": "not_in", "=": "eq", "!=": "neq", "~": "contains",
           ">": "gt", ">=": "gte", "<": "lt", "<=": "lte"}


def _unescape(text: str) -> str:
    return re.sub(r"\\(.)", r"\1", text)


def split_clauses(jql: str) -> tuple[list[str], str | None]:
    """Split on top-level AND (outside quotes/parentheses); cut a trailing ORDER BY."""
    clauses: list[str] = []
    order_by: str | None = None
    depth, in_quote, start, i = 0, False, 0, 0
    while i < len(jql):
        ch = jql[i]
        if in_quote:
            if ch == "\\":
                i += 1
            elif ch == '"':
                in_quote = False
        elif ch == '"':
            in_quote = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0 and ch.isspace():
            order = _ORDER_RE.match(jql, i)
            if order:
                clauses.append(jql[start:i])
                order_by = jql[order.end():].strip()
                return [c.strip() for c in clauses if c.strip()], order_by
            and_ = _AND_RE.match(jql, i)
            if and_:
                clauses.append(jql[start:i])
                start = i = and_.end()
                continue
        i += 1
    clauses.append(jql[start:])
    return [c.strip() for c in clauses if c.strip()], order_by


def _literal(text: str) -> str | None:
    text = text.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        inner = text[1:-1]
        if re.search(r'(?<!\\)"', re.sub(r"\\.", "", inner)):
            return None
        return _unescape(inner)
    return text if _BARE_RE.match(text) else None


def _split_list(text: str) -> list[str] | None:
    items, buf, in_quote, i = [], "", False, 0
    while i < len(text):
        ch = text[i]
        if in_quote:
            buf += ch
            if ch == "\\" and i + 1 < len(text):
                i += 1
                buf += text[i]
            elif ch == '"':
                in_quote = False
        elif ch == '"':
            in_quote = True
            buf += ch
        elif ch == ",":
            items.append(buf)
            buf = ""
        else:
            buf += ch
        i += 1
    if in_quote:
        return None
    items.append(buf)
    return items


def _values(op: str, rest: str) -> tuple[list[str], list[str]] | None:
    """-> (plain values, group names) or None when the right-hand side is not understood."""
    rest = rest.strip()
    if op in ("in", "not in"):
        if rest.startswith("(") and rest.endswith(")"):
            parts = _split_list(rest[1:-1])
            if parts is None:
                return None
            members = [_MEMBERS_RE.match(p.strip()) for p in parts]
            if len(parts) == 1 and members[0]:
                return [], [_unescape(members[0].group(1))]
            lits = [_literal(p) for p in parts]
            return (lits, []) if all(v is not None for v in lits) else None
        members = _MEMBERS_RE.match(rest)
        if members:
            return [], [_unescape(members.group(1))]
        return None
    lit = _literal(rest)
    return ([lit], []) if lit is not None else None


def _field_index(field_meta: dict[str, dict]) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for meta in field_meta.values():
        for name in (meta.get("clauseNames") or []):
            index.setdefault(name.lower(), meta)
        index.setdefault(str(meta.get("name", "")).lower(), meta)
    return index


def parse_jql(jql: str, field_meta: dict[str, dict]) -> dict:
    filters: dict = {
        "projects": [], "labels": [], "sprints": [], "reporters": [], "reporter_groups": [],
        "assignees": [], "assignee_groups": [], "statuses": [], "issue_types": [],
        "created_from": None, "created_to": None, "updated_from": None, "updated_to": None,
        "custom_filters": [],
    }
    unsupported: list[str] = []
    seen: set[str] = set()
    index = _field_index(field_meta)
    clauses, order_by = split_clauses(jql)

    def claim(slot: str) -> bool:
        if slot in seen:
            return False
        seen.add(slot)
        return True

    for clause in clauses:
        if not _apply_clause(clause, filters, index, claim):
            unsupported.append(clause)
    return {"filters": filters, "unsupported": unsupported, "order_by": order_by, "exact": not unsupported}


def _apply_clause(clause: str, filters: dict, index: dict, claim) -> bool:
    m = _CLAUSE_RE.match(clause)
    if not m:
        return False
    field = m.group("field")
    if field.startswith('"'):
        field = _unescape(field[1:-1])
    field_l = field.lower()
    op = re.sub(r"\s+", " ", m.group("op").lower())
    rest = m.group("rest")

    if op in ("is", "is not"):
        meta = index.get(field_l)
        if meta and rest.strip().upper() in ("EMPTY", "NULL"):
            filters["custom_filters"].append(
                {"field_id": meta["id"], "operator": "empty" if op == "is" else "not_empty", "values": []})
            return True
        return False

    if field_l in ("created", "updated"):
        return _apply_date(field_l, op, rest, filters, claim)

    parsed = _values(op, rest) if op in ("in", "not in", "=") else None
    if parsed is not None and op != "not in":
        values, groups = parsed
        slot = {"project": "projects", "labels": "labels", "sprint": "sprints", "reporter": "reporters",
                "assignee": "assignees", "status": "statuses", "issuetype": "issue_types",
                "type": "issue_types"}.get(field_l)
        if slot and not (groups and slot not in ("reporters", "assignees")):
            if not claim(slot):
                return False
            if slot == "projects" and not all(PROJECT_KEY_RE.match(v) for v in values):
                return False
            if slot == "sprints":
                if not all(v.isdigit() for v in values):
                    return False
                values = [int(v) for v in values]
            filters[slot].extend(values)
            if groups:
                filters[slot[:-1] + "_groups"].extend(groups)
            return True

    meta = index.get(field_l)
    if meta is None or op not in _OP_MAP:
        return False
    parsed = _values(op, rest)
    if parsed is None or parsed[1]:
        return False
    values = parsed[0]
    filters["custom_filters"].append({"field_id": meta["id"], "operator": _OP_MAP[op], "values": values})
    return True


def _apply_date(field: str, op: str, rest: str, filters: dict, claim) -> bool:
    lit = _literal(rest)
    if lit is None or not _DATE_RE.match(lit):
        return False
    try:
        day = date.fromisoformat(lit)
    except ValueError:
        return False
    if op == ">=":
        slot, value = f"{field}_from", day
    elif op == "<":
        slot, value = f"{field}_to", day - timedelta(days=1)
    elif op == "<=":
        slot, value = f"{field}_to", day
    else:
        return False
    if not claim(slot):
        return False
    filters[slot] = value.isoformat()
    return True
