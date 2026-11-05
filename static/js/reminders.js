import { api, getJson, postJson } from "./api.js";
import { createDateField } from "./datefield.js";
import { $, choose, el, setMsg } from "./dom.js";
import { iconSvg } from "./icons.js";
import { meta } from "./meta.js";
import { MultiSelect } from "./multiselect.js";
import { attachVarPicker, varButton } from "./varpicker.js";
import { isoToDisplay } from "./lib/dates.js";
import {
  DAY_LABELS, DEFAULT_REMINDER_TEMPLATE, buildCore, buildPayload, defaultRunAt, duplicateDraft, queryChips, queryWarnings,
  reminderActions, reminderBody, reminderQuery, runStatusText, scheduleSummary, stateText, templateVariables, TITLE_VARIABLES,
  CONDITIONS, MAX_RULES, RULE_ACTIONS, RULE_OPS, conditionText, newRule, ruleSummary, splitValues,
} from "./lib/reminder-form.js";

const putJson = (path, body) => api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const CHANNEL_NAMES = { slack: "Slack", telegram: "Telegram" };
const shortTime = (iso) => (iso ? isoToDisplay(iso) : "");

const icon = (name) => el("span", { class: "ico", innerHTML: iconSvg(name) });

/** Icon-only button; the tooltip doubles as the accessible name. */
function iconButton(name, label, onclick, { disabled = false, title = "", danger = false } = {}) {
  return el("button", {
    type: "button", class: `btn btn-icon${danger ? " btn-danger" : ""}`, title: title || label, "aria-label": label, disabled, onclick,
  }, icon(name));
}

/**
 * The "Nhắc nhở" tab: a table of reminder jobs with a checkbox and number per row.
 * Click selects the current row; double-click / Enter = details; right-click / Menu key = actions; Space or the
 * checkbox ticks a row for bulk delete.
 * getQuery() returns the current sidebar filters (throws if invalid); activeCount() how many filters are set.
 */
