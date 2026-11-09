import test from "node:test";
import assert from "node:assert/strict";
import { cleanRules, evaluateRows, fieldValues, ruleMatches } from "../static/js/lib/note-rules.js";
import { buildExportMessage, renderLine } from "../static/js/lib/message.js";
import { defaultProfile, sanitizeProfile } from "../static/js/lib/profile.js";

// Same data and expectations as tests/test_note_rules.py: the browser and the server must pick the same notes.
const row = (key, status, assignee, labels, points, summary = `Task ${key}`) => ({
  key, summary, status, url: `https://j/browse/${key}`,
  cells: { issuekey: key, assignee: assignee ?? "", labels: labels.join(", "), customfield_10111: points == null ? "" : String(points) },
  atoms: { labels },
});
const ROWS = [
  row("ABC-1", "Done", "An Nguyen", ["bug"], 5),
  row("ABC-2", "Open", "Binh Tran", [], 13),
  row("ABC-3", "In Review", "An Nguyen", ["ui", "bug"], 8),
  row("ABC-4", "Open", null, ["ui"], null),
];
const by = Object.fromEntries(ROWS.map((r) => [r.key, r]));
const rule = (over = {}) => ({ field: "status", op: "in", values: ["Done"], action: "note", text: "x", ...over });

test("rule operators", () => {
  assert.ok(ruleMatches(rule({ values: ["done"] }), by["ABC-1"]));                           // case-insensitive
  assert.ok(!ruleMatches(rule({ values: ["Done"] }), by["ABC-2"]));
  assert.ok(ruleMatches(rule({ values: ["Open", "Done"] }), by["ABC-2"]));
  assert.ok(ruleMatches(rule({ op: "not_in", values: ["Done"] }), by["ABC-2"]));
  assert.ok(!ruleMatches(rule({ op: "not_in", values: ["Done"] }), by["ABC-1"]));
  assert.ok(ruleMatches(rule({ field: "assignee", op: "contains", values: ["nguy"] }), by["ABC-1"]));
  assert.ok(ruleMatches(rule({ field: "assignee", op: "empty", values: [] }), by["ABC-4"]));
  assert.ok(ruleMatches(rule({ field: "assignee", op: "not_empty", values: [] }), by["ABC-1"]));
  assert.ok(ruleMatches(rule({ field: "labels", values: ["ui"] }), by["ABC-3"]));            // one of several labels
  assert.ok(!ruleMatches(rule({ field: "labels", values: ["ui"] }), by["ABC-1"]));
  assert.ok(ruleMatches(rule({ field: "labels", op: "empty", values: [] }), by["ABC-2"]));
  assert.ok(!ruleMatches(rule({ field: "not_loaded", values: ["a"] }), by["ABC-1"]));        // a column the row does not carry
  assert.ok(ruleMatches(rule({ field: "not_loaded", op: "empty", values: [] }), by["ABC-1"]));
  assert.ok(!ruleMatches({ field: "status", op: "bogus", values: [] }, by["ABC-1"]));
  assert.deepEqual(fieldValues(by["ABC-3"], "labels"), ["ui", "bug"]);
  assert.deepEqual(fieldValues(by["ABC-1"], "key"), ["ABC-1"]);
});

test("first matching rule wins, hide removes rows, the default note fills the rest", () => {
  const rules = [rule({ values: ["Done"], action: "hide" }), rule({ values: ["Open"], text: "Mở: {assignee}" }), rule({ op: "not_empty", values: [], text: "khác" })];
  const { entries, hidden } = evaluateRows(ROWS, rules, "mặc định", (text, r) => renderLine(text, r, ""));
  assert.equal(hidden, 1);
  assert.deepEqual(entries.map((e) => e.row.key), ["ABC-2", "ABC-3", "ABC-4"]);
  assert.deepEqual(entries.map((e) => e.note), ["Mở: Binh Tran", "khác", "Mở: "]);             // an empty {assignee} renders empty
  assert.ok(entries[2].matched);

  const plain = evaluateRows(ROWS, [rule({ values: ["Done"], text: "xong" })], "chưa xong");
  assert.deepEqual(plain.entries.map((e) => [e.row.key, e.note, e.matched]),
    [["ABC-1", "xong", true], ["ABC-2", "chưa xong", false], ["ABC-3", "chưa xong", false], ["ABC-4", "chưa xong", false]]);
  assert.deepEqual(evaluateRows(ROWS, [], "").entries.map((e) => e.note), ["", "", "", ""]);
  assert.deepEqual(evaluateRows(ROWS, undefined, undefined).hidden, 0);
});

