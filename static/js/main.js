import { postJson } from "./api.js";
import { createActions } from "./actions.js";
import { createDashboard } from "./dashboard.js";
import { $, bindMenu, el, setMsg } from "./dom.js";
import { createFilters } from "./filters.js";
import { hydrateIcons } from "./icons.js";
import { MultiSelect } from "./multiselect.js";
import { initAnimatedFavicon } from "./favicon.js";
import { loadHealth, loadMeta, meta } from "./meta.js";
import { initProfileUi } from "./profile-ui.js";
import { loadProfile, onPersist, saveProfile, store } from "./store.js";
import { createTable } from "./table.js";
import { initFocusMode, initFullscreen, initTheme } from "./ui.js";

const DEFAULT_COLUMNS = ["issuekey", "summary", "status", "assignee", "reporter", "created", "labels"];

function setStatus(text, kind) {
  const node = $("status");
  node.textContent = text;
  node.className = `pill pill-${kind}`;
}

// ---- wiring --------------------------------------------------------------

loadProfile();
hydrateIcons();
initTheme();
initFocusMode();
initFullscreen();
initAnimatedFavicon();

const table = createTable({ onChange: updateToolbar });
const dashboard = createDashboard({
  table,
  onDrill: (keys, label) => { table.setDrill(new Set(keys)); showDrill(label); selectTab("table"); },
});
createActions({ table });
const filters = createFilters({});

const columnPicker = new MultiSelect($("f-columns"), {
  placeholder: "Thêm cột…", reorder: true,
  onChange: () => { store.profile.columns = columnPicker.values(); saveProfile(); updateColumnCount(); },
});
bindMenu($("btn-columns"), $("columns-pop"));

initProfileUi({
  onProfileApplied: async () => { await applyProfile(); table.render(); dashboard.render(); },
  onColorsChanged: () => { table.render(); dashboard.render(); },
});
onPersist(() => { $("persist-warn").hidden = !store.persistFailed; });

const columnOptions = () => meta.fields.map((f) => ({ value: f.id, label: f.custom ? `${f.name} (custom)` : f.name }));

function updateColumnCount() { $("col-count").textContent = String(columnPicker.selected.length); }

async function applyProfile() {
  const fieldOpts = columnOptions();
  const wanted = store.profile.columns.length ? store.profile.columns : DEFAULT_COLUMNS;
  columnPicker.setSelected(wanted.map((id) => fieldOpts.find((o) => o.value === id)).filter(Boolean));
  updateColumnCount();
  $("show-note").checked = store.profile.ui.showNote;
  await filters.applyProfile();
}

function updateToolbar() {
  const has = table.hasResult();
  const selected = has ? table.selectedCount() : 0;
  const visible = has ? table.visibleCount() : 0;

  $("tray").hidden = !has;
  $("tray").classList.toggle("active", selected > 0);
  $("tray-count").textContent = selected ? `Đã chọn ${selected} dòng` : "Chưa chọn dòng nào";
  const pages = table.selectedPageNumbers();
  $("tray-pages").textContent = selected === 0 ? " · tích chọn dòng để xuất"
    : pages.length > 1 ? ` · ở ${pages.length <= 6 ? `trang ${pages.join(", ")}` : `${pages.length} trang`}` : "";
  for (const id of ["btn-xlsx", "btn-csv", "btn-copy", "btn-message", "btn-clear-selection"]) {
    $(id).disabled = selected === 0;
    $(id).title = selected === 0 ? "Tích chọn ít nhất một dòng trong bảng" : "";
  }

  $("btn-select-all").disabled = !has || visible === 0 || selected >= visible;
  $("btn-select-all").textContent = visible ? `Chọn tất cả ${visible} dòng` : "Chọn tất cả";

  const sorts = table.sorts();
  const names = sorts.map((s) => `${table.columns().find((c) => c.id === s.col)?.name ?? s.col} ${s.dir === 1 ? "▲" : "▼"}`);
  $("sort-info").hidden = !names.length;
  $("sort-info").textContent = names.length ? `Sắp xếp: ${names.join(" → ")}` : "";
  $("btn-clear-sort").hidden = !names.length;
}

// ---- run -----------------------------------------------------------------

let running = false;
async function runReport() {
  if (running) return;
  const columns = columnPicker.values();
  if (!columns.length) { setMsg("Hãy chọn ít nhất một cột trong mục Cột.", "err"); return; }
  let query;
  try {
    query = { ...filters.getQuery(), columns };
  } catch (e) {
    setMsg(e.message, "err");
    return;
  }
  running = true;
  for (const id of ["btn-run", "btn-refresh"]) $(id).disabled = true;
  setMsg("Đang tải dữ liệu…");
  try {
    const result = await (await postJson("/api/report/query", query)).json();
    table.setResult(result);
    clearDrill();
    $("jql").textContent = result.jql;
    $("truncated").hidden = !result.truncated;
    $("empty").hidden = true;
    $("result-wrap").hidden = false;
    dashboard.refresh();
    setMsg(result.rows.length ? "" : "Không có issue nào khớp bộ lọc.", result.rows.length ? "" : "err");
  } catch (e) {
    setMsg(e.message, "err");
  } finally {
    running = false;
    for (const id of ["btn-run", "btn-refresh"]) $(id).disabled = false;
  }
}
$("btn-run").addEventListener("click", runReport);
$("btn-refresh").addEventListener("click", runReport);
$("btn-select-all").addEventListener("click", () => table.selectAllVisible());
$("btn-clear-selection").addEventListener("click", () => table.clearSelection());

$("show-note").addEventListener("change", (e) => {
  store.profile.ui.showNote = e.target.checked;
  saveProfile();
  table.render();
});

// ---- views / drill-down ----------------------------------------------------

function selectTab(name) {
  for (const tab of document.querySelectorAll(".view-tab")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  document.body.dataset.view = name;
  $("view-table").hidden = name !== "table";
  $("view-dash").hidden = name !== "dash";
  if (name === "dash") dashboard.refresh();
}
for (const tab of document.querySelectorAll(".view-tab")) tab.addEventListener("click", () => selectTab(tab.dataset.tab));

function showDrill(label) {
  const chip = $("drill-chip");
  chip.replaceChildren(el("span", { class: "t", text: `Từ dashboard: ${label}` }),
    el("button", { type: "button", title: "Bỏ lọc từ dashboard", "aria-label": "Bỏ lọc từ dashboard", text: "✕", onclick: () => { table.setDrill(null); clearDrill(); dashboard.render(); } }));
  chip.hidden = false;
}
function clearDrill() { $("drill-chip").hidden = true; }

// ---- startup ---------------------------------------------------------------

async function start() {
  updateToolbar();
  try {
    const me = await loadHealth();
    setStatus(`Đã kết nối: ${me.user}`, "ok");
  } catch (e) {
    setStatus(e.message, "err");
    return;
  }
  try {
    await loadMeta();
  } catch (e) {
    setMsg(`Không tải được metadata Jira: ${e.message}`, "err");
  }
  filters.initOptions();
  columnPicker.setOptions(columnOptions());
  await applyProfile();
  $("persist-warn").hidden = !store.persistFailed;
  const n = filters.activeCount();
  if (n) $("empty-text").textContent = `Đã khôi phục ${n} bộ lọc lần trước. Bấm Chạy báo cáo để xem dữ liệu, hoặc Xóa bộ lọc để bắt đầu lại.`;
}

start();
