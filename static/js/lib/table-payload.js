import { textColorFor } from "./color.js";

const flat = (text) => String(text ?? "").replace(/[\t\r\n]+/g, " ");
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Assemble the table that export / copy operate on: exactly the selected rows, in display order.
 * entries: [{row, groupPath?}] (already unique, already sorted/grouped)
 * Returns {headers, rows, fills} with an STT column (renumbered 1..n), optional "Nhóm", data columns, optional "Ghi chú".
 */
export function buildTablePayload({ columns, entries, notes, showNote, colorFor, colorScope, statusColId, grouped }) {
  const headers = ["STT"];
  if (grouped) headers.push("Nhóm");
  headers.push(...columns.map((c) => c.name));
  if (showNote) headers.push("Ghi chú");

  const rows = [];
  const fills = [];
  entries.forEach(({ row, groupPath }, index) => {
    const cells = [String(index + 1)];
    if (grouped) cells.push((groupPath || []).join(" / "));
    for (const col of columns) cells.push(row.cells[col.id] ?? "");
    if (showNote) cells.push(notes[row.key] || "");
    rows.push(cells);

    const color = colorFor ? colorFor(row) : null;
    const rowFills = cells.map(() => null);
    if (color) {
      if (colorScope === "row") rowFills.fill(color);
      else {
        const offset = 1 + (grouped ? 1 : 0);
        const statusIndex = columns.findIndex((c) => c.id === statusColId);
        if (statusIndex >= 0) rowFills[offset + statusIndex] = color;
      }
    }
    fills.push(rowFills);
  });
  return { headers, rows, fills };
}

export function payloadToTsv({ headers, rows }) {
  return [headers, ...rows].map((line) => line.map(flat).join("\t")).join("\n");
}

/** HTML table with inline colours so the formatting survives pasting into Excel / Google Sheets. */
export function payloadToHtml({ headers, rows, fills }) {
  const head = `<tr>${headers.map((h) => `<th style="border:1px solid #999;font-weight:bold">${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = rows.map((cells, r) => `<tr>${cells.map((cell, c) => {
    const bg = fills[r][c];
    const style = bg ? `background-color:${bg};color:${textColorFor(bg)};` : "";
    return `<td style="border:1px solid #999;${style}">${escapeHtml(cell)}</td>`;
  }).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
