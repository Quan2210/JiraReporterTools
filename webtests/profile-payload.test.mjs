import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROFILE_BYTES, emptyFilters, PROFILE_VERSION, ProfileError, defaultProfile, mergeNotes, parseProfileText, sanitizeProfile, serializeProfile,
} from "../static/js/lib/profile.js";
import { buildTablePayload, payloadToHtml, payloadToTsv } from "../static/js/lib/table-payload.js";

// ---- profile --------------------------------------------------------------

test("default profile round-trips through serialize/parse", () => {
  const p = defaultProfile();
  p.notes["ABC-1"] = "ghi chú";
  p.statusColors.Open = "#ffaa00";
  const back = parseProfileText(serializeProfile(p));
  assert.equal(back.notes["ABC-1"], "ghi chú");
  assert.equal(back.statusColors.Open, "#FFAA00");
  assert.equal(back.version, PROFILE_VERSION);
});

test("rejects non-JSON, non-objects, missing/newer version and oversize files", () => {
  assert.throws(() => parseProfileText("{oops"), ProfileError);
  assert.throws(() => parseProfileText("[1,2]"), ProfileError);
  assert.throws(() => parseProfileText("{}"), ProfileError);
  assert.throws(() => parseProfileText(JSON.stringify({ version: PROFILE_VERSION + 1 })), /mới hơn/);
  assert.throws(() => parseProfileText("x".repeat(MAX_PROFILE_BYTES + 1)), /quá lớn/);
});

test("older/minimal profile gets defaults for missing keys", () => {
  const p = sanitizeProfile({ version: 1 });
  assert.deepEqual(p, { ...defaultProfile() });
  assert.equal(p.ui.colorScope, "row");
  assert.equal(p.ui.showNote, true);
});

test("sanitising drops unknown keys and invalid values", () => {
  const p = sanitizeProfile({
    version: 1, evil: "<script>", name: "n".repeat(500),
    ui: { pageSize: 7, colorScope: "weird", hiddenFilters: ["ok", "bad id!", 3], showNote: false },
    columns: ["summary", "../x", 5],
    statusColors: { Open: "#112233", Bad: "red", Worse: "#12" },
    notes: { "ABC-1": "x", "not a key": "y", "ABC-2": 5, "ABC-3": "" },
    messageTemplate: "   ",
    customFilters: [
      { id: "1", fieldId: "labels", operator: "in", values: ["a", 3, "b"] },
      { id: "2", fieldId: "labels", operator: "DROP TABLE", values: [] },
      { id: "3", fieldId: "bad id!", operator: "eq", values: ["a"] },
    ],
  });
  assert.equal("evil" in p, false);
  assert.equal(p.name.length, 100);
  assert.deepEqual(p.ui, { hiddenFilters: ["ok"], pageSize: 100, showNote: false, colorScope: "row" });
  assert.deepEqual(p.columns, ["summary"]);
  assert.deepEqual(p.statusColors, { Open: "#112233" });
  assert.deepEqual(p.notes, { "ABC-1": "x" });
  assert.equal(p.messageTemplate, "{key}:{summary} ==> {note}");
  assert.deepEqual(p.customFilters, [{ id: "1", fieldId: "labels", operator: "in", values: ["a", "b"] }]);
});

test("notes are capped in length and count", () => {
  const notes = {};
  for (let i = 1; i <= 20005; i++) notes[`ABC-${i}`] = "x";
  assert.equal(Object.keys(sanitizeProfile({ version: 1, notes }).notes).length, 20000);
  assert.equal(sanitizeProfile({ version: 1, notes: { "ABC-1": "y".repeat(9000) } }).notes["ABC-1"].length, 5000);
});

test("merge notes keeps current notes and settings, adds missing ones", () => {
  const current = { ...defaultProfile(), name: "mine", notes: { "A-1": "mine" } };
  const incoming = { ...defaultProfile(), name: "theirs", notes: { "A-1": "theirs", "A-2": "new" } };
  const merged = mergeNotes(current, incoming);
  assert.equal(merged.name, "mine");
  assert.deepEqual(merged.notes, { "A-1": "mine", "A-2": "new" });
});

// ---- table payload --------------------------------------------------------

const columns = [{ id: "issuekey", name: "Key" }, { id: "status", name: "Status" }];
const mk = (key, status) => ({ key, status, cells: { issuekey: key, status } });
const entries = [{ row: mk("A-2", "Done"), groupPath: ["g1"] }, { row: mk("A-1", "Open"), groupPath: ["g1", "sub"] }];
const colorFor = (row) => ({ Done: "#D5F5E3", Open: null })[row.status] ?? null;
const base = { columns, entries, notes: { "A-1": "ok" }, showNote: true, colorFor, statusColId: "status", grouped: false };

