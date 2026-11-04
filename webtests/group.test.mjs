import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_LABEL, axisValues, dateBucket, flattenGroups, groupRows, isoWeek, uniqueRowsWithGroup } from "../static/js/lib/group.js";

const row = (key, cells, atoms = {}) => ({ key, cells, atoms });
const data = [
  row("A-1", { status: "Open", created: "2024-05-01 10:15", labels: "a, b" }, { labels: ["a", "b"] }),
  row("A-2", { status: "Done", created: "2024-05-01 18:00", labels: "a" }, { labels: ["a"] }),
  row("A-3", { status: "Open", created: "2024-05-02 09:00", labels: "" }, { labels: [] }),
  row("A-4", { status: "", created: "2024-06-10 09:00", labels: "b" }, { labels: ["b"] }),
];
const status = { col: "status", type: "status" };
const labels = { col: "labels", type: "array" };
const created = (bucket) => ({ col: "created", type: "datetime", bucket });
const keys = (node) => (node.rows || []).map((r) => r.key);

test("date buckets", () => {
  assert.equal(dateBucket("2024-05-01 10:15", "day"), "2024-05-01");
  assert.equal(dateBucket("2024-05-01 10:15", "month"), "2024-05");
  assert.equal(dateBucket("not a date", "day"), "not a date");
});

test("iso week handles year boundaries", () => {
  assert.equal(isoWeek("2024-01-01"), "2024-W01");
  assert.equal(isoWeek("2023-01-01"), "2022-W52");
  assert.equal(isoWeek("2020-12-31"), "2020-W53");
});

test("group by a plain column; empty values go last as (trống)", () => {
  const nodes = groupRows(data, [status]);
  assert.deepEqual(nodes.map((n) => [n.value, n.count]), [["Done", 1], ["Open", 2], [EMPTY_LABEL, 1]]);
});

test("group by day", () => {
  const nodes = groupRows(data, [created("day")]);
  assert.deepEqual(nodes.map((n) => [n.value, keys(n)]), [
    ["2024-05-01", ["A-1", "A-2"]], ["2024-05-02", ["A-3"]], ["2024-06-10", ["A-4"]]]);
});

test("group by month", () => {
  assert.deepEqual(groupRows(data, [created("month")]).map((n) => [n.value, n.count]), [["2024-05", 3], ["2024-06", 1]]);
});

test("multi-valued column puts a row under each of its values", () => {
  const nodes = groupRows(data, [labels]);
  const by = Object.fromEntries(nodes.map((n) => [n.value, keys(n)]));
  assert.deepEqual(by.a, ["A-1", "A-2"]);
  assert.deepEqual(by.b, ["A-1", "A-4"]);
  assert.deepEqual(by[EMPTY_LABEL], ["A-3"]);
});

test("nested levels", () => {
  const nodes = groupRows(data, [created("month"), status]);
  const may = nodes[0];
  assert.equal(may.value, "2024-05");
  assert.deepEqual(may.children.map((c) => [c.value, keys(c)]), [["Done", ["A-2"]], ["Open", ["A-1", "A-3"]]]);
  assert.deepEqual(may.children[0].path, ["2024-05", "Done"]);
});

test("order by count", () => {
  assert.equal(groupRows(data, [status], { order: "count" })[0].value, "Open");
});

test("flatten honours collapsed groups", () => {
  const nodes = groupRows(data, [status]);
  const all = flattenGroups(nodes);
  assert.equal(all.filter((e) => e.type === "row").length, 4);
  const open = nodes.find((n) => n.value === "Open");
  const collapsed = flattenGroups(nodes, new Set([open.path.join("\u0001")]));
  assert.equal(collapsed.filter((e) => e.type === "row").length, 2);
  assert.equal(collapsed.find((e) => e.type === "group" && e.node === open).collapsed, true);
});

test("unique rows keep first occurrence and its group path", () => {
  const unique = uniqueRowsWithGroup(groupRows(data, [labels]));
  assert.deepEqual(unique.map((u) => u.row.key).sort(), ["A-1", "A-2", "A-3", "A-4"]);
  assert.deepEqual(unique.find((u) => u.row.key === "A-1").path, ["a"]);
});

test("axisValues falls back to cell text and handles empty", () => {
  assert.deepEqual(axisValues(row("X", { status: "Open" }), status), ["Open"]);
  assert.deepEqual(axisValues(row("X", { status: "" }), status), [EMPTY_LABEL]);
  assert.deepEqual(axisValues(row("X", { labels: "" }, { labels: [] }), labels), [EMPTY_LABEL]);
});

test("no levels means no groups", () => {
  assert.deepEqual(groupRows(data, []), []);
});
