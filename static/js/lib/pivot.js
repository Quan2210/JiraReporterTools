import { EMPTY_LABEL, axisValues } from "./group.js";
import { compareValues } from "./sort.js";

export const OTHER_LABEL = "Khác";

function toNumber(text) {
  const n = Number(String(text ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Two-dimensional pivot over result rows.
 * x, y: {col, type, bucket}; sumCol: optional numeric column id summed in each cell (null = count only).
 * Axis values beyond `limit` (ranked by size) are folded into "Khác".
 */
export function buildPivot(rows, { x, y, sumCol = null, limit = 50, order = "key" }) {
  const cells = new Map(); // "xv\u0001yv" -> {count, sum, keys:Set}
  const xTotals = new Map();
  const yTotals = new Map();

  for (const row of rows) {
    const xs = [...new Set(axisValues(row, x))];
    const ys = [...new Set(axisValues(row, y))];
    const amount = sumCol ? toNumber(row.cells[sumCol]) : 0;
    for (const xv of xs) {
      for (const yv of ys) {
        const id = `${xv}\u0001${yv}`;
        let cell = cells.get(id);
        if (!cell) cells.set(id, (cell = { xv, yv, count: 0, sum: 0, keys: [] }));
        cell.count += 1;
        cell.sum += amount;
        cell.keys.push(row.key);
      }
    }
    for (const xv of xs) xTotals.set(xv, (xTotals.get(xv) || 0) + 1);
    for (const yv of ys) yTotals.set(yv, (yTotals.get(yv) || 0) + 1);
  }

  const axis = (totals) => {
    let values = [...totals.keys()];
    const sorter = (a, b) => {
      if (a === EMPTY_LABEL) return 1;
      if (b === EMPTY_LABEL) return -1;
      if (order === "total" && totals.get(b) !== totals.get(a)) return totals.get(b) - totals.get(a);
      return compareValues(a, b);
    };
    values.sort(sorter);
    let folded = new Set();
    if (values.length > limit) {
      const keep = new Set([...values].sort((a, b) => totals.get(b) - totals.get(a)).slice(0, limit));
      folded = new Set(values.filter((v) => !keep.has(v)));
      values = values.filter((v) => keep.has(v));
      values.push(OTHER_LABEL);
    }
    return { values, folded };
  };

  const ax = axis(xTotals);
  const ay = axis(yTotals);
  const mapX = (v) => (ax.folded.has(v) ? OTHER_LABEL : v);
  const mapY = (v) => (ay.folded.has(v) ? OTHER_LABEL : v);

  const matrix = new Map();
  for (const cell of cells.values()) {
    const id = `${mapX(cell.xv)}\u0001${mapY(cell.yv)}`;
    let target = matrix.get(id);
    if (!target) matrix.set(id, (target = { count: 0, sum: 0, keys: new Set() }));
    target.count += cell.count;
    target.sum += cell.sum;
    cell.keys.forEach((k) => target.keys.add(k));
  }

  const get = (xv, yv) => matrix.get(`${xv}\u0001${yv}`) || { count: 0, sum: 0, keys: new Set() };
  const rowTotal = (yv) => ({
    count: ax.values.reduce((n, xv) => n + get(xv, yv).count, 0),
    sum: ax.values.reduce((n, xv) => n + get(xv, yv).sum, 0),
  });
  const colTotal = (xv) => ({
    count: ay.values.reduce((n, yv) => n + get(xv, yv).count, 0),
    sum: ay.values.reduce((n, yv) => n + get(xv, yv).sum, 0),
  });
  const max = Math.max(0, ...[...matrix.values()].map((c) => c.count));

  return {
    xs: ax.values,
    ys: ay.values,
    get,
    rowTotal,
    colTotal,
    max,
    // distinct issues, which can be smaller than the sum of cells when an axis is multi-valued
    issueCount: new Set(rows.map((r) => r.key)).size,
    multiValued: rows.some((r) => (r.atoms && (r.atoms[x.col] || r.atoms[y.col]) || []).length > 1),
  };
}
