/** Keys between two rows (inclusive) in the current display order, for Shift+click range selection. */
export function rangeKeys(orderedKeys, fromKey, toKey) {
  const a = orderedKeys.indexOf(fromKey);
  const b = orderedKeys.indexOf(toKey);
  if (a < 0 || b < 0) return toKey ? [toKey] : [];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return orderedKeys.slice(lo, hi + 1);
}

/** Tri-state for a "select all" checkbox over `keys`. */
export function selectionState(keys, selected) {
  const n = keys.filter((k) => selected.has(k)).length;
  if (n === 0) return "none";
  return n === keys.length ? "all" : "some";
}