test("payload has STT renumbered, selected rows only, order kept, note column last", () => {
  const p = buildTablePayload({ ...base, colorScope: "row" });
  assert.deepEqual(p.headers, ["STT", "Key", "Status", "Ghi chú"]);
  assert.deepEqual(p.rows, [["1", "A-2", "Done", ""], ["2", "A-1", "Open", "ok"]]);
});

test("row scope colours every cell; cell scope only the status cell", () => {
  const row = buildTablePayload({ ...base, colorScope: "row" });
  assert.deepEqual(row.fills[0], ["#D5F5E3", "#D5F5E3", "#D5F5E3", "#D5F5E3"]);
  assert.deepEqual(row.fills[1], [null, null, null, null]);
  const cell = buildTablePayload({ ...base, colorScope: "cell" });
  assert.deepEqual(cell.fills[0], [null, null, "#D5F5E3", null]);
});

test("cell scope with the status column hidden colours nothing", () => {
  const p = buildTablePayload({ ...base, columns: [columns[0]], colorScope: "cell" });
  assert.deepEqual(p.fills[0], [null, null, null]);
});

test("grouped payload adds a Nhóm column and shifts the colour offset", () => {
  const p = buildTablePayload({ ...base, grouped: true, colorScope: "cell" });
  assert.deepEqual(p.headers, ["STT", "Nhóm", "Key", "Status", "Ghi chú"]);
  assert.deepEqual(p.rows[1], ["2", "g1 / sub", "A-1", "Open", "ok"]);
  assert.equal(p.fills[0][3], "#D5F5E3");
});

test("note column can be switched off", () => {
  const p = buildTablePayload({ ...base, showNote: false, colorScope: "row" });
  assert.deepEqual(p.headers, ["STT", "Key", "Status"]);
  assert.equal(p.rows[0].length, 3);
});

test("no rows selected gives an empty payload", () => {
  const p = buildTablePayload({ ...base, entries: [], colorScope: "row" });
  assert.deepEqual([p.rows, p.fills], [[], []]);
});

test("TSV flattens tabs and newlines inside cells", () => {
  const tsv = payloadToTsv({ headers: ["a", "b"], rows: [["x\ty", "l1\nl2"]] });
  assert.equal(tsv, "a\tb\nx y\tl1 l2");
});

test("HTML carries inline colours, contrasting text and escapes content", () => {
  const html = payloadToHtml({ headers: ["<h>"], rows: [["<b>&\"x"], ["plain"]], fills: [["#1F3A5F"], [null]] });
  assert.match(html, /&lt;h&gt;/);
  assert.match(html, /background-color:#1F3A5F;color:#FFFFFF;/);
  assert.match(html, /&lt;b&gt;&amp;&quot;x/);
  assert.doesNotMatch(html, /<b>/);
  assert.equal((html.match(/background-color/g) || []).length, 1);
});

// ---- saved filters --------------------------------------------------------

test("saved filters survive a round trip", () => {
  const p = defaultProfile();
  p.filters.projects = [{ value: "VTP2601", label: "VTP2601 – F2C" }];
  p.filters.assignees = [{ value: "g:backend", label: "👥 backend (nhóm)" }, { value: "u:an", label: "An" }];
  p.filters.created_from = "2026-01-01";
  p.filters.jqlMode = true;
  p.filters.jqlText = "project = X";
  const back = parseProfileText(serializeProfile(p));
  assert.deepEqual(back.filters, p.filters);
});

test("a profile without filters (older file) gets empty ones", () => {
  assert.deepEqual(sanitizeProfile({ version: 1 }).filters, emptyFilters());
});

test("saved filters are sanitised", () => {
  const f = sanitizeProfile({ version: 1, filters: {
    projects: [{ value: "A", label: "x".repeat(900) }, { value: "" }, "junk", { value: 5 }, { value: "B" }],
    labels: "not a list",
    created_from: "2026-13-xx", created_to: "2026-02-03", updated_from: 20260101,
    jqlMode: "yes", jqlText: "y".repeat(9000),
  } }).filters;
  assert.deepEqual(f.projects.map((o) => o.value), ["A", "B"]);
  assert.equal(f.projects[0].label.length, 300);
  assert.equal(f.projects[1].label, "B");
  assert.deepEqual(f.labels, []);
  assert.deepEqual([f.created_from, f.created_to, f.updated_from], ["", "2026-02-03", ""]);
  assert.equal(f.jqlMode, false);
  assert.equal(f.jqlText.length, 5000);
});

test("page sizes outside the offered list fall back to the default", () => {
  assert.equal(sanitizeProfile({ version: 1, ui: { pageSize: 20 } }).ui.pageSize, 20);
  assert.equal(sanitizeProfile({ version: 1, ui: { pageSize: 77 } }).ui.pageSize, 100);
});
