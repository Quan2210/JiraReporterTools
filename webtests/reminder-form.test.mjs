import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REMINDER_TEMPLATE, buildCore, buildPayload, defaultRunAt, duplicateDraft, queryChips, queryText, queryWarnings, reminderActions,
  reminderQuery, runStatusText, scheduleSummary, scheduleText, stateText, testPayload,
} from "../static/js/lib/reminder-form.js";
import { MAX_DATE_OFFSET_DAYS, isDateToken, makeDateToken, parseDateToken, tokenLabel } from "../static/js/lib/dates.js";
import { parseProfileText, sanitizeProfile, defaultProfile } from "../static/js/lib/profile.js";

const base = { name: " Daily ", query: { jql: "project = ABC", columns: ["issuekey"] }, days: [4, 0, 0], time: "09:00", maxLines: "30" };

test("reminderQuery keeps filters and adds the minimal columns", () => {
  assert.deepEqual(reminderQuery({ jql: "x" }), { jql: "x", columns: ["issuekey", "summary", "status"] });
});

test("payload is normalised: trimmed name, sorted unique days, default template, null chat for slack", () => {
  const p = buildPayload({ ...base, channel: "slack", chatId: "123" });
  assert.equal(p.name, "Daily");
  assert.deepEqual(p.days, [0, 4]);
  assert.equal(p.template, DEFAULT_REMINDER_TEMPLATE);
  assert.equal(p.telegram_chat_id, null);
  assert.equal(p.condition, "always");
  assert.equal(p.max_lines, 30);
  assert.equal(p.enabled, true);
});

test("telegram needs a numeric chat id", () => {
  assert.equal(buildPayload({ ...base, channel: "telegram", chatId: "-100123" }).telegram_chat_id, "-100123");
  assert.throws(() => buildPayload({ ...base, channel: "telegram", chatId: "abc" }), /chat_id/);
  assert.throws(() => buildPayload({ ...base, channel: "telegram", chatId: "" }), /chat_id/);
});

test("validation errors", () => {
  assert.throws(() => buildPayload({ ...base, name: "  " }), /tên/);
  assert.throws(() => buildPayload({ ...base, days: [] }), /ngày/);
  assert.throws(() => buildPayload({ ...base, days: [9] }), /ngày/);
  assert.throws(() => buildPayload({ ...base, time: "" }), /giờ/);
  assert.throws(() => buildPayload({ ...base, time: "25:00" }), /giờ/);
  assert.throws(() => buildPayload({ ...base, query: null }), /bộ lọc/);
  assert.throws(() => buildPayload({ ...base, maxLines: "0" }), /1 đến 100/);
  assert.throws(() => buildPayload({ ...base, maxLines: "101" }), /1 đến 100/);
});

test("schedule text", () => {
  assert.equal(scheduleText([0, 1, 2, 3, 4], "09:00"), "T2–T6 lúc 09:00");
  assert.equal(scheduleText([0, 1, 2, 3, 4, 5, 6], "08:30"), "Hằng ngày lúc 08:30");
  assert.equal(scheduleText([6, 2], "17:00"), "T4, CN lúc 17:00");
});

test("warnings for fixed dates and sprints, none for JQL", () => {
  assert.equal(queryWarnings({ jql: "created >= -7d" }).length, 0);
  assert.equal(queryWarnings({ projects: ["A"], created_from: "2026-01-01" }).length, 1);
  assert.equal(queryWarnings({ sprints: [7], created_to: "2026-01-02" }).length, 2);
  assert.equal(queryWarnings({ projects: ["A"], sprints: [] }).length, 0);
});

test("query summary and run status labels", () => {
  assert.equal(queryText({ projects: ["ABC"], statuses: ["Open", "Done"] }), "Project: ABC · Status: Open, Done");
  assert.equal(queryText({ jql: "x" }), "JQL: x");
  assert.equal(queryText({ projects: [] }), "Không có điều kiện lọc");
  assert.equal(runStatusText("missed"), "Lỡ giờ");
  assert.equal(runStatusText("zzz"), "zzz");
});

const NOW = new Date(2026, 10, 4, 10, 0, 0);          // 04/11/2026 10:00 local

test("weekly payload carries schedule_kind and no run_at", () => {
  const p = buildPayload({ ...base, channel: "slack" }, NOW);
  assert.equal(p.schedule_kind, "weekly");
  assert.equal(p.run_at, null);
});

