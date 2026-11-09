import { evaluateRows } from "./note-rules.js";

export const DEFAULT_TEMPLATE = "{key}:{summary} ==> {note}";

const oneLine = (text) => String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
const has = (object, name) => Object.prototype.hasOwnProperty.call(object, name);

/**
 * Fill {key} {summary} {note} {status} {url} ({issuekey} = {key}). Any other name that is a column the row carries
 * ({assignee}, {created}, {customfield_10111}...) takes that column's display value; unknown placeholders are left
 * as written. Same rules as app/message.py.
 */
export function renderLine(template, row, note) {
  const values = { key: row.key, issuekey: row.key, summary: row.summary, note, status: row.status, url: row.url || "" };
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    if (has(values, name)) return oneLine(values[name]);
    if (row.cells && has(row.cells, name)) return oneLine(row.cells[name]);
    return whole;
  });
}

export function buildMessage(rows, template, notes) {
  return rows.map((row) => renderLine(template || DEFAULT_TEMPLATE, row, notes[row.key] || "")).join("\n");
}

/**
 * The "Xuất tin nhắn" text. The note of a row is, in order: the note typed for that issue in the table, else the note
 * of the first matching rule, else the default note. Rules with action "hide" leave their rows out.
 * -> {text, count, hidden, matched}
 */
export function buildExportMessage({ rows, template, notes = {}, rules = [], defaultNote = "" }) {
  const line = template || DEFAULT_TEMPLATE;
  const { entries, hidden } = evaluateRows(rows, rules, defaultNote, (text, row) => renderLine(text, row, ""));
  const text = entries.map((e) => renderLine(line, e.row, notes[e.row.key] || e.note)).join("\n");
  return { text, count: entries.length, hidden, matched: entries.filter((e) => e.matched).length };
}
