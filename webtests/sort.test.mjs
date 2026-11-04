import test from "node:test";
import assert from "node:assert/strict";
import { multiSort, toggleSort, compareValues } from "../static/js/lib/sort.js";

const get = (row, col) => row[col];
const rows = [
  { id: 1, status: "Open", prio: "2" },
  { id: 2, status: "Done", prio: "10" },
  { id: 3, status: "Open", prio: "10" },
  { id: 4, status: "Done", prio: "2" },
  { id: 5, status: "", prio: "1" },
];
const ids = (list) => list.map((r) => r.id);

test("numeric-aware comparison", () => {
  assert.ok(compareValues("ABC-2", "ABC-10") < 0);
  assert.ok(compareValues("b", "A") > 0);
});

test("single column ascending and descending", () => {
  assert.deepEqual(ids(multiSort(rows, [{ col: "prio", dir: 1 }], get)), [5, 1, 4, 2, 3]);
  assert.deepEqual(ids(multiSort(rows, [{ col: "prio", dir: -1 }], get)), [2, 3, 1, 4, 5]);
});

test("second column breaks ties of the first", () => {
  const sorted = multiSort(rows, [{ col: "status", dir: 1 }, { col: "prio", dir: -1 }], get);
  assert.deepEqual(ids(sorted), [2, 4, 3, 1, 5]);
});

test("empty values sort last in both directions", () => {
  assert.equal(multiSort(rows, [{ col: "status", dir: 1 }], get).at(-1).id, 5);
  assert.equal(multiSort(rows, [{ col: "status", dir: -1 }], get).at(-1).id, 5);
});

test("sort is stable and does not mutate the input", () => {
  const copy = [...rows];
  assert.deepEqual(ids(multiSort(rows, [{ col: "status", dir: 1 }], get)), [2, 4, 1, 3, 5]);
  assert.deepEqual(rows, copy);
  assert.equal(multiSort(rows, [], get), rows);
});

test("plain click cycles asc -> desc -> off", () => {
  let s = toggleSort([], "a", false);
  assert.deepEqual(s, [{ col: "a", dir: 1 }]);
  s = toggleSort(s, "a", false);
  assert.deepEqual(s, [{ col: "a", dir: -1 }]);
  assert.deepEqual(toggleSort(s, "a", false), []);
});

test("plain click on another column replaces a multi-sort", () => {
  assert.deepEqual(toggleSort([{ col: "a", dir: 1 }, { col: "b", dir: 1 }], "c", false), [{ col: "c", dir: 1 }]);
  assert.deepEqual(toggleSort([{ col: "a", dir: 1 }, { col: "b", dir: 1 }], "a", false), [{ col: "a", dir: 1 }]);
});

test("shift click appends, flips, then removes a key", () => {
  let s = toggleSort([{ col: "a", dir: 1 }], "b", true);
  assert.deepEqual(s, [{ col: "a", dir: 1 }, { col: "b", dir: 1 }]);
  s = toggleSort(s, "b", true);
  assert.deepEqual(s, [{ col: "a", dir: 1 }, { col: "b", dir: -1 }]);
  s = toggleSort(s, "b", true);
  assert.deepEqual(s, [{ col: "a", dir: 1 }]);
});
