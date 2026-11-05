// Pure helpers for the reminders tab (unit-tested in webtests/reminder-form.test.mjs).

import { isDateToken, isoToDisplay, tokenLabel } from "./dates.js";

export const DAY_LABELS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];   // index = weekday, Monday = 0 (same as the API)
export const REMINDER_COLUMNS = ["issuekey", "summary", "status"];
export const DEFAULT_REMINDER_TEMPLATE = "{key}: {summary} [{status}] {url}";

const ID_RE = /^[A-Za-z0-9_.\-]{1,100}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;
const DATE_PAIRS = [["created_from", "created_to", "tạo"], ["updated_from", "updated_to", "cập nhật"]];

/** The saved query: the current filters plus the few columns a reminder needs. */
export function reminderQuery(filterQuery) {
  return { ...filterQuery, columns: REMINDER_COLUMNS };
}

const isFixedDate = (value) => typeof value === "string" && value !== "" && !isDateToken(value);

/** Things that make a recurring reminder go stale: fixed dates / fixed sprints instead of dynamic dates or relative JQL. */
export function queryWarnings(query) {
  if (!query || query.jql) return [];
  const warnings = [];
  if (DATE_PAIRS.some(([from, to]) => isFixedDate(query[from]) || isFixedDate(query[to]))) {
    warnings.push("Bộ lọc có ngày cố định nên kết quả sẽ không trượt theo thời gian. Muốn ngày tự đổi mỗi lần chạy, hãy dùng \"ngày động\" (nút ⟳ cạnh ô ngày) hoặc chế độ JQL.");
  }
  if (Array.isArray(query.sprints) && query.sprints.length) {
    warnings.push("Bộ lọc chọn sprint cố định. Muốn luôn lấy sprint đang chạy, hãy dùng JQL với openSprints().");
  }
  return warnings;
}

export function scheduleText(days, time) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  let label;
  if (sorted.length === 7) label = "Hằng ngày";
  else if (sorted.join() === "0,1,2,3,4") label = "T2–T6";
  else label = sorted.map((d) => DAY_LABELS[d]).join(", ");
  return `${label} lúc ${time}`;
}

/** "T2–T6 lúc 09:00" or "Một lần 05/11/2026 lúc 09:00". */
export function scheduleSummary(reminder) {
  if (reminder.schedule_kind === "once" && reminder.run_at) {
    const [date, time] = reminder.run_at.split("T");
    return `Một lần ${isoToDisplay(date)} lúc ${time}`;
  }
  return scheduleText(reminder.days ?? [], reminder.time ?? "");
}

const dateLabel = (value) => (isDateToken(value) ? tokenLabel(value) : isoToDisplay(value));

/** A saved query as {jql, chips}: JQL text for a JQL query, otherwise short labels for each active filter. */
export function queryChips(query) {
  if (!query) return { jql: null, chips: [] };
  if (query.jql) return { jql: query.jql, chips: [] };
  const chips = [];
  for (const [key, label] of [["projects", "Project"], ["statuses", "Status"], ["labels", "Label"], ["assignees", "Assignee"], ["reporters", "Reporter"], ["issue_types", "Loại"]]) {
    if (Array.isArray(query[key]) && query[key].length) chips.push(`${label}: ${query[key].join(", ")}`);
  }
  if (query.sprints?.length) chips.push(`${query.sprints.length} sprint`);
  if (query.custom_filters?.length) chips.push(`${query.custom_filters.length} bộ lọc field`);
  for (const [from, to, label] of DATE_PAIRS) {
    if (query[from] || query[to]) chips.push(`Ngày ${label}: ${query[from] ? dateLabel(query[from]) : "…"} → ${query[to] ? dateLabel(query[to]) : "…"}`);
  }
  return { jql: null, chips };
}

export function queryText(query) {
  if (!query) return "";
  const { jql, chips } = queryChips(query);
  if (jql) return `JQL: ${jql}`;
  return chips.join(" · ") || "Không có điều kiện lọc";
}

const pad = (n) => String(n).padStart(2, "0");

/** Default for a new one-time reminder: the next whole hour from now, as local {date: "YYYY-MM-DD", time: "HH:00"}. */
export function defaultRunAt(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0);
  return { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, time: `${pad(next.getHours())}:00` };
}

// ---- send conditions, note rules, grouping ------------------------------------------------------------------------

