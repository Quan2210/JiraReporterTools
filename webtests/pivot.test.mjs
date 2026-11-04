import test from "node:test";
import assert from "node:assert/strict";
import { OTHER_LABEL, buildPivot } from "../static/js/lib/pivot.js";
import { EMPTY_LABEL } from "../static/js/lib/group.js";

const row = (key, cells, atoms = {}) => ({ key, cells, atoms });
const data = [
  row("A-1", { status: "Open", assignee: "An", sp: "3", labels: "x, y" }, { labels: ["x", "y"] }),
  row("A-2", { status: "Open", assignee: "Binh", sp: "5", labels: "x" }, { labels: ["x"] }),
  row("A-3", { status: "Done", assignee: "An", sp: "2", labels: "" }, { labels: [] }),
  row("A-4", { status: "Done", assignee: "", sp: "", labels: "y" }, { labels: ["y"] }),
];
const status = { col: "status", type: "status" };
const assignee = { col: "assignee", type: "user" };
const labels = { col: "labels", type: "array" };

test("counts per cell with row and column totals", () => {
  const p = buildPivot(data, { x: status, y: assignee });
  assert.deepEqual(p.xs, ["Done", "Open"]);
  assert.deepEqual(p.ys, ["An", "Binh", EMPTY_LABEL]);
  assert.equal(p.get("Open", "An").count, 1);
  assert.equal(p.get("Done", "An").count, 1);
  assert.equal(p.get("Done", EMPTY_LABEL).count, 1);
  assert.equal(p.get("Open", EMPTY_LABEL).count, 0);
  assert.equal(p.colTotal("Open").count, 2);
  assert.equal(p.rowTotal("An").count, 2);
  assert.equal(p.issueCount, 4);
  assert.equal(p.max, 1);
  assert.equal(p.multiValued, false);
});

test("sum column adds numeric values and ignores blanks", () => {
  const p = buildPivot(data, { x: status, y: assignee, sumCol: "sp" });
  assert.equal(p.get("Open", "An").sum, 3);
  assert.equal(p.colTotal("Open").sum, 8);
  assert.equal(p.colTotal("Done").sum, 2);
  assert.equal(p.rowTotal(EMPTY_LABEL).sum, 0);
});

test("multi-valued axis counts a row in each value and flags it", () => {
  const p = buildPivot(data, { x: labels, y: status });
  assert.equal(p.get("x", "Open").count, 2);
  assert.equal(p.get("y", "Open").count, 1);
  assert.equal(p.get("y", "Done").count, 1);
  assert.equal(p.get(EMPTY_LABEL, "Done").count, 1);
  assert.equal(p.multiValued, true);
  assert.equal(p.issueCount, 4);
  assert.deepEqual([...p.get("x", "Open").keys].sort(), ["A-1", "A-2"]);
});

test("values beyond the limit fold into 'Khác' and keep their counts", () => {
  const many = Array.from({ length: 6 }, (_, i) => row(`B-${i}`, { status: `S${i}`, assignee: "An" }));
  many.push(row("B-x", { status: "S0", assignee: "An" }));
  const p = buildPivot(many, { x: status, y: assignee, limit: 3 });
  assert.equal(p.xs.length, 4);
  assert.equal(p.xs.at(-1), OTHER_LABEL);
  assert.equal(p.colTotal(OTHER_LABEL).count, 3);
  assert.equal(p.rowTotal("An").count, 7);
});

test("order by total ranks the largest first", () => {
  const p = buildPivot(data, { x: assignee, y: status, order: "total" });
  assert.equal(p.xs[0], "An");
});

test("empty input", () => {
  const p = buildPivot([], { x: status, y: assignee });
  assert.deepEqual([p.xs, p.ys, p.max, p.issueCount], [[], [], 0, 0]);
});

test("date axis uses buckets", () => {
  const rows = [row("D-1", { created: "2024-05-01 10:00", status: "Open" }), row("D-2", { created: "2024-05-01 12:00", status: "Open" })];
  const p = buildPivot(rows, { x: { col: "created", type: "datetime", bucket: "day" }, y: status });
  assert.deepEqual(p.xs, ["2024-05-01"]);
  assert.equal(p.get("2024-05-01", "Open").count, 2);
});
