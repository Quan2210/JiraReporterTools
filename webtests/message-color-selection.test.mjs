import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TEMPLATE, buildMessage, renderLine } from "../static/js/lib/message.js";
import { CATEGORY_DEFAULTS, isHexColor, statusColor, textColorFor } from "../static/js/lib/color.js";
import { rangeKeys, selectionState } from "../static/js/lib/selection.js";

const r1 = { key: "ABC-1", summary: "Fix login", status: "Open", url: "https://j/browse/ABC-1" };
const r2 = { key: "ABC-2", summary: "Add\nreport", status: "Done", url: null };

test("default template is Key:Summary ==> Ghi chú", () => {
  assert.equal(DEFAULT_TEMPLATE, "{key}:{summary} ==> {note}");
  assert.equal(renderLine(DEFAULT_TEMPLATE, r1, "đã deploy"), "ABC-1:Fix login ==> đã deploy");
});

test("empty note still keeps the arrow", () => {
  assert.equal(renderLine(DEFAULT_TEMPLATE, r1, ""), "ABC-1:Fix login ==> ");
});

test("one line per row, multi-line values flattened, order preserved", () => {
  const text = buildMessage([r2, r1], DEFAULT_TEMPLATE, { "ABC-2": "line1\nline2" });
  assert.equal(text, "ABC-2:Add report ==> line1 line2\nABC-1:Fix login ==> ");
});

test("other placeholders; unknown ones stay literal; blank template falls back", () => {
  assert.equal(renderLine("[{status}] {key} {url} {oops}", r1, ""), "[Open] ABC-1 https://j/browse/ABC-1 {oops}");
  assert.equal(renderLine("{url}|", r2, ""), "|");
  assert.equal(buildMessage([r1], "", {}), "ABC-1:Fix login ==> ");
  assert.equal(buildMessage([], DEFAULT_TEMPLATE, {}), "");
});

test("note content cannot inject placeholders twice", () => {
  assert.equal(renderLine("{note}-{key}", r1, "{key}"), "{key}-ABC-1");
});

test("text colour contrasts with background", () => {
  assert.equal(textColorFor("#000000"), "#FFFFFF");
  assert.equal(textColorFor("#1F3A5F"), "#FFFFFF");
  assert.equal(textColorFor("#FFF2CC"), "#000000");
});

test("status colour: user setting, then category default, else none", () => {
  const cats = { Open: "new", Closed: "done", Weird: "" };
  assert.equal(statusColor("Open", { Open: "#abcdef" }, cats), "#ABCDEF");
  assert.equal(statusColor("Open", {}, cats), CATEGORY_DEFAULTS.new);
  assert.equal(statusColor("Closed", { Closed: "not-a-color" }, cats), CATEGORY_DEFAULTS.done);
  assert.equal(statusColor("Weird", {}, cats), null);
  assert.equal(statusColor("", {}, cats), null);
});

test("hex validation", () => {
  assert.ok(isHexColor("#a1B2c3"));
  for (const bad of ["a1b2c3", "#12345", "#12345g", "red", "", null, 5]) assert.equal(isHexColor(bad), false);
});

test("range selection works in either direction", () => {
  const keys = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rangeKeys(keys, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeKeys(keys, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(rangeKeys(keys, "zzz", "c"), ["c"]);
});

test("tri-state selection", () => {
  const keys = ["a", "b", "c"];
  assert.equal(selectionState(keys, new Set()), "none");
  assert.equal(selectionState(keys, new Set(["a"])), "some");
  assert.equal(selectionState(keys, new Set(keys)), "all");
  assert.equal(selectionState(keys, new Set(["x"])), "none");
});