export const MAX_RULES = 20;
export const CONDITIONS = [
  { id: "always", label: "Luôn gửi" },
  { id: "only_if_results", label: "Khi có issue" },
  { id: "min_count", label: "Từ N issue trở lên" },
  { id: "if_changed", label: "Khi danh sách thay đổi" },
  { id: "if_rule", label: "Khi có issue khớp quy tắc" },
];
export const RULE_OPS = [
  { id: "in", label: "là" }, { id: "not_in", label: "không phải" }, { id: "contains", label: "chứa" },
  { id: "empty", label: "trống" }, { id: "not_empty", label: "có giá trị" },
];
export const RULE_ACTIONS = [{ id: "note", label: "Ghi chú" }, { id: "hide", label: "Ẩn dòng" }];
const NO_VALUE_OPS = new Set(["empty", "not_empty"]);

export const newRule = (field = "status") => ({ field, op: "in", values: [], action: "note", text: "" });

/** "Done, Closed" -> ["Done", "Closed"] (comma, semicolon or newline separated). */
export const splitValues = (text) => String(text ?? "").split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

/** Validate and clean the rules the form holds. Throws Error "Quy tắc N: ..." for the first bad one. */
export function normalizeRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length > MAX_RULES) throw new Error(`Tối đa ${MAX_RULES} quy tắc.`);
  return list.map((r, i) => {
    const at = `Quy tắc ${i + 1}`;
    if (!ID_RE.test(r?.field ?? "")) throw new Error(`${at}: hãy chọn field.`);
    if (!RULE_OPS.some((o) => o.id === r.op)) throw new Error(`${at}: hãy chọn phép so sánh.`);
    const action = r.action === "hide" ? "hide" : "note";
    const values = NO_VALUE_OPS.has(r.op) ? [] : (Array.isArray(r.values) ? r.values : splitValues(r.values)).map((v) => String(v).trim()).filter(Boolean);
    if (!NO_VALUE_OPS.has(r.op) && !values.length) throw new Error(`${at}: hãy nhập giá trị so sánh.`);
    if (values.some((v) => v.length > 255) || values.length > 20) throw new Error(`${at}: giá trị quá dài hoặc quá nhiều.`);
    const text = action === "hide" ? "" : String(r.text ?? "").trim();
    if (text.length > 200) throw new Error(`${at}: ghi chú tối đa 200 ký tự.`);
    return { field: r.field, op: r.op, values: r.op === "contains" ? values.slice(0, 1) : values, action, text };
  });
}

/** One-line description of a rule, e.g. `Status là Done → "Done pilot"`. */
export function ruleSummary(rule, fieldName = rule.field) {
  const op = RULE_OPS.find((o) => o.id === rule.op)?.label ?? rule.op;
  const when = `${fieldName} ${op}${rule.values?.length ? ` ${rule.values.join(" / ")}` : ""}`;
  return `${when} → ${rule.action === "hide" ? "ẩn dòng" : `"${rule.text}"`}`;
}

export function conditionText(reminder) {
  const base = CONDITIONS.find((c) => c.id === reminder.condition)?.label ?? "Luôn gửi";
  return reminder.condition === "min_count" ? `Từ ${reminder.min_count} issue trở lên` : base;
}

