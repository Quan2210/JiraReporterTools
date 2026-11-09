// Per-row note rules in the browser. Mirrors app/note_rules.py (same semantics, same test vectors) so the
// "Xuất tin nhắn" dialog and the server-side reminders pick the same note for the same issue.
//
// A rule is {field, op, values, action, text}. Rules are tried top to bottom and the first match wins:
//   action "note": `text` becomes the row's note;  action "hide": the row is left out.
// Rows matching nothing get the default note.

export const RULE_OP_IDS = ["in", "not_in", "contains", "empty", "not_empty"];
const MAX_RULES = 20;
const ID_RE = /^[A-Za-z0-9_.\-]{1,100}$/;

const fold = (value) => String(value).trim().toLowerCase();

/** The individual values a row has for a field (labels/sprints are several; status/assignee one). */
export function fieldValues(row, field) {
  let values;
  if (field === "status") values = [row.status];
  else if (field === "key" || field === "issuekey") values = [row.key];
  else if (field === "summary") values = [row.summary];
  else if (row.atoms && Array.isArray(row.atoms[field])) values = [...row.atoms[field]];
  else {
    const cell = row.cells?.[field];
    values = cell ? [cell] : [];
  }
  return values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "").map((v) => String(v).trim());
}

export function ruleMatches(rule, row) {
  const wanted = (rule.values ?? []).filter((v) => String(v).trim()).map(fold);
  const have = fieldValues(row, rule.field).map(fold);
  switch (rule.op) {
    case "empty": return have.length === 0;
    case "not_empty": return have.length > 0;
    case "in": return have.some((a) => wanted.includes(a));
    case "not_in": return !have.some((a) => wanted.includes(a));
    case "contains": return wanted.length > 0 && have.some((a) => a.includes(wanted[0]));
    default: return false;
  }
}

/**
 * -> {entries: [{row, note, matched}], hidden}. `render(text, row)` fills {variables} in note texts.
 * Rows hidden by a "hide" rule are dropped.
 */
export function evaluateRows(rows, rules, defaultNote, render = (text) => text) {
  const entries = [];
  let hidden = 0;
  for (const row of rows) {
    let note = null;
    let matched = false;
    let hide = false;
    for (const rule of rules ?? []) {
      if (!ruleMatches(rule, row)) continue;
      if (rule.action === "hide") hide = true;
      else { note = render(rule.text || "", row); matched = true; }
      break;
    }
    if (hide) { hidden += 1; continue; }
    if (note === null) note = defaultNote ? render(defaultNote, row) : "";
    entries.push({ row, note, matched });
  }
  return { entries, hidden };
}

/** Lenient clean-up for stored rules (profile / import): keeps the valid ones, trims, never throws. */
export function cleanRules(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const r of input.slice(0, MAX_RULES)) {
    if (!r || typeof r !== "object" || typeof r.field !== "string" || !ID_RE.test(r.field) || !RULE_OP_IDS.includes(r.op)) continue;
    const action = r.action === "hide" ? "hide" : "note";
    const noValue = r.op === "empty" || r.op === "not_empty";
    let values = noValue ? [] : (Array.isArray(r.values) ? r.values : []).filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean).map((v) => v.slice(0, 255)).slice(0, 20);
    if (!noValue && !values.length) continue;
    if (r.op === "contains") values = values.slice(0, 1);
    out.push({ field: r.field, op: r.op, values, action, text: action === "hide" ? "" : String(r.text ?? "").trim().slice(0, 200) });
  }
  return out;
}