export function createReminders({ getQuery, activeCount }) {
  let channels = { slack: { configured: false }, telegram: { configured: false } };
  let reminders = [];
  let selectedId = null;                    // the "current" row (toolbar, menu, Enter)
  const checked = new Set();                // ticked rows (bulk delete)
  let lastTicked = null;                    // for shift-click ranges
  let editing = null;                       // { id: number|null, query }

  const selected = () => reminders.find((r) => r.id === selectedId) ?? null;
  const byId = (id) => reminders.find((r) => r.id === id) ?? null;

  // ---- list -------------------------------------------------------------------

  async function refresh() {
    try {
      channels = await getJson("/api/channels");
      reminders = (await getJson("/api/reminders")).reminders;
    } catch (e) {
      setMsg(e.message, "err");
      return;
    }
    for (const id of [...checked]) if (!byId(id)) checked.delete(id);
    if (!byId(selectedId)) selectedId = reminders[0]?.id ?? null;
    render();
  }

  function renderChannels() {
    $("rem-channels").replaceChildren(...Object.entries(CHANNEL_NAMES).map(([key, name]) => {
      const ok = channels[key]?.configured;
      return el("span", { title: ok ? `${name}: đã cấu hình` : `${name}: chưa cấu hình trong .env` },
        el("span", { class: `dot${ok ? " on" : ""}` }), name);
    }));
  }

  function render() {
    renderChannels();
    $("rem-empty").hidden = reminders.length > 0;
    $("rem-table-wrap").hidden = reminders.length === 0;

    const all = el("input", { type: "checkbox", "aria-label": "Chọn tất cả", title: "Chọn tất cả" });
    all.checked = reminders.length > 0 && checked.size === reminders.length;
    all.indeterminate = checked.size > 0 && checked.size < reminders.length;
    all.addEventListener("change", () => {
      checked.clear();
      if (all.checked) for (const r of reminders) checked.add(r.id);
      paintSelection();
    });
    const head = el("thead", {}, el("tr", {},
      el("th", { class: "c" }, all), el("th", { text: "#" }),
      ...["Tên", "Lịch", "Kênh", "Trạng thái", "Kế tiếp", "Gần nhất"].map((t) => el("th", { text: t }))));

    const body = el("tbody", {}, ...reminders.map((r, i) => {
      const last = r.last_run;
      const lastText = last ? `${runStatusText(last.status)} · ${shortTime(last.started_at)}` : "—";
      const box = el("input", { type: "checkbox", "aria-label": `Chọn ${r.name}`, "data-tick": String(r.id) });
      box.checked = checked.has(r.id);
      return el("tr", { class: `${r.id === selectedId ? "sel" : ""}${r.enabled ? "" : " off"}`.trim(), "data-id": String(r.id), "aria-selected": String(r.id === selectedId) },
        el("td", { class: "c" }, box),
        el("td", { class: "n", text: String(i + 1) }),
        el("td", { class: "nm", text: r.name }),
        el("td", { text: scheduleSummary(r) }),
        el("td", { text: CHANNEL_NAMES[r.channel] ?? r.channel }),
        el("td", {}, el("span", { class: `rem-state ${r.state}`, text: stateText(r.state) })),
        el("td", { text: r.next_run ? shortTime(r.next_run) : "—" }),
        el("td", { class: last?.status === "failed" ? "err" : "", title: last?.error ?? "", text: lastText }));
    }));
    $("rem-table").replaceChildren(head, body);
    renderToolbar();
  }

  // ---- actions (toolbar, context menu and keyboard share these) -------------------

  function renderToolbar() {
    const r = selected();
    $("rem-actions").replaceChildren(...reminderActions(r ?? { state: "off", enabled: false }).map((a) =>
      iconButton(a.icon, a.label, () => perform(a.id, r), { disabled: !r || a.disabled, title: a.title ?? a.label, danger: a.danger })));
    const n = checked.size;
    $("rem-bulk").hidden = n === 0;
    $("rem-bulk").replaceChildren(
      el("span", { text: `${n} đã chọn` }),
      iconButton("trash", `Xóa ${n} nhắc nhở đã chọn`, () => removeMany([...checked]), { danger: true }),
      iconButton("close", "Bỏ chọn", () => { checked.clear(); paintSelection(); }));
  }

  async function perform(action, r) {
    if (!r) return;
    if (action === "detail") await showDetail(r);
    else if (action === "edit") openForm(r, r.query);
    else if (action === "test") await sendSaved(r);
    else if (action === "toggle") await save(r, { enabled: !r.enabled });
    else if (action === "duplicate") openForm(duplicateDraft(r), r.query);
    else if (action === "history") await showRuns(r);
    else if (action === "delete") await removeMany([r.id]);
  }

  async function save(r, patch) {
    try {
      await putJson(`/api/reminders/${r.id}`, reminderBody(r, patch));
    } catch (e) {
      setMsg(e.message, "err");
    }
    await refresh();
  }

  async function sendSaved(r) {
    setMsg("Đang gửi thử…");
    try {
      const out = await (await postJson(`/api/reminders/${r.id}/test`, {})).json();
      setMsg(out.status === "sent" ? "Đã gửi thử." : `Gửi thử thất bại: ${out.error ?? out.status}`, out.status === "sent" ? "ok" : "err");
    } catch (e) {
      setMsg(e.message, "err");
    }
    await refresh();
  }

  async function removeMany(ids) {
    const items = ids.map(byId).filter(Boolean);
    if (!items.length) return;
    const title = items.length === 1 ? `Xóa "${items[0].name}"?` : `Xóa ${items.length} nhắc nhở?`;
    const body = items.length === 1 ? [] : [el("ul", { class: "rem-runs" }, ...items.slice(0, 8).map((r) => el("li", { text: r.name })),
      items.length > 8 ? el("li", { text: `… và ${items.length - 8} nhắc nhở nữa` }) : null)];
    const answer = await choose(title, [...body, el("p", { class: "hint", text: "Lịch sử chạy cũng bị xóa. Không thể hoàn tác." })],
      [{ label: "Xóa", value: "yes", primary: true }, { label: "Hủy", value: "no" }]);
    if (answer !== "yes") return;
    let failed = 0;
    for (const r of items) {
      try { await api(`/api/reminders/${r.id}`, { method: "DELETE" }); checked.delete(r.id); } catch { failed += 1; }
    }
    setMsg(failed ? `Không xóa được ${failed} nhắc nhở.` : `Đã xóa ${items.length} nhắc nhở.`, failed ? "err" : "ok");
    await refresh();
  }

  async function showRuns(r) {
    try {
      const { runs } = await getJson(`/api/reminders/${r.id}/runs`);
      const body = runs.length
        ? [el("ul", { class: "rem-runs" }, ...runs.map((run) => el("li", {
          text: `${shortTime(run.started_at)} · ${run.kind === "manual" ? "gửi thử" : "theo lịch"} · ${runStatusText(run.status)}${run.row_count != null ? ` · ${run.row_count} issue` : ""}${run.error ? ` · ${run.error}` : ""}`,
        })))]
        : [el("p", { text: "Chưa có lần chạy nào (lịch sử quá hạn được dọn tự động)." })];
      await choose(`Lịch sử: ${r.name}`, body, [{ label: "Đóng", value: "close", primary: true }]);
    } catch (e) {
      setMsg(e.message, "err");
    }
  }

  // ---- details -------------------------------------------------------------------

  function fillFilter(node, query) {
    const { jql, chips } = queryChips(query);
    node.replaceChildren(...(jql ? [el("code", { text: jql })]
      : chips.length ? chips.map((c) => el("span", { class: "chip-i", text: c })) : [el("span", { class: "muted", text: "Không có điều kiện lọc" })]));
  }

  async function showDetail(r) {
    const dlg = $("dlg-reminder-detail");
    dlg.dataset.id = String(r.id);
    $("rd-title").textContent = r.name;
    $("rd-state").textContent = stateText(r.state);
    $("rd-state").className = `rem-state ${r.state}`;
    $("rd-schedule").textContent = scheduleSummary(r);
    $("rd-next").textContent = r.next_run ? `Kế tiếp: ${shortTime(r.next_run)}` : "Không có lần chạy kế tiếp";
    $("rd-channel").textContent = `${CHANNEL_NAMES[r.channel] ?? r.channel}${r.telegram_chat_id ? ` · ${r.telegram_chat_id}` : ""}`;
    $("rd-cond").textContent = `${conditionText(r)} · tối đa ${r.max_lines} dòng`;
    const nameOf = (id) => meta.fieldById[id]?.name ?? id;
    const notes = [
      ...(r.note_rules ?? []).map((rule) => ruleSummary(rule, nameOf(rule.field))),
      ...(r.default_note ? [`Còn lại → "${r.default_note}"`] : []),
      ...(r.group_by ? [`Nhóm theo ${nameOf(r.group_by)} (${r.group_order === "count" ? "nhiều issue trước" : "theo tên"})`] : []),
      ...(r.sort_by ? [`Sắp xếp theo ${nameOf(r.sort_by)} (${r.sort_dir === "desc" ? "giảm dần" : "tăng dần"})`] : []),
    ];
    $("rd-rules-card").hidden = notes.length === 0;
    $("rd-rules").replaceChildren(...notes.map((text) => el("li", { text })));
    $("rd-custom-card").hidden = !r.custom_message;
    $("rd-custom").textContent = r.custom_message ?? "";
    fillFilter($("rd-filter"), r.query);
    $("rd-template").textContent = `${r.title ? `${r.title}\n` : ""}${r.template}`;
    $("rd-runs").replaceChildren(el("li", { class: "muted", text: "Đang tải…" }));
    if (!dlg.open) dlg.showModal();
    try {
      const { runs } = await getJson(`/api/reminders/${r.id}/runs`);
      $("rd-runs").replaceChildren(...(runs.length ? runs.slice(0, 5).map((run) => el("li", {},
        el("span", { class: `st ${run.status}` }),
        el("span", { class: "t", text: shortTime(run.started_at) }),
        el("span", { class: "x", text: `${runStatusText(run.status)}${run.kind === "manual" ? " (thử)" : ""}${run.row_count != null ? ` · ${run.row_count} issue` : ""}${run.error ? ` · ${run.error}` : ""}` })))
        : [el("li", { class: "muted", text: "Chưa có lần chạy nào" })]));
    } catch {
      $("rd-runs").replaceChildren(el("li", { class: "muted", text: "Không tải được lịch sử" }));
    }
  }

  // ---- context menu ----------------------------------------------------------------

  const menu = $("rem-menu");
  let menuReturnFocus = null;
  let openedAt = 0;

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuReturnFocus?.focus?.({ preventScroll: true });
  }

  function menuItem(a, onclick) {
    return el("button", {
      type: "button", role: "menuitem", class: `menu-item${a.danger ? " danger" : ""}`, disabled: a.disabled, title: a.title ?? "",
      onclick: () => { closeMenu(); onclick(); },
    }, icon(a.icon), a.label);
  }

  function openMenu(r, x, y) {
    let items;
    if (checked.size > 1 && checked.has(r.id)) {              // right-click inside a multi-selection: bulk actions only
      items = [menuItem({ icon: "trash", label: `Xóa ${checked.size} đã chọn`, danger: true }, () => removeMany([...checked]))];
    } else {
      select(r.id);
      const actions = reminderActions(r);
      items = actions.flatMap((a) => (a.id === "delete" ? [el("div", { class: "ctx-sep", role: "separator" }), menuItem(a, () => perform(a.id, r))]
        : [menuItem(a, () => perform(a.id, r))]));
    }
    menu.replaceChildren(...items);
    menu.hidden = false;
    const { innerWidth, innerHeight } = window;
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
    menuReturnFocus = $("rem-table");
    openedAt = Date.now();
    menu.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
  }

  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button:not([disabled])")];
    const at = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
    else if (e.key === "Tab") closeMenu();
  });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  // composedPath: the clicked row may already have been replaced by render()
  document.addEventListener("contextmenu", (e) => { if (!menu.hidden && !e.composedPath().includes($("rem-table"))) menu.hidden = true; });
  window.addEventListener("resize", () => { menu.hidden = true; });
  document.addEventListener("scroll", (e) => { if (!menu.hidden && !menu.contains(e.target) && Date.now() - openedAt > 200) menu.hidden = true; }, true);

  const rowOf = (target) => target.closest?.("tbody tr");
  const idOf = (row) => Number(row.dataset.id);

  // Selection and ticks change classes in place: rebuilding the rows between the two clicks of a double-click
  // would give the second click a new element and the browser would not report a dblclick.
  function paintSelection() {
    for (const row of $("rem-table").querySelectorAll("tbody tr")) {
      const id = idOf(row);
      row.classList.toggle("sel", id === selectedId);
      row.setAttribute("aria-selected", String(id === selectedId));
      const box = row.querySelector("input[data-tick]");
      if (box) box.checked = checked.has(id);
    }
    const all = $("rem-table").querySelector("thead input");
    if (all) {
      all.checked = reminders.length > 0 && checked.size === reminders.length;
      all.indeterminate = checked.size > 0 && checked.size < reminders.length;
    }
    renderToolbar();
  }
  function select(id) { selectedId = id; paintSelection(); }

  function tick(id, on, range) {
    if (range && lastTicked !== null) {                       // shift-click: tick everything between the two rows
      const ids = reminders.map((r) => r.id);
      const [a, b] = [ids.indexOf(lastTicked), ids.indexOf(id)].sort((x, y) => x - y);
      for (const i of ids.slice(a, b + 1)) (on ? checked.add(i) : checked.delete(i));
    } else if (on) checked.add(id);
    else checked.delete(id);
    lastTicked = id;
  }

  $("rem-table").addEventListener("click", (e) => {
    const row = rowOf(e.target);
    if (!row) return;
    if (e.target.matches?.("input[data-tick]")) {
      tick(idOf(row), e.target.checked, e.shiftKey);
      paintSelection();
      return;
    }
    select(idOf(row));
    if (e.detail === 2) showDetail(selected());                 // second click of a double-click
  });
  $("rem-table").addEventListener("dblclick", (e) => {
    const row = rowOf(e.target);
    if (!row || e.target.matches?.("input")) return;
    select(idOf(row));
    showDetail(selected());
  });
  $("rem-table").addEventListener("contextmenu", (e) => {
    const row = rowOf(e.target);
    if (!row) return;
    e.preventDefault();
    openMenu(byId(idOf(row)), e.clientX, e.clientY);
  });
  $("rem-table").addEventListener("keydown", (e) => {
    const r = selected();
    const at = reminders.findIndex((x) => x.id === selectedId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = reminders[Math.min(reminders.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) select(next.id);
    } else if (e.key === " " && r) { e.preventDefault(); tick(r.id, !checked.has(r.id), false); paintSelection(); }
    else if (e.key === "Enter" && r) { e.preventDefault(); showDetail(r); }
    else if (e.key === "Delete") { e.preventDefault(); if (checked.size) removeMany([...checked]); else if (r) removeMany([r.id]); }
    else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && r) {
      e.preventDefault();
      const rect = (document.querySelector("#rem-table tr.sel") ?? $("rem-table")).getBoundingClientRect();
      openMenu(r, rect.left + 24, rect.bottom);
    }
  });

  // ---- form -------------------------------------------------------------------------

  const dayBoxes = DAY_LABELS.map((label, i) => {
    const box = el("input", { type: "checkbox", value: String(i), "aria-label": label });
    return { box, node: el("label", { class: "check day" }, box, label) };
  });
  $("rem-days").replaceChildren(...dayBoxes.map((d) => d.node));
  const onceDate = createDateField({ label: "Ngày gửi", allowDynamic: false });
  $("rem-once-date").replaceChildren(onceDate.el);

  // "{" suggestions and a "+" menu for the title and the per-line template
  const titleAdd = varButton("Chèn biến vào tiêu đề");
  const templateAdd = varButton("Chèn cột Jira vào mẫu");
  $("rem-title-add-slot").replaceWith(titleAdd);
  $("rem-template-add-slot").replaceWith(templateAdd);
  attachVarPicker($("rem-title"), titleAdd, () => TITLE_VARIABLES);
  attachVarPicker($("rem-template"), templateAdd, () => templateVariables(meta.fields));

  const kind = () => document.querySelector('input[name="rem-kind"]:checked')?.value ?? "weekly";
  const selectedDays = () => dayBoxes.filter((d) => d.box.checked).map((d) => Number(d.box.value));

  function showQuery() {
    fillFilter($("rem-query"), editing.query);
    $("rem-query-warn").replaceChildren(...queryWarnings(editing.query).map((w) => el("p", { class: "hint warn", text: w })));
  }

  function syncKind() {
    const once = kind() === "once";
    $("rem-weekly").hidden = once;
    $("rem-once").hidden = !once;
    $("rem-preview-edit").hidden = !once;
    if (!once && manual) {                                  // a hand-written message is for a single send only
      setManual(false);
      $("rem-preview").value = "";
      setMsg("Tin viết tay chỉ dùng cho nhắc nhở một lần.", "err");
    }
  }

  function syncChannel() {
    $("rem-chat-row").hidden = $("rem-channel").value !== "telegram";
    $("rem-channel-warn").textContent = channels[$("rem-channel").value]?.configured ? "" : "Kênh chưa cấu hình trong .env";
  }

  function closeJqlBox() {
    $("rem-jql-box").hidden = true;
    $("rem-edit-jql").setAttribute("aria-pressed", "false");
  }

  // ---- note rules, grouping, send condition, hand-written message --------------------------------------------------

  let rules = [];                                // editing copy of the note rules
  let manual = false;                            // the preview text is hand-written (one-time reminders only)
  let ruleViews = [];                            // {rule, picker, ms} of the rows on screen
  let ruleSeq = 0;
  const fieldList = () => [{ id: "status", name: "Status" }, ...meta.fields.filter((f) => f.id !== "status" && f.id !== "issuekey")];
  const fieldName = (id) => meta.fieldById[id]?.name ?? id;

  const fillConditions = () => $("rem-condition").replaceChildren(...CONDITIONS.map((c) => el("option", { value: c.id, text: c.label })));
  fillConditions();
  const syncCondition = () => { $("rem-min-count").hidden = $("rem-condition").value !== "min_count"; };
  $("rem-condition").addEventListener("change", () => { syncCondition(); touched(); });
  $("rem-min-count").addEventListener("input", () => touched());

  function fillFieldSelect(select, current, { none = false } = {}) {
    const options = fieldList();
    if (current && !options.some((f) => f.id === current)) options.push({ id: current, name: current });
    select.replaceChildren(...(none ? [el("option", { value: "", text: "Không" })] : []),
      ...options.map((f) => el("option", { value: f.id, text: f.custom ? `${f.name} (custom)` : f.name })));
    select.value = current ?? (none ? "" : "status");
  }

  function updateSectionBadges() {
    $("rem-rules-count").textContent = rules.length ? String(rules.length) : "";
    $("rem-group-count").textContent = $("rem-group-by").value || $("rem-sort-by").value ? "●" : "";
  }

  function touched() { markStale(); updateSectionBadges(); }

  const suggest = (field) => async (q) =>
    (await getJson(`/api/meta/suggest?field=${encodeURIComponent(field)}&q=${encodeURIComponent(q)}`)).map((v) => ({ value: v, label: v }));

  /** One rule as a sentence: "Khi [field] [op] [values]" / "Thì [action] [text]". The row keeps its controls
   *  alive; only add / delete / reorder rebuild the list. */
  function ruleView(rule) {
    const field = el("select", { class: "rule-field", "aria-label": "Field" });
    fillFieldSelect(field, rule.field);
    const op = el("select", { class: "rule-op", "aria-label": "Phép so sánh" }, ...RULE_OPS.map((o) => el("option", { value: o.id, text: o.label })));
    op.value = rule.op;
    const host = el("div", { class: "rule-values" });
    const ms = new MultiSelect(host, { placeholder: "Chọn hoặc gõ giá trị, Enter để thêm", allowCustom: true, onChange: () => { rule.values = ms.values(); touched(); } });
    const contains = el("input", { type: "text", class: "rule-contains", placeholder: "Từ cần tìm", "aria-label": "Từ cần tìm", autocomplete: "off" });
    const action = el("select", { class: "rule-action", "aria-label": "Hành động" }, ...RULE_ACTIONS.map((a) => el("option", { value: a.id, text: a.label })));
    action.value = rule.action;
    const text = el("input", { type: "text", class: "rule-text", maxLength: 200, placeholder: "Nội dung ghi chú, gõ { để chèn biến", "aria-label": "Nội dung ghi chú", autocomplete: "off", value: rule.text ?? "" });
    text.id = `rem-rule-text-${++ruleSeq}`;
    const hint = el("span", { class: "muted rule-hint", text: "Issue này sẽ không xuất hiện trong tin" });
    const picker = attachVarPicker(text, null, () => templateVariables(meta.fields));

    function configure() {                                    // the value list depends on the field
      if (rule.field === "status") {
        ms.search = null;
        ms.setOptions(meta.statuses.map((st) => ({ value: st.name, label: st.name })));
      } else {
        ms.setOptions([]);
        ms.search = suggest(rule.field);
      }
    }
    function sync() {                                         // what to show for the current operator / action
      host.hidden = rule.op !== "in" && rule.op !== "not_in";
      contains.hidden = rule.op !== "contains";
      text.hidden = rule.action === "hide";
      hint.hidden = rule.action !== "hide";
    }
    configure();
    ms.setSelected((rule.values ?? []).map((v) => ({ value: v, label: v })));
    contains.value = rule.values?.[0] ?? "";
    sync();

    field.addEventListener("change", () => {
      rule.field = field.value;
      rule.values = [];
      ms.clear();
      contains.value = "";
      configure();
      touched();
    });
    op.addEventListener("change", () => {
      const carry = rule.values ?? [];
      rule.op = op.value;
      if (rule.op === "empty" || rule.op === "not_empty") rule.values = [];
      else if (rule.op === "contains") { rule.values = carry.slice(0, 1); contains.value = rule.values[0] ?? ""; }
      else { rule.values = carry; ms.setSelected(carry.map((v) => ({ value: v, label: v }))); }
      sync();
      touched();
    });
    contains.addEventListener("input", () => { rule.values = splitValues(contains.value).slice(0, 1); touched(); });
    action.addEventListener("change", () => { rule.action = action.value; sync(); touched(); });
    text.addEventListener("input", () => { rule.text = text.value; touched(); });

    const move = (by) => () => {
      const i = rules.indexOf(rule);
      const j = i + by;
      if (j < 0 || j >= rules.length) return;
      [rules[i], rules[j]] = [rules[j], rules[i]];
      renderRules();
      touched();
    };
    const i = rules.indexOf(rule);
    const node = el("div", { class: "rem-rule" },
      el("span", { class: "rule-n", text: String(i + 1) }),
      el("div", { class: "rule-body" },
        el("div", { class: "rule-line" }, el("span", { class: "rule-lbl", text: "Khi" }), field, op, host, contains),
        el("div", { class: "rule-line" }, el("span", { class: "rule-lbl", text: "Thì" }), action, text, hint)),
      el("div", { class: "rule-tools" },
        iconButton("up", "Lên", move(-1), { disabled: i === 0 }),
        iconButton("down", "Xuống", move(1), { disabled: i === rules.length - 1 }),
        iconButton("trash", "Xóa quy tắc", () => { rules.splice(rules.indexOf(rule), 1); renderRules(); touched(); }, { danger: true })));
    return { rule, picker, ms, node };
  }

  function renderRules() {
    for (const view of ruleViews) { view.picker.destroy(); view.ms.destroy(); }
    ruleViews = rules.map(ruleView);
    $("rem-rules").replaceChildren(...ruleViews.map((v) => v.node));
    $("rem-rules-empty").hidden = rules.length > 0;
    $("rem-rule-add").disabled = rules.length >= MAX_RULES;
    updateSectionBadges();
  }

  $("rem-rule-add").addEventListener("click", () => {
    if (rules.length >= MAX_RULES) return;
    rules.push(newRule());
    renderRules();
    $("rem-rules-box").open = true;
    touched();
    $("rem-rules").lastElementChild?.querySelector("input:not([hidden])")?.focus();
  });
  for (const id of ["rem-default-note", "rem-group-order", "rem-sort-dir"]) $(id).addEventListener("input", touched);
  for (const id of ["rem-group-by", "rem-sort-by"]) $(id).addEventListener("change", touched);

  function setManual(on) {
    manual = on;
    $("rem-preview").readOnly = !on;
    $("rem-preview-edit").setAttribute("aria-pressed", String(on));
    $("rem-preview-tag").hidden = !on;
    $("rem-preview").classList.remove("stale");
    if (on) $("rem-decision").hidden = true;
  }

  function openForm(reminder, query) {
    editing = { id: reminder?.id ?? null, query };
    $("rem-name").value = reminder?.name ?? "";
    $("rem-enabled").checked = reminder?.enabled ?? true;
    const once = reminder?.schedule_kind === "once";
    document.querySelector(`input[name="rem-kind"][value="${once ? "once" : "weekly"}"]`).checked = true;
    const days = reminder?.days?.length ? reminder.days : [0, 1, 2, 3, 4];
    for (const d of dayBoxes) d.box.checked = days.includes(Number(d.box.value));
    const fresh = defaultRunAt();
    onceDate.value = once && reminder.run_at ? reminder.run_at.slice(0, 10) : fresh.date;
    $("rem-time").value = once && reminder.run_at ? reminder.run_at.slice(11, 16) : (reminder?.time ?? (once ? fresh.time : "09:00"));
    $("rem-channel").value = reminder?.channel ?? (channels.slack.configured || !channels.telegram.configured ? "slack" : "telegram");
    $("rem-chat").value = reminder?.telegram_chat_id ?? "";
    $("rem-chat-pick").replaceChildren();
    $("rem-chat-pick").hidden = true;
    $("rem-template").value = reminder?.template ?? DEFAULT_REMINDER_TEMPLATE;
    $("rem-title").value = reminder?.title ?? "";
    $("rem-condition").value = reminder?.condition ?? "always";
    $("rem-min-count").value = String(reminder?.min_count ?? 1);
    syncCondition();
    $("rem-maxlines").value = String(reminder?.max_lines ?? 30);
    rules = (reminder?.note_rules ?? []).map((r) => ({ ...r, values: [...(r.values ?? [])] }));
    $("rem-default-note").value = reminder?.default_note ?? "";
    fillFieldSelect($("rem-group-by"), reminder?.group_by ?? "", { none: true });
    fillFieldSelect($("rem-sort-by"), reminder?.sort_by ?? "", { none: true });
    $("rem-group-order").value = reminder?.group_order ?? "name";
    $("rem-sort-dir").value = reminder?.sort_dir ?? "asc";
    renderRules();
    $("rem-rules-box").open = rules.length > 0 || !!reminder?.default_note;
    $("rem-group-box").open = !!(reminder?.group_by || reminder?.sort_by);
    $("rem-preview").value = reminder?.custom_message ?? "";
    $("rem-preview").classList.remove("stale");
    $("rem-decision").hidden = true;
    setManual(!!reminder?.custom_message && reminder?.schedule_kind === "once");
    closeJqlBox();
    $("rem-form-title").textContent = reminder?.id ? "Sửa nhắc nhở" : reminder ? "Nhân bản nhắc nhở" : "Nhắc nhở mới";
    showQuery();
    syncKind();
    syncChannel();
    $("dlg-reminder-form").showModal();
  }

  const formValues = () => ({
    name: $("rem-name").value, enabled: $("rem-enabled").checked, query: editing.query, template: $("rem-template").value,
    title: $("rem-title").value,
    channel: $("rem-channel").value, chatId: $("rem-chat").value, condition: $("rem-condition").value, minCount: $("rem-min-count").value,
    maxLines: $("rem-maxlines").value, noteRules: rules, defaultNote: $("rem-default-note").value,
    groupBy: $("rem-group-by").value, groupOrder: $("rem-group-order").value, sortBy: $("rem-sort-by").value, sortDir: $("rem-sort-dir").value,
    customMessage: manual && kind() === "once" ? $("rem-preview").value : "",
    scheduleKind: kind(), days: selectedDays(), time: $("rem-time").value, runDate: onceDate.value,
  });

  function currentFilterQuery() {
    try {
      if (!activeCount()) throw new Error("Hãy chọn ít nhất một bộ lọc ở thanh bên trái trước.");
      return reminderQuery(getQuery());
    } catch (e) {
      setMsg(e.message, "err");
      return null;
    }
  }

  $("rem-add").addEventListener("click", () => { const query = currentFilterQuery(); if (query) openForm(null, query); });
  $("rem-refresh").addEventListener("click", refresh);

  // Re-pick this job's filters: take the sidebar's current filters, or edit the job's query as JQL.
  $("rem-use-filter").addEventListener("click", () => {
    const query = currentFilterQuery();
    if (!query) return;
    editing.query = query;
    closeJqlBox();
    showQuery();
    markStale();
    setMsg("Đã lấy bộ lọc hiện tại.", "ok");
  });
  $("rem-edit-jql").addEventListener("click", async () => {
    if (!$("rem-jql-box").hidden) { closeJqlBox(); return; }
    try {
      const jql = editing.query.jql ?? (await (await postJson("/api/jql/build", editing.query)).json()).jql;
      $("rem-jql").value = jql;
      $("rem-jql-box").hidden = false;
      $("rem-edit-jql").setAttribute("aria-pressed", "true");
      $("rem-jql").focus();
    } catch (e) {
      setMsg(e.message, "err");
    }
  });
  $("rem-jql-apply").addEventListener("click", () => {
    const jql = $("rem-jql").value.trim();
    if (!jql) { setMsg("JQL không được để trống.", "err"); return; }
    editing.query = reminderQuery({ jql });
    closeJqlBox();
    showQuery();
    markStale();
  });

  for (const radio of document.querySelectorAll('input[name="rem-kind"]')) {
    radio.addEventListener("change", () => {
      syncKind();
      // Switching to "once" with a moment that is already past (e.g. the weekly 09:00 time): suggest the next hour.
      if (kind() === "once" && new Date(`${onceDate.value}T${$("rem-time").value || "00:00"}:00`) <= new Date()) {
        const fresh = defaultRunAt();
        onceDate.value = fresh.date;
        $("rem-time").value = fresh.time;
      }
    });
  }
  $("rem-channel").addEventListener("change", syncChannel);

  $("rem-find-chat").addEventListener("click", async () => {
    try {
      const { chats } = await (await postJson("/api/channels/telegram/chats", {})).json();
      const pick = $("rem-chat-pick");
      pick.replaceChildren(el("option", { value: "", text: chats.length ? "Chọn chat…" : "Chưa thấy chat nào: nhắn bot (hoặc nhắn trong nhóm có bot) rồi bấm lại" }),
        ...chats.map((c) => el("option", { value: c.id, text: `${c.title} (${c.type}) — ${c.id}` })));
      pick.hidden = false;
    } catch (e) {
      setMsg(e.message, "err");
    }
  });
  $("rem-chat-pick").addEventListener("change", (e) => { if (e.target.value) $("rem-chat").value = e.target.value; });

  // Preview: stays readable full-screen; marked stale when something that changes the message is edited afterwards.
  const previewBox = $("rem-preview-box");
  function setPreviewFull(on) {
    previewBox.classList.toggle("full", on);
    $("rem-preview-full").setAttribute("aria-pressed", String(on));
    $("rem-preview-full").title = on ? "Thu nhỏ (Esc)" : "Phóng to xem trước (Esc để thu nhỏ)";
  }
  $("rem-preview-full").addEventListener("click", () => setPreviewFull(!previewBox.classList.contains("full")));
  $("dlg-reminder-form").addEventListener("cancel", (e) => {          // Esc: leave full-screen first, close the dialog second
    if (previewBox.classList.contains("full")) { e.preventDefault(); setPreviewFull(false); }
  });
  $("dlg-reminder-form").addEventListener("close", () => setPreviewFull(false));
  function markStale() { if (!manual && $("rem-preview").value) $("rem-preview").classList.add("stale"); }
  for (const id of ["rem-name", "rem-title", "rem-template", "rem-maxlines"]) $(id).addEventListener("input", markStale);

  const previewBody = () => {
    const core = buildCore({ ...formValues(), customMessage: "", channel: "slack" })   // the channel does not matter for a preview;
    return {
      query: core.query, template: core.template, title: core.title, name: core.name, max_lines: core.max_lines, condition: core.condition,
      min_count: core.min_count, note_rules: core.note_rules, default_note: core.default_note, group_by: core.group_by,
      group_order: core.group_order, sort_by: core.sort_by, sort_dir: core.sort_dir,
    };
  };

  async function runPreview() {
    let body;
    try { body = previewBody(); } catch (e) { setMsg(e.message, "err"); return false; }
    setMsg("Đang chạy bộ lọc…");
    try {
      const r = await (await postJson("/api/reminders/preview", body)).json();
      $("rem-preview").value = r.text;
      $("rem-preview").classList.remove("stale");
      const decision = $("rem-decision");
      decision.hidden = manual;
      decision.className = `rem-decision${r.decision.send ? "" : " no"}`;
      decision.textContent = r.decision.send
        ? `Sẽ gửi · ${r.row_count} issue${r.hidden ? ` · ẩn ${r.hidden}` : ""}${r.matched ? ` · ${r.matched} khớp quy tắc` : ""}`
        : `Sẽ không gửi: ${r.decision.reason} (${r.row_count} issue${r.hidden ? `, ẩn ${r.hidden}` : ""})`;
      setMsg("");
      return true;
    } catch (e) {
      setMsg(e.message, "err");
      return false;
    }
  }

  $("rem-preview-btn").addEventListener("click", async () => {
    if (manual && $("rem-preview").value.trim()) {
      const answer = await choose("Tạo lại nội dung?", [el("p", { text: "Nội dung bạn đã sửa tay sẽ bị thay bằng tin tạo từ bộ lọc và mẫu hiện tại." })],
        [{ label: "Tạo lại", value: "yes", primary: true }, { label: "Giữ", value: "no" }]);
      if (answer !== "yes") return;
    }
    await runPreview();
  });

  // One-time reminders only: write the message by hand; it is sent exactly as written (no query, no rules).
  $("rem-preview-edit").addEventListener("click", async () => {
    if (!manual) {
      if (!$("rem-preview").value.trim()) await runPreview();           // start from the generated message
      setManual(true);
      $("rem-preview").focus();
      return;
    }
    const answer = await choose("Bỏ tin viết tay?", [el("p", { text: "Nội dung bạn đã sửa sẽ mất. Tin sẽ được tạo từ bộ lọc, mẫu và quy tắc như bình thường." })],
      [{ label: "Bỏ", value: "yes", primary: true }, { label: "Giữ", value: "no" }]);
    if (answer === "yes") { setManual(false); $("rem-preview").value = ""; }
  });

  $("rem-send-test").addEventListener("click", async () => {
    let core;
    try { core = buildCore(formValues()); } catch (e) { setMsg(e.message, "err"); return; }
    const where = core.channel === "telegram" ? `Telegram (chat_id ${core.telegram_chat_id})` : "Slack";
    const answer = await choose("Gửi thử ngay?", [el("p", { text: `Một tin thật sẽ được gửi tới ${where} ngay bây giờ, tiêu đề có "[Gửi thử]". Lần gửi này không ghi vào lịch sử.` })],
      [{ label: "Gửi", value: "yes", primary: true }, { label: "Hủy", value: "no" }]);
    if (answer !== "yes") return;
    setMsg("Đang gửi thử…");
    try {
      const out = await (await postJson("/api/reminders/send-test", core)).json();
      setMsg(out.status === "sent" ? `Đã gửi thử (${out.row_count} issue).` : `Gửi thử thất bại: ${out.error}`, out.status === "sent" ? "ok" : "err");
    } catch (e) {
      setMsg(e.message, "err");
    }
  });

  $("rem-save").addEventListener("click", async () => {
    let body;
    try {
      if (manual && kind() === "once" && !$("rem-preview").value.trim()) throw new Error("Tin viết tay đang trống: hãy nhập nội dung hoặc bỏ chế độ sửa tay.");
      body = buildPayload(formValues());
    } catch (e) { setMsg(e.message, "err"); return; }
    try {
      const saved = await (await (editing.id ? putJson(`/api/reminders/${editing.id}`, body) : postJson("/api/reminders", body))).json();
      selectedId = saved.id;
      setMsg("Đã lưu nhắc nhở.", "ok");
      $("dlg-reminder-form").close();
      await refresh();
    } catch (e) {
      setMsg(e.message, "err");
    }
  });

  // ---- shared dialog bits ---------------------------------------------------------------

  document.addEventListener("click", (e) => {
    const x = e.target.closest?.(".dlg-x");
    if (x) x.closest("dialog")?.close();
  });
  const detailReminder = () => byId(Number($("dlg-reminder-detail").dataset.id));
  $("rd-edit").addEventListener("click", () => { const r = detailReminder(); $("dlg-reminder-detail").close(); if (r) openForm(r, r.query); });
  $("rd-test").addEventListener("click", async () => { const r = detailReminder(); $("dlg-reminder-detail").close(); if (r) await sendSaved(r); });
  $("rd-dup").addEventListener("click", () => { const r = detailReminder(); $("dlg-reminder-detail").close(); if (r) openForm(duplicateDraft(r), r.query); });
  $("rd-delete").addEventListener("click", async () => { const r = detailReminder(); $("dlg-reminder-detail").close(); if (r) await removeMany([r.id]); });

  return { refresh };
}