/** The schedule-free part of the form (what "send a test now" needs). Throws Error with a Vietnamese message. */
export function buildCore(f) {
  const name = String(f.name ?? "").trim();
  if (!name) throw new Error("Hãy đặt tên cho nhắc nhở.");
  if (name.length > 100) throw new Error("Tên nhắc nhở tối đa 100 ký tự.");
  if (!f.query) throw new Error("Chưa có bộ lọc: bấm \"Dùng bộ lọc hiện tại\".");
  const template = String(f.template ?? "").trim() || DEFAULT_REMINDER_TEMPLATE;
  if (template.length > 1000) throw new Error("Mẫu tin nhắn tối đa 1000 ký tự.");
  const maxLines = Number(f.maxLines);
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 100) throw new Error("Số dòng tối đa phải từ 1 đến 100.");
  const channel = f.channel === "telegram" ? "telegram" : "slack";
  const chatId = String(f.chatId ?? "").trim();
  if (channel === "telegram" && !CHAT_ID_RE.test(chatId)) throw new Error("Kênh Telegram cần chat_id (bấm \"Lấy chat_id\" sau khi nhắn bot).");
  const condition = CONDITIONS.some((c) => c.id === f.condition) ? f.condition : "always";
  const minCount = Number(f.minCount ?? 1);
  if (condition === "min_count" && (!Number.isInteger(minCount) || minCount < 1 || minCount > 1000)) throw new Error("Số issue tối thiểu phải từ 1 đến 1000.");
  const defaultNote = String(f.defaultNote ?? "").trim();
  if (defaultNote.length > 200) throw new Error("Ghi chú mặc định tối đa 200 ký tự.");
  const customMessage = String(f.customMessage ?? "");
  if (customMessage.length > 20000) throw new Error("Tin nhắn viết tay tối đa 20000 ký tự.");
  return {
    name, query: f.query, template, title: String(f.title ?? "").trim() || null, channel,
    telegram_chat_id: channel === "telegram" ? chatId : null,
    condition, min_count: condition === "min_count" ? minCount : 1, max_lines: maxLines,
    note_rules: normalizeRules(f.noteRules ?? []), default_note: defaultNote || null,
    group_by: f.groupBy || null, group_order: f.groupOrder === "count" ? "count" : "name",
    sort_by: f.sortBy || null, sort_dir: f.sortDir === "desc" ? "desc" : "asc",
    custom_message: customMessage.trim() ? customMessage : null,
  };
}

