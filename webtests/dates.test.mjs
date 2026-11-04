import test from "node:test";
import assert from "node:assert/strict";
import { autoSlash, formatBucket, isoToDisplay, parseDisplay } from "../static/js/lib/dates.js";
import { axisValues, groupRows } from "../static/js/lib/group.js";
import { multiSort } from "../static/js/lib/sort.js";

test("ISO to dd/MM/yyyy, with HH:mm only when there is a time", () => {
  assert.equal(isoToDisplay("2026-10-01"), "01/10/2026");
  assert.equal(isoToDisplay("2026-10-01T09:09"), "01/10/2026 09:09");
  assert.equal(isoToDisplay("2026-10-01 18:30"), "01/10/2026 18:30");
  assert.equal(isoToDisplay("2026-10-01T09:09:00.000+0800"), "01/10/2026 09:09");
  assert.equal(isoToDisplay(""), "");
  assert.equal(isoToDisplay("not a date"), "not a date");
  assert.equal(isoToDisplay(null), "");
});

test("typed dates parse to ISO, real calendar dates only", () => {
  assert.equal(parseDisplay("01/10/2026"), "2026-10-01");
  assert.equal(parseDisplay("1/2/2026"), "2026-02-01");
  assert.equal(parseDisplay(" 31-12-2025 "), "2025-12-31");
  assert.equal(parseDisplay("29.02.2024"), "2024-02-29");
  for (const bad of ["31/02/2026", "29/02/2025", "32/01/2026", "00/10/2026", "10/13/2026x", "2026-10-01", "01/10/26", "", "abc", null]) {
    assert.equal(parseDisplay(bad), null, String(bad));
  }
});

test("display and parse round-trip", () => {
  for (const iso of ["2026-01-31", "2024-02-29", "2000-12-01"]) assert.equal(parseDisplay(isoToDisplay(iso)), iso);
});

test("slashes are inserted while typing", () => {
  assert.equal(autoSlash("0"), "0");
  assert.equal(autoSlash("011"), "01/1");
  assert.equal(autoSlash("01102026"), "01/10/2026");
  assert.equal(autoSlash("011020269999"), "01/10/2026");
  assert.equal(autoSlash("01-10-2026"), "01/10/2026");
  assert.equal(autoSlash("1/2/20x"), "1/2/20");
  assert.equal(autoSlash(""), "");
  // typing one character at a time on top of what is already shown
  assert.equal(autoSlash("01/102"), "01/10/2");
  assert.equal(autoSlash("01/10/2"), "01/10/2");
  assert.equal(autoSlash("01/10/20265"), "01/10/2026");
  assert.equal(autoSlash("1/"), "1/");
  assert.equal(autoSlash("01/10/"), "01/10/");
  assert.equal(autoSlash("01.10.2026"), "01/10/2026");
  let typed = "";
  for (const ch of "15102026") typed = autoSlash(typed + ch);
  assert.equal(typed, "15/10/2026");
});

test("bucket labels", () => {
  assert.equal(formatBucket("2026-10-01"), "01/10/2026");
  assert.equal(formatBucket("2026-10"), "10/2026");
  assert.equal(formatBucket("2026-W05"), "2026-W05");
  assert.equal(formatBucket("(trống)"), "(trống)");
});

// dd/MM/yyyy sorts wrongly as text, so sorting and grouping must use the ISO value kept in row.raw
const row = (key, display, iso) => ({ key, cells: { created: display }, raw: iso ? { created: iso } : {}, atoms: {} });
const rows = [
  row("A", "15/01/2026 09:00", "2026-01-15T09:00"),
  row("B", "03/12/2025 10:00", "2025-12-03T10:00"),
  row("C", "20/11/2025 08:00", "2025-11-20T08:00"),
  row("D", "", null),
];
const getter = (r, col) => r.raw?.[col] ?? r.cells[col] ?? "";

test("sorting on raw ISO is chronological even though dd/MM text is not", () => {
  const byText = multiSort(rows, [{ col: "created", dir: 1 }], (r, c) => r.cells[c]).map((r) => r.key);
  const byRaw = multiSort(rows, [{ col: "created", dir: 1 }], getter).map((r) => r.key);
  assert.deepEqual(byText, ["B", "A", "C", "D"]);       // what a text sort would have produced (wrong order)
  assert.deepEqual(byRaw, ["C", "B", "A", "D"]);        // chronological, empty last
  assert.deepEqual(multiSort(rows, [{ col: "created", dir: -1 }], getter).map((r) => r.key), ["A", "B", "C", "D"]);
});

test("grouping buckets come from the ISO value and sort chronologically", () => {
  const level = { col: "created", type: "datetime", bucket: "month" };
  assert.deepEqual(axisValues(rows[0], level), ["2026-01"]);
  const nodes = groupRows(rows, [level]);
  assert.deepEqual(nodes.map((n) => [n.value, formatBucket(n.value), n.count]), [
    ["2025-11", "11/2025", 1], ["2025-12", "12/2025", 1], ["2026-01", "01/2026", 1], ["(trống)", "(trống)", 1]]);
  const days = groupRows(rows, [{ col: "created", type: "datetime", bucket: "day" }]);
  assert.deepEqual(days.map((n) => formatBucket(n.value)), ["20/11/2025", "03/12/2025", "15/01/2026", "(trống)"]);
});
