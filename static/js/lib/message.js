export const DEFAULT_TEMPLATE = "{key}:{summary} ==> {note}";

const oneLine = (text) => String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();

/** Fill {key} {summary} {note} {status} {url}; unknown placeholders are left as written. */
export function renderLine(template, row, note) {
  const values = { key: row.key, summary: row.summary, note, status: row.status, url: row.url || "" };
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? oneLine(values[name]) : whole);
}

export function buildMessage(rows, template, notes) {
  return rows.map((row) => renderLine(template || DEFAULT_TEMPLATE, row, notes[row.key] || "")).join("\n");
}