/** Form values -> API body. Throws Error with a Vietnamese message on invalid input. */
export function buildPayload(f, now = new Date()) {
  const body = { ...buildCore(f), enabled: f.enabled !== false };

  if (f.scheduleKind === "once") {
    if (!DATE_RE.test(f.runDate ?? "")) throw new Error("Hãy chọn ngày gửi.");
    if (!TIME_RE.test(f.time ?? "")) throw new Error("Hãy nhập giờ gửi.");
    const runAt = `${f.runDate}T${f.time}`;
    if (new Date(`${runAt}:00`) <= now && f.enabled !== false) throw new Error("Thời điểm gửi đã qua. Hãy chọn ngày giờ ở tương lai.");
    return { ...body, schedule_kind: "once", run_at: runAt, days: [], time: f.time };
  }
  const days = [...new Set(f.days ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!days.length) throw new Error("Hãy chọn ít nhất một ngày trong tuần.");
  if (!TIME_RE.test(f.time ?? "")) throw new Error("Hãy nhập giờ gửi.");
  return { ...body, schedule_kind: "weekly", run_at: null, days, time: f.time };
}

/** The part of a reminder that "send a test now" needs (no schedule). */
export function testPayload(body) {
  const { name, query, template, title, channel, telegram_chat_id, condition, min_count, max_lines, note_rules, default_note,
    group_by, group_order, sort_by, sort_dir, custom_message } = body;
  return { name, query, template, title, channel, telegram_chat_id, condition, min_count, max_lines, note_rules, default_note,
    group_by, group_order, sort_by, sort_dir, custom_message };
}

const STATUS_TEXT = {
  sent: "Đã gửi", skipped_empty: "Bỏ qua (không có issue)", skipped_condition: "Bỏ qua (chưa đủ điều kiện)",
  skipped_unchanged: "Bỏ qua (danh sách không đổi)", failed: "Lỗi", missed: "Lỡ giờ", running: "Đang chạy",
};
export const runStatusText = (status) => STATUS_TEXT[status] ?? status;

const STATE_TEXT = { active: "Đang bật", off: "Tắt", done: "Đã xong" };
export const stateText = (state) => STATE_TEXT[state] ?? state;

/** Actions offered for a reminder (toolbar, context menu, keyboard): [{id, label, disabled?, title?}]. */
export function reminderActions(reminder) {
  const done = reminder.state === "done";
  return [
    { id: "detail", label: "Xem chi tiết", icon: "eye" },
    { id: "edit", label: "Sửa", icon: "edit" },
    { id: "test", label: "Gửi thử", icon: "send" },
    done
      ? { id: "toggle", label: "Bật", icon: "power", disabled: true, title: "Đã gửi xong. Sửa để đặt giờ mới rồi bật lại." }
      : { id: "toggle", label: reminder.enabled ? "Tắt" : "Bật", icon: "power" },
    { id: "duplicate", label: "Nhân bản", icon: "copy" },
    { id: "history", label: "Lịch sử", icon: "clock" },
    { id: "delete", label: "Xóa", icon: "trash", danger: true },
  ];
}

/** A copy to edit as a new reminder: no id, off, and a one-time reminder gets a fresh time. */
export function duplicateDraft(reminder, now = new Date()) {
  const draft = { ...reminder, id: null, name: `${reminder.name} (bản sao)`.slice(0, 100), enabled: false };
  if (draft.schedule_kind === "once") {
    const next = defaultRunAt(now);
    draft.run_at = `${next.date}T${next.time}`;
    draft.time = next.time;
  }
  return draft;
}

/** A saved reminder -> the body the API accepts (used to change one field, e.g. on/off). */
export function reminderBody(r, patch = {}) {
  return {
    name: r.name, enabled: r.enabled, query: r.query, template: r.template, title: r.title ?? null, channel: r.channel,
    telegram_chat_id: r.telegram_chat_id, schedule_kind: r.schedule_kind, run_at: r.run_at, days: r.days, time: r.time,
    condition: r.condition, min_count: r.min_count ?? 1, max_lines: r.max_lines, note_rules: r.note_rules ?? [],
    default_note: r.default_note ?? null, group_by: r.group_by ?? null, group_order: r.group_order ?? "name",
    sort_by: r.sort_by ?? null, sort_dir: r.sort_dir ?? "asc", custom_message: r.custom_message ?? null, ...patch,
  };
}

// ---- template variables ({key}, {assignee}, ...) -----------------------------------------------------------------

/** Variables every reminder row has, whatever the columns. */
export const TEMPLATE_BUILTINS = [
  { id: "key", label: "Mã issue" },
  { id: "summary", label: "Tiêu đề issue" },
  { id: "status", label: "Trạng thái" },
  { id: "url", label: "Link issue" },
];
/** Variables of the message title line. */
export const TITLE_VARIABLES = [
  { id: "name", label: "Tên nhắc nhở" },
  { id: "count", label: "Số issue" },
  { id: "date", label: "Ngày hôm nay (dd/MM/yyyy)" },
];
const COVERED_BY_BUILTINS = new Set(["issuekey", "summary", "status"]);

/** Built-ins plus every Jira field ({id, name, custom}) as a template variable: [{id, label, hint?}]. */
export function templateVariables(fields = []) {
  const seen = new Set(TEMPLATE_BUILTINS.map((v) => v.id));
  const out = TEMPLATE_BUILTINS.map((v) => ({ ...v }));
  for (const f of fields) {
    if (!f || typeof f.id !== "string" || seen.has(f.id) || COVERED_BY_BUILTINS.has(f.id) || !/^\w+$/.test(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, label: f.name || f.id, hint: f.custom ? "custom" : "" });
  }
  return out;
}

const fold = (text) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").toLowerCase();

/** Options whose id or label contains `query` (accent- and case-insensitive); ids that start with it come first. */
export function filterVariables(options, query = "", limit = 50) {
  const q = fold(query);
  if (!q) return options.slice(0, limit);
  const scored = [];
  for (const option of options) {
    const id = fold(option.id);
    const label = fold(option.label);
    if (id.startsWith(q)) scored.push([0, option]);
    else if (label.startsWith(q) || id.includes(q)) scored.push([1, option]);
    else if (label.includes(q)) scored.push([2, option]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, option]) => option);
}

/** The "{par" being typed right before the caret: {start, query} or null. */
export function varTokenAt(text, caret) {
  const m = /\{(\w*)$/.exec(String(text ?? "").slice(0, caret));
  return m ? { start: m.index, query: m[1] } : null;
}

/** Replace the typed "{par" (plus a following "tial}" if the caret sits inside a placeholder) with "{id}". */
export function completeVariable(text, caret, token, id) {
  const rest = text.slice(caret);
  const tail = /^\w*\}/.exec(rest);
  const next = `${text.slice(0, token.start)}{${id}}${tail ? rest.slice(tail[0].length) : rest}`;
  return { text: next, caret: token.start + id.length + 2 };
}

/** Insert "{id}" at the caret / over the selection. */
export function insertVariable(text, start, end, id) {
  const from = Math.max(0, Math.min(start ?? text.length, text.length));
  const to = Math.max(from, Math.min(end ?? from, text.length));
  return { text: `${text.slice(0, from)}{${id}}${text.slice(to)}`, caret: from + id.length + 2 };
}
