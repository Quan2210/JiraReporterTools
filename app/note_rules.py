"""Per-row rules for reminder messages: a note (or "hide the row") by condition, plus grouping and sorting.

A rule is {field, op, values, action, text}. Rules are tried top to bottom and the first match wins:
  action "note": `text` becomes {note} for that row (it may use {variables});
  action "hide": the row is left out of the message (and of the count).
Rows that match no rule get the default note.
"""
from dataclasses import dataclass
from typing import Callable

MAX_RULES = 20
RULE_OPS = ("in", "not_in", "contains", "empty", "not_empty")
RULE_ACTIONS = ("note", "hide")


@dataclass
class Entry:
    row: dict
    note: str
    matched: bool          # a note rule (not just the default note) applied


def _fold(value) -> str:
    return str(value).strip().casefold()


def field_values(row: dict, field: str) -> list[str]:
    """The individual values a row has for a field (labels/sprints are several; status/assignee one)."""
    if field == "status":
        values = [row.get("status")]
    elif field in ("key", "issuekey"):
        values = [row.get("key")]
    elif field == "summary":
        values = [row.get("summary")]
    else:
        atoms = (row.get("atoms") or {}).get(field)
        if atoms is not None:
            values = list(atoms)
        else:
            cell = (row.get("cells") or {}).get(field)
            values = [cell] if cell else []
    return [str(v).strip() for v in values if v not in (None, "") and str(v).strip()]


def rule_matches(rule: dict, row: dict) -> bool:
    wanted = [_fold(v) for v in rule.get("values") or [] if str(v).strip()]
    have = [_fold(a) for a in field_values(row, rule["field"])]
    op = rule["op"]
    if op == "empty":
        return not have
    if op == "not_empty":
        return bool(have)
    if op == "in":
        return any(a in wanted for a in have)
    if op == "not_in":
        return not any(a in wanted for a in have)
    if op == "contains":
        return bool(wanted) and any(wanted[0] in a for a in have)
    return False


def evaluate(rows: list[dict], rules: list[dict], default_note: str | None,
             render: Callable[[str, dict], str]) -> tuple[list[Entry], int]:
    """(entries to show, number of rows hidden). `render(text, row)` fills {variables} in note texts."""
    entries: list[Entry] = []
    hidden = 0
    for row in rows:
        note: str | None = None
        matched = False
        hide = False
        for rule in rules:
            if rule_matches(rule, row):
                if rule.get("action") == "hide":
                    hide = True
                else:
                    note = render(rule.get("text") or "", row)
                    matched = True
                break
        if hide:
            hidden += 1
            continue
        if note is None:
            note = render(default_note, row) if default_note else ""
        entries.append(Entry(row, note, matched))
    return entries, hidden


# ---- grouping and sorting ---------------------------------------------------------------------------------------

def _display(row: dict, field: str) -> str:
    return ", ".join(field_values(row, field))


def _sort_value(row: dict, field: str) -> str:
    raw = (row.get("raw") or {}).get(field)          # ISO date/datetime: sorts correctly as text
    return raw if raw else _display(row, field)


def _sort_key(row: dict, field: str):
    text = _sort_value(row, field)
    try:
        return (0, float(text), "")
    except ValueError:
        return (1, 0.0, text.casefold())


def sort_entries(entries: list[Entry], field: str | None, direction: str) -> list[Entry]:
    """Sort by a field; rows with no value always go last."""
    if not field:
        return list(entries)
    filled = [e for e in entries if _sort_value(e.row, field) != ""]
    empty = [e for e in entries if _sort_value(e.row, field) == ""]
    filled.sort(key=lambda e: _sort_key(e.row, field), reverse=direction == "desc")
    return filled + empty


def arrange(entries: list[Entry], group_by: str | None, group_order: str, sort_by: str | None,
            sort_dir: str) -> list[tuple[str | None, list[Entry]]]:
    """[(group name or None, entries)] in message order. Without grouping there is a single unnamed section."""
    if not group_by:
        return [(None, sort_entries(entries, sort_by, sort_dir))]
    groups: dict[str, list[Entry]] = {}
    for entry in entries:
        groups.setdefault(_display(entry.row, group_by), []).append(entry)
    if group_order == "count":
        names = sorted(groups, key=lambda n: (n == "", -len(groups[n]), n.casefold()))
    else:
        names = sorted(groups, key=lambda n: (n == "", n.casefold()))
    return [(name, sort_entries(groups[name], sort_by, sort_dir)) for name in names]
