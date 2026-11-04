import test from "node:test";
import assert from "node:assert/strict";
import {
  clampPage, pageAfterSizeChange, pageCount, pageOfIndex, pageRange, parsePageInput, selectedPages,
} from "../static/js/lib/paging.js";

test("page count is at least one", () => {
  assert.equal(pageCount(0, 50), 1);
  assert.equal(pageCount(50, 50), 1);
  assert.equal(pageCount(51, 50), 2);
  assert.equal(pageCount(123, 100), 2);
});

test("clamping keeps the page inside range and tolerates junk", () => {
  assert.equal(clampPage(-3, 123, 50), 0);
  assert.equal(clampPage(99, 123, 50), 2);
  assert.equal(clampPage(1.9, 123, 50), 1);
  assert.equal(clampPage(NaN, 123, 50), 0);
  assert.equal(clampPage(5, 0, 50), 0);
});

test("page range slices exactly, last page is short", () => {
  assert.deepEqual(pageRange(0, 123, 50), { start: 0, end: 50 });
  assert.deepEqual(pageRange(2, 123, 50), { start: 100, end: 123 });
  assert.deepEqual(pageRange(9, 123, 50), { start: 100, end: 123 });
  assert.deepEqual(pageRange(0, 0, 50), { start: 0, end: 0 });
});

test("go-to-page input is 1-based, clamped, and rejects text", () => {
  assert.equal(parsePageInput("1", 123, 50), 0);
  assert.equal(parsePageInput(" 3 ", 123, 50), 2);
  assert.equal(parsePageInput("999", 123, 50), 2);
  assert.equal(parsePageInput("0", 123, 50), 0);
  assert.equal(parsePageInput("-4", 123, 50), 0);
  assert.equal(parsePageInput("abc", 123, 50), null);
  assert.equal(parsePageInput("", 123, 50), null);
});

test("selected pages are reported 1-based, sorted and de-duplicated", () => {
  const keys = Array.from({ length: 12 }, (_, i) => `K-${i}`);
  const selected = new Set(["K-11", "K-0", "K-1", "K-5", "nope"]);
  assert.deepEqual(selectedPages(keys, selected, 5), [1, 2, 3]);
  assert.deepEqual(selectedPages(keys, selected, 20), [1]);
  assert.deepEqual(selectedPages(keys, new Set(), 5), []);
});

test("selection pages follow the current order, not the original one", () => {
  const reordered = ["K-3", "K-2", "K-1", "K-0"];
  assert.deepEqual(selectedPages(reordered, new Set(["K-0", "K-3"]), 2), [1, 2]);
});

test("changing page size keeps the first visible row on screen", () => {
  assert.equal(pageAfterSizeChange(3, 50, 100), 1);   // rows 150.. -> page index 1 of 100
  assert.equal(pageAfterSizeChange(1, 100, 20), 5);
  assert.equal(pageAfterSizeChange(0, 50, 500), 0);
  assert.equal(pageOfIndex(149, 50), 2);
});