test("one-time payload: date + time become run_at, days are empty", () => {
  const p = buildPayload({ ...base, channel: "slack", scheduleKind: "once", runDate: "2026-11-05", time: "09:30", days: [] }, NOW);
  assert.deepEqual([p.schedule_kind, p.run_at, p.time, p.days], ["once", "2026-11-05T09:30", "09:30", []]);
  assert.throws(() => buildPayload({ ...base, scheduleKind: "once", runDate: "", time: "09:30" }, NOW), /ngày gửi/);
  assert.throws(() => buildPayload({ ...base, scheduleKind: "once", runDate: "2026-11-05", time: "" }, NOW), /giờ/);
  assert.throws(() => buildPayload({ ...base, scheduleKind: "once", runDate: "05/11/2026", time: "09:30" }, NOW), /ngày gửi/);
  assert.throws(() => buildPayload({ ...base, scheduleKind: "once", runDate: "2026-11-04", time: "09:59" }, NOW), /đã qua/);
  assert.equal(buildPayload({ ...base, scheduleKind: "once", runDate: "2026-11-04", time: "10:01" }, NOW).run_at, "2026-11-04T10:01");
});

test("default one-time moment is the next whole hour", () => {
  assert.deepEqual(defaultRunAt(NOW), { date: "2026-11-04", time: "11:00" });
  assert.deepEqual(defaultRunAt(new Date(2026, 11, 31, 23, 30)), { date: "2027-01-01", time: "00:00" });
});

test("schedule summary for both kinds", () => {
  assert.equal(scheduleSummary({ schedule_kind: "weekly", days: [0, 1, 2, 3, 4], time: "09:00" }), "T2–T6 lúc 09:00");
  assert.equal(scheduleSummary({ schedule_kind: "once", run_at: "2026-11-05T09:30" }), "Một lần 05/11/2026 lúc 09:30");
});

test("state text and actions depend on the state", () => {
  assert.deepEqual(["active", "off", "done"].map(stateText), ["Đang bật", "Tắt", "Đã xong"]);
  const ids = reminderActions({ state: "active", enabled: true }).map((a) => a.id);
  assert.deepEqual(ids, ["detail", "edit", "test", "toggle", "duplicate", "history", "delete"]);
  assert.equal(reminderActions({ state: "active", enabled: true }).find((a) => a.id === "toggle").label, "Tắt");
  assert.equal(reminderActions({ state: "off", enabled: false }).find((a) => a.id === "toggle").label, "Bật");
  const done = reminderActions({ state: "done", enabled: false }).find((a) => a.id === "toggle");
  assert.equal(done.disabled, true);
  assert.match(done.title, /Sửa/);
});

test("duplicate is a new, disabled copy; a one-time copy gets a fresh time", () => {
  const copy = duplicateDraft({ id: 7, name: "Daily", enabled: true, schedule_kind: "weekly", days: [0], time: "09:00" }, NOW);
  assert.deepEqual([copy.id, copy.name, copy.enabled], [null, "Daily (bản sao)", false]);
  const once = duplicateDraft({ id: 8, name: "x".repeat(100), enabled: false, schedule_kind: "once", run_at: "2020-01-01T09:00", time: "09:00" }, NOW);
  assert.equal(once.run_at, "2026-11-04T11:00");
  assert.equal(once.name.length, 100);
});

test("test payload has no schedule fields", () => {
  const body = buildPayload({ ...base, channel: "telegram", chatId: "5" }, NOW);
  assert.deepEqual(Object.keys(testPayload(body)).sort(),
    ["channel", "condition", "max_lines", "name", "query", "telegram_chat_id", "template", "title"]);
});

test("date tokens: parse, build, limits", () => {
  assert.equal(MAX_DATE_OFFSET_DAYS, 3660);
  assert.deepEqual(parseDateToken("today"), { sign: "", days: 0 });
  assert.deepEqual(parseDateToken("today-7"), { sign: "-", days: 7 });
  assert.deepEqual(parseDateToken("today+3"), { sign: "+", days: 3 });
  assert.deepEqual(parseDateToken("today+3660"), { sign: "+", days: 3660 });
  for (const bad of ["today-3661", "today+9999", "today-", "today+x", "Today", "tomorrow", "", null, "2026-01-01", "today--1"]) {
    assert.equal(parseDateToken(bad), null, String(bad));
  }
  assert.equal(makeDateToken("-", 7), "today-7");
  assert.equal(makeDateToken("+", 0), "today");
  assert.equal(makeDateToken("", 5), "today");
  assert.equal(makeDateToken("-", 99999), "today-3660");
  assert.equal(isDateToken("today-1"), true);
  assert.equal(isDateToken("2026-01-01"), false);
  assert.equal(tokenLabel("today"), "hôm nay");
  assert.equal(tokenLabel("today-7"), "hôm nay − 7 ngày");
  assert.equal(tokenLabel("today+2"), "hôm nay + 2 ngày");
});