test("renderLine fills any column the row carries, built-ins win, unknown stay literal", () => {
  assert.equal(renderLine("{key} {assignee} [{labels}] {customfield_10111}", by["ABC-1"], ""), "ABC-1 An Nguyen [bug] 5");
  assert.equal(renderLine("{issuekey}: {summary}", row("A-1", "Open", null, [], null, "Fix\nlogin"), ""), "A-1: Fix login");
  assert.equal(renderLine("{reporter} {nope}", by["ABC-1"], ""), "{reporter} {nope}");
  assert.equal(renderLine("{assignee}", { key: "A-1" }, ""), "{assignee}");                  // a row without cells
  assert.equal(renderLine("{status}", { ...by["ABC-1"], cells: { status: "from-cells" } }, ""), "Done");
});

test("export message: typed note > rule note > default note, hide drops rows, counts", () => {
  const rules = [rule({ values: ["Done"], text: "Done pilot" }), rule({ field: "assignee", op: "empty", values: [], action: "hide" })];
  const out = buildExportMessage({ rows: ROWS, template: "{key} ==> {note}", rules, defaultNote: "đang làm", notes: { "ABC-1": "tự gõ" } });
  assert.equal(out.text, "ABC-1 ==> tự gõ\nABC-2 ==> đang làm\nABC-3 ==> đang làm");
  assert.deepEqual([out.count, out.hidden, out.matched], [3, 1, 1]);
  const noTyped = buildExportMessage({ rows: ROWS.slice(0, 2), template: "{key} ==> {note}", rules, defaultNote: "", notes: {} });
  assert.equal(noTyped.text, "ABC-1 ==> Done pilot\nABC-2 ==> ");
  assert.equal(buildExportMessage({ rows: [], template: "", rules: [], defaultNote: "" }).text, "");
  assert.equal(buildExportMessage({ rows: ROWS.slice(0, 1) }).text, "ABC-1:Task ABC-1 ==> ");     // blank template falls back
});

test("cleanRules keeps valid rules and drops the rest without throwing", () => {
  assert.deepEqual(cleanRules([
    { field: "status", op: "in", values: [" Done ", "", "Closed"], action: "note", text: "  ok  " },
    { field: "assignee", op: "empty", values: ["x"], text: "t" },
    { field: "labels", op: "contains", values: ["a", "b"], action: "hide", text: "ignored" },
    { field: "status", op: "in", values: [] },                         // no values: dropped
    { field: "bad id", op: "in", values: ["a"] },
    { field: "status", op: "like", values: ["a"] },
    null, "x", 5,
  ]), [
    { field: "status", op: "in", values: ["Done", "Closed"], action: "note", text: "ok" },
    { field: "assignee", op: "empty", values: [], action: "note", text: "t" },
    { field: "labels", op: "contains", values: ["a"], action: "hide", text: "" },
  ]);
  assert.deepEqual(cleanRules(undefined), []);
  assert.deepEqual(cleanRules({ not: "an array" }), []);
  assert.equal(cleanRules(Array.from({ length: 30 }, () => rule())).length, 20);
  assert.equal(cleanRules([rule({ text: "x".repeat(300) })])[0].text.length, 200);
});

test("the profile stores the export rules and drops junk", () => {
  const profile = { ...defaultProfile(), noteRules: [rule(), { field: "", op: "in", values: ["a"] }], defaultNote: "d".repeat(300) };
  const clean = sanitizeProfile(JSON.parse(JSON.stringify(profile)));
  assert.equal(clean.noteRules.length, 1);
  assert.equal(clean.defaultNote.length, 200);
  assert.deepEqual([defaultProfile().noteRules, defaultProfile().defaultNote], [[], ""]);
  assert.deepEqual(sanitizeProfile({ version: 1 }).noteRules, []);                 // a profile saved before this feature
});
