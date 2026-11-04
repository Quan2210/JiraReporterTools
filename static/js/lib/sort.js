// Multi-column sorting. `sorts` is [{col, dir}] with dir 1 (asc) or -1 (desc); earlier entries win.

export function compareValues(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Stable multi-key sort. Empty values always sort last, whatever the direction. */
export function multiSort(rows, sorts, getValue) {
  if (!sorts.length) return rows;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      for (const { col, dir } of sorts) {
        const a = getValue(x.row, col);
        const b = getValue(y.row, col);
        if (a === b) continue;
        if (a === "") return 1;
        if (b === "") return -1;
        const c = compareValues(a, b);
        if (c !== 0) return c * dir;
      }
      return x.index - y.index;
    })
    .map((entry) => entry.row);
}

/**
 * Header click: plain click makes `col` the only sort (asc -> desc -> off);
 * additive (Shift) click appends it as a lower-priority key, or cycles it if already present.
 */
export function toggleSort(sorts, col, additive) {
  const existing = sorts.find((s) => s.col === col);
  if (!additive) {
    if (sorts.length === 1 && existing) return existing.dir === 1 ? [{ col, dir: -1 }] : [];
    return [{ col, dir: 1 }];
  }
  if (!existing) return [...sorts, { col, dir: 1 }];
  if (existing.dir === 1) return sorts.map((s) => (s.col === col ? { col, dir: -1 } : s));
  return sorts.filter((s) => s.col !== col);
}