test("tokens are not 'fixed date' warnings and show up in the query summary", () => {
  assert.equal(queryWarnings({ projects: ["A"], created_from: "today-7", created_to: "today" }).length, 0);
  assert.equal(queryWarnings({ projects: ["A"], created_from: "today-7", updated_to: "2026-01-01" }).length, 1);
  assert.equal(queryText({ projects: ["A"], created_from: "today-7", created_to: "today" }), "Project: A · Ngày tạo: hôm nay − 7 ngày → hôm nay");
  assert.equal(queryText({ updated_from: "2026-01-02" }), "Ngày cập nhật: 02/01/2026 → …");
});

test("profile keeps valid date tokens and drops invalid ones", () => {
  const profile = { ...defaultProfile(), filters: { ...defaultProfile().filters,
    created_from: "today-7", created_to: "today", updated_from: "today-3661", updated_to: "tomorrow" } };
  const clean = sanitizeProfile(JSON.parse(JSON.stringify(profile)));
  assert.deepEqual([clean.filters.created_from, clean.filters.created_to], ["today-7", "today"]);
  assert.deepEqual([clean.filters.updated_from, clean.filters.updated_to], ["", ""]);
  assert.equal(parseProfileText(JSON.stringify({ ...profile, filters: { ...profile.filters, created_from: "2026-01-01" } })).filters.created_from, "2026-01-01");
});

test("buildCore validates only the schedule-free part", async () => {
  const { reminderBody } = await import("../static/js/lib/reminder-form.js");
  const core = buildCore({ name: "T", query: { jql: "x" }, channel: "slack", maxLines: "5" });
  assert.deepEqual(Object.keys(core).sort(), ["channel", "condition", "max_lines", "name", "query", "telegram_chat_id", "template", "title"]);
  assert.throws(() => buildCore({ name: "", query: { jql: "x" }, channel: "slack", maxLines: "5" }), /tên/);
  assert.throws(() => buildCore({ name: "T", query: { jql: "x" }, channel: "telegram", chatId: "no", maxLines: "5" }), /chat_id/);
  const r = { name: "N", enabled: true, query: {}, template: "t", channel: "slack", telegram_chat_id: null, schedule_kind: "once",
    run_at: "2026-11-05T09:00", days: [], time: "09:00", condition: "always", max_lines: 30, state: "active", next_run: "x", id: 3 };
  const body = reminderBody(r, { enabled: false });
  assert.equal(body.enabled, false);
  assert.equal("id" in body || "state" in body || "next_run" in body, false);
});

test("queryChips splits a query into short labels; JQL stays one block", () => {
  assert.deepEqual(queryChips({ jql: "project = A" }), { jql: "project = A", chips: [] });
  const { jql, chips } = queryChips({ projects: ["A"], statuses: ["Open"], created_from: "today-7", sprints: [1, 2] });
  assert.equal(jql, null);
  assert.deepEqual(chips, ["Project: A", "Status: Open", "2 sprint", "Ngày tạo: hôm nay − 7 ngày → …"]);
  assert.deepEqual(queryChips(null), { jql: null, chips: [] });
  assert.deepEqual(queryChips({ projects: [] }).chips, []);
});

test("every action has an icon and only delete is dangerous", () => {
  const actions = reminderActions({ state: "active", enabled: true });
  assert.ok(actions.every((a) => typeof a.icon === "string" && a.icon));
  assert.deepEqual(actions.filter((a) => a.danger).map((a) => a.id), ["delete"]);
});

test("tokenShort is the one-line label of a dynamic date", async () => {
  const { tokenShort } = await import("../static/js/lib/dates.js");
  assert.equal(tokenShort("today"), "Hôm nay");
  assert.equal(tokenShort("today-7"), "−7 ngày");
  assert.equal(tokenShort("today+3"), "+3 ngày");
  assert.equal(tokenShort("2026-01-01"), "2026-01-01");
});

