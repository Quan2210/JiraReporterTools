import { compareValues } from "./sort.js";

export const EMPTY_LABEL = "(trống)";

/** ISO week label such as "2024-W19" for a "YYYY-MM-DD..." string. */
export function isoWeek(dateText) {
  const [y, m, d] = dateText.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function dateBucket(text, bucket) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
  if (bucket === "month") return text.slice(0, 7);
  if (bucket === "week") return isoWeek(text);
  return text.slice(0, 10);
}

/**
 * Values a row contributes to a grouping/pivot axis. Multi-valued fields (labels, sprints) yield one
 * value each, so such a row appears under every one of its values.
 * level: {col, type, bucket}
 */
export function axisValues(row, level) {
  const { col, type, bucket } = level;
  if (row.atoms && row.atoms[col]) {
    const atoms = row.atoms[col];
    return atoms.length ? atoms : [EMPTY_LABEL];
  }
  const isDate = type === "date" || type === "datetime";
  // dates are displayed as dd/MM/yyyy, so bucket on the ISO value kept in row.raw
  const raw = (isDate ? row.raw?.[col] : undefined) ?? row.cells[col] ?? "";
  if (raw === "") return [EMPTY_LABEL];
  if (isDate) return [dateBucket(raw, bucket || "day")];
  return [raw];
}

function compareNodes(order) {
  return (a, b) => {
    if (a.value === EMPTY_LABEL) return 1;
    if (b.value === EMPTY_LABEL) return -1;
    if (order === "count" && b.count !== a.count) return b.count - a.count;
    return compareValues(a.value, b.value);
  };
}

/**
 * Nested grouping. levels: [{col, type, bucket}], returns [{value, level, count, path, children|rows}].
 * `count` is the number of rows under the node (a multi-valued row is counted in each of its groups).
 */
export function groupRows(rows, levels, { order = "key" } = {}) {
  function build(subset, depth, path) {
    const level = levels[depth];
    const buckets = new Map();
    for (const row of subset) {
      for (const value of new Set(axisValues(row, level))) {
        if (!buckets.has(value)) buckets.set(value, []);
        buckets.get(value).push(row);
      }
    }
    const nodes = [...buckets].map(([value, members]) => {
      const nodePath = [...path, value];
      const node = { value, level: depth, count: members.length, path: nodePath };
      if (depth + 1 < levels.length) node.children = build(members, depth + 1, nodePath);
      else node.rows = members;
      return node;
    });
    return nodes.sort(compareNodes(order));
  }
  return levels.length ? build(rows, 0, []) : [];
}

/** Flatten a group tree into display entries: {type:"group", node, collapsed} and {type:"row", row, node}. */
export function flattenGroups(nodes, collapsed = new Set()) {
  const out = [];
  (function walk(list) {
    for (const node of list) {
      const id = node.path.join("\u0001");
      const isCollapsed = collapsed.has(id);
      out.push({ type: "group", node, id, collapsed: isCollapsed });
      if (isCollapsed) continue;
      if (node.children) walk(node.children);
      else for (const row of node.rows) out.push({ type: "row", row, node });
    }
  })(nodes);
  return out;
}

/** Rows in display order without duplicates (first occurrence wins) and each row's first group path. */
export function uniqueRowsWithGroup(nodes) {
  const seen = new Map();
  (function walk(list) {
    for (const node of list) {
      if (node.children) walk(node.children);
      else for (const row of node.rows) if (!seen.has(row.key)) seen.set(row.key, { row, path: node.path });
    }
  })(nodes);
  return [...seen.values()];
}