test("template variables: built-ins first, Jira fields after, no duplicates", async () => {
  const { templateVariables, TITLE_VARIABLES } = await import("../static/js/lib/reminder-form.js");
  const vars = templateVariables([
    { id: "issuekey", name: "Key" }, { id: "summary", name: "Summary" }, { id: "status", name: "Status" },
    { id: "assignee", name: "Assignee" }, { id: "customfield_10111", name: "Story Points", custom: true }, { id: "assignee", name: "dup" },
    { id: "bad id", name: "x" }, null,
  ]);
  assert.deepEqual(vars.map((v) => v.id), ["key", "summary", "status", "url", "assignee", "customfield_10111"]);
  assert.equal(vars.find((v) => v.id === "customfield_10111").hint, "custom");
  assert.deepEqual(TITLE_VARIABLES.map((v) => v.id), ["name", "count", "date"]);
});

test("filterVariables matches id or label, ignoring case and accents, best match first", async () => {
  const { filterVariables } = await import("../static/js/lib/reminder-form.js");
  const options = [{ id: "key", label: "Mã issue" }, { id: "summary", label: "Tiêu đề issue" }, { id: "assignee", label: "Người xử lý" },
    { id: "customfield_1", label: "Story Points" }, { id: "created", label: "Ngày tạo" }];
  assert.deepEqual(filterVariables(options, "").length, 5);
  assert.deepEqual(filterVariables(options, "AS").map((o) => o.id), ["assignee"]);
  assert.deepEqual(filterVariables(options, "ngay").map((o) => o.id), ["created"]);
  assert.deepEqual(filterVariables(options, "nguoi").map((o) => o.id), ["assignee"]);
  assert.deepEqual(filterVariables(options, "issue").map((o) => o.id), ["key", "summary"]);
  assert.deepEqual(filterVariables(options, "zzz"), []);
  assert.equal(filterVariables(options, "", 2).length, 2);
});

test("varTokenAt finds the placeholder being typed before the caret", async () => {
  const { varTokenAt } = await import("../static/js/lib/reminder-form.js");
  assert.deepEqual(varTokenAt("{", 1), { start: 0, query: "" });
  assert.deepEqual(varTokenAt("a {ke", 5), { start: 2, query: "ke" });
  assert.deepEqual(varTokenAt("{key}: {su", 10), { start: 7, query: "su" });
  assert.equal(varTokenAt("{key}", 5), null);                  // closed
  assert.equal(varTokenAt("abc", 3), null);
  assert.equal(varTokenAt("{a b", 4), null);                   // a space ends the token
  assert.deepEqual(varTokenAt("x{ab}y", 4), { start: 1, query: "ab" });   // caret inside a placeholder
});

test("completeVariable and insertVariable put {id} where the caret is", async () => {
  const { completeVariable, insertVariable, varTokenAt } = await import("../static/js/lib/reminder-form.js");
  let r = completeVariable("{ke", 3, varTokenAt("{ke", 3), "key");
  assert.deepEqual(r, { text: "{key}", caret: 5 });
  r = completeVariable("a {su} b", 5, varTokenAt("a {su} b", 5), "summary");     // caret inside: swallows the old tail
  assert.deepEqual(r, { text: "a {summary} b", caret: 11 });
  r = completeVariable("{ke: {url}", 3, varTokenAt("{ke: {url}", 3), "key");
  assert.equal(r.text, "{key}: {url}");
  assert.deepEqual(insertVariable("ab", 1, 1, "key"), { text: "a{key}b", caret: 6 });
  assert.deepEqual(insertVariable("abcd", 1, 3, "x"), { text: "a{x}d", caret: 4 });
  assert.deepEqual(insertVariable("ab", undefined, undefined, "k"), { text: "ab{k}", caret: 5 });
  assert.deepEqual(insertVariable("ab", 99, 99, "k"), { text: "ab{k}", caret: 5 });
});

test("title is part of the core payload and trims to null", () => {
  const core = buildCore({ name: "T", query: { jql: "x" }, channel: "slack", maxLines: "5", title: "  {name} {count}  " });
  assert.equal(core.title, "{name} {count}");
  assert.equal(buildCore({ name: "T", query: { jql: "x" }, channel: "slack", maxLines: "5", title: "  " }).title, null);
  assert.equal(testPayload({ ...core, extra: 1 }).title, "{name} {count}");
});
