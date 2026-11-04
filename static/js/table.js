import { $, applyStatus, el } from "./dom.js";
import { statusColor } from "./lib/color.js";
import { formatBucket } from "./lib/dates.js";
import { flattenGroups, groupRows, uniqueRowsWithGroup } from "./lib/group.js";
import { clampPage, pageAfterSizeChange, pageCount, pageRange, parsePageInput, selectedPages } from "./lib/paging.js";
import { rangeKeys, selectionState } from "./lib/selection.js";
import { multiSort, toggleSort } from "./lib/sort.js";
import { meta } from "./meta.js";
import { saveProfile, store } from "./store.js";

const BUCKETS = [["day", "ngày"], ["week", "tuần"], ["month", "tháng"]];
const isDate = (type) => type === "date" || type === "datetime";

function nodeKeys(node) {
  if (node.rows) return node.rows.map((r) => r.key);
  return node.children.flatMap(nodeKeys);
}

export function createTable({ onChange }) {
  const state = {
    result: null, selected: new Set(), sorts: [], groupLevels: [], collapsed: new Set(),
    page: 0, drill: null, anchor: null,
  };
  const table = $("table");

  const columns = () => state.result?.columns ?? [];
  const typeOf = (id) => columns().find((c) => c.id === id)?.type;
  const colorFor = (row) => statusColor(row.status, store.profile.statusColors, meta.statusCategories);
  const pageSize = () => store.profile.ui.pageSize;

  // ---- derived data ---------------------------------------------------------

  function visibleRows() {
    const rows = state.result?.rows ?? [];
    return state.drill ? rows.filter((r) => state.drill.has(r.key)) : rows;
  }
  const sortedRows = () => multiSort(visibleRows(), state.sorts, (r, col) => r.raw?.[col] ?? r.cells[col] ?? "");
  const levels = () => state.groupLevels.map((l) => ({ col: l.col, bucket: l.bucket, type: typeOf(l.col) }));
  const buildTree = () => (state.groupLevels.length ? groupRows(sortedRows(), levels()) : null);

  /** Selected rows in display order across ALL pages (collapsed groups included), each with its first group path. */
  function selectedEntries() {
    const tree = buildTree();
    const entries = tree
      ? uniqueRowsWithGroup(tree).map(({ row, path }) => ({ row, groupPath: path }))
      : sortedRows().map((row) => ({ row }));
    return entries.filter((e) => state.selected.has(e.row.key));
  }

  const notify = () => onChange?.();

  // ---- rendering ------------------------------------------------------------

  function headerCell(col) {
    const idx = state.sorts.findIndex((s) => s.col === col.id);
    const arrow = idx < 0 ? "" : ` ${state.sorts[idx].dir === 1 ? "▲" : "▼"}${state.sorts.length > 1 ? idx + 1 : ""}`;
    return el("th", {
      text: col.name + arrow,
      title: "Click: sắp xếp · Shift+click: thêm cột sắp xếp",
      "aria-sort": idx < 0 ? "none" : state.sorts[idx].dir === 1 ? "ascending" : "descending",
      onclick: (e) => { state.sorts = toggleSort(state.sorts, col.id, e.shiftKey); state.page = 0; render(); notify(); },
    });
  }

  function cellNode(row, col) {
    const value = row.cells[col.id] ?? "";
    if (col.id === "issuekey") {
      return el("td", {}, row.url
        ? el("a", { href: row.url, target: "_blank", rel: "noopener noreferrer", title: "Mở task trên Jira", text: value })
        : value);
    }
    return el("td", { class: "clamp", title: value.length > 60 ? value : undefined }, el("div", { text: value }));
  }

  function setSelected(keys, checked) {
    for (const k of keys) (checked ? state.selected.add(k) : state.selected.delete(k));
    render();
    notify();
  }

  function rowNode(row, stt, order) {
    const color = colorFor(row);
    const scope = store.profile.ui.colorScope;
    const tr = el("tr", { class: state.selected.has(row.key) ? "sel" : "" });
    if (color && scope === "row") applyStatus(tr, color);
    const checkbox = el("input", {
      type: "checkbox", checked: state.selected.has(row.key), "aria-label": `Chọn ${row.key}`,
      onclick: (e) => {
        const keys = e.shiftKey && state.anchor ? rangeKeys(order, state.anchor, row.key) : [row.key];
        state.anchor = row.key;
        setSelected(keys, e.target.checked);
      },
    });
    tr.append(el("td", { class: "c-sel" }, checkbox), el("td", { class: "c-stt", text: String(stt) }));
    for (const col of columns()) {
      const td = cellNode(row, col);
      if (color && scope === "cell" && col.id === "status") applyStatus(td, color);
      tr.append(td);
    }
    if (store.profile.ui.showNote) {
      tr.append(el("td", { class: "c-note" }, el("input", {
        class: "note-input", type: "text", value: store.profile.notes[row.key] || "", placeholder: "Ghi chú…", maxLength: 5000,
        "aria-label": `Ghi chú ${row.key}`,
        oninput: (e) => {
          if (e.target.value) store.profile.notes[row.key] = e.target.value; else delete store.profile.notes[row.key];
          saveProfile();
        },
      })));
    }
    return tr;
  }

  function groupNode(entry, colSpan) {
    const { node, id, collapsed } = entry;
    const keys = nodeKeys(node);
    const state3 = selectionState(keys, state.selected);
    const box = el("input", {
      type: "checkbox", checked: state3 === "all", "aria-label": "Chọn cả nhóm",
      onclick: (e) => { e.stopPropagation(); setSelected(keys, e.target.checked); },
    });
    box.indeterminate = state3 === "some";
    const colName = columns().find((c) => c.id === state.groupLevels[node.level].col)?.name ?? "";
    return el("tr", {
      class: "group-row",
      onclick: () => { collapsed ? state.collapsed.delete(id) : state.collapsed.add(id); render(); notify(); },
    }, el("td", { colSpan, style: { paddingLeft: `${12 + node.level * 22}px` } },
      box, " ", el("span", { class: "gtoggle", text: collapsed ? "▸" : "▾" }),
      `${colName}: ${formatBucket(node.value)} `, el("small", { text: `(${node.count})` })));
  }

  function renderPager(total, range) {
    const pages = pageCount(total, pageSize());
    $("range-info").textContent = total ? `Hiển thị ${range.start + 1}–${range.end} trên ${total} dòng` : "Không có dòng nào";
    const input = $("page-input");
    input.value = String(state.page + 1);
    input.max = String(pages);
    $("page-total").textContent = String(pages);
    $("pg-first").disabled = $("prev").disabled = state.page === 0;
    $("pg-last").disabled = $("next").disabled = state.page >= pages - 1;
    $("page-size").value = String(pageSize());
  }

  function render() {
    if (!state.result) { table.replaceChildren(); return; }
    const sorted = sortedRows();
    const allKeys = sorted.map((r) => r.key);
    const grouped = state.groupLevels.length > 0;
    state.page = clampPage(state.page, sorted.length, pageSize());
    const range = pageRange(state.page, sorted.length, pageSize());
    const scopeKeys = grouped ? allKeys : allKeys.slice(range.start, range.end);   // header checkbox acts on what is on screen

    const sel = selectionState(scopeKeys, state.selected);
    const selectAll = el("input", {
      type: "checkbox", checked: sel === "all", "aria-label": grouped ? "Chọn tất cả các dòng" : "Chọn các dòng trong trang này",
      title: grouped ? "Chọn / bỏ chọn tất cả các dòng" : "Chọn / bỏ chọn các dòng trong trang này",
      onclick: (e) => setSelected(scopeKeys, e.target.checked),
    });
    selectAll.indeterminate = sel === "some";

    const showNote = store.profile.ui.showNote;
    const head = el("tr", {},
      el("th", { class: "c-sel static" }, selectAll),
      el("th", { class: "c-stt static", text: "STT" }),
      ...columns().map(headerCell),
      showNote && el("th", { class: "c-note static", text: "Ghi chú" }));
    const colSpan = 2 + columns().length + (showNote ? 1 : 0);

    const body = el("tbody");
    const tree = buildTree();
    if (tree) {
      const order = uniqueRowsWithGroup(tree).map((u) => u.row.key);
      let stt = 0;
      for (const entry of flattenGroups(tree, state.collapsed)) {
        if (entry.type === "group") body.append(groupNode(entry, colSpan));
        else body.append(rowNode(entry.row, ++stt, order));
      }
      $("pager").hidden = true;
    } else {
      sorted.slice(range.start, range.end).forEach((row, i) => body.append(rowNode(row, range.start + i + 1, allKeys)));
      $("pager").hidden = false;
      renderPager(sorted.length, range);
    }
    table.replaceChildren(el("thead", {}, head), body);
    $("count").textContent = `${visibleRows().length} / ${state.result.total} issue`;
  }

  // ---- group controls -------------------------------------------------------

  function renderGroupControls() {
    const cols = columns();
    $("btn-add-group").disabled = !cols.length || state.groupLevels.length >= 3;
    $("btn-collapse-groups").disabled = !state.groupLevels.length;
    $("group-levels").replaceChildren(...state.groupLevels.map((level, i) => {
      const bucket = isDate(typeOf(level.col))
        ? el("select", { title: "Gom theo", "aria-label": "Gom theo", onchange: (e) => { level.bucket = e.target.value; reset(); } },
          ...BUCKETS.map(([v, t]) => el("option", { value: v, text: t, selected: v === level.bucket })))
        : null;
      return el("span", { class: "gl" },
        el("select", {
          "aria-label": "Cột để nhóm",
          onchange: (e) => { level.col = e.target.value; level.bucket = "day"; renderGroupControls(); reset(); },
        }, ...cols.map((c) => el("option", { value: c.id, text: c.name, selected: c.id === level.col }))),
        bucket,
        el("button", { type: "button", class: "btn btn-icon", title: "Bỏ cấp nhóm", "aria-label": "Bỏ cấp nhóm", text: "✕", onclick: () => { state.groupLevels.splice(i, 1); renderGroupControls(); reset(); } }));
    }));
  }

  function reset() { state.collapsed.clear(); render(); notify(); }

  $("btn-add-group").addEventListener("click", () => {
    const used = new Set(state.groupLevels.map((l) => l.col));
    const free = columns().filter((c) => !used.has(c.id));
    const col = ["status", "labels", "assignee", "created"].map((id) => free.find((c) => c.id === id)).find(Boolean) ?? free[0];
    if (!col) return;
    state.groupLevels.push({ col: col.id, bucket: "day" });
    renderGroupControls();
    reset();
  });
  $("btn-collapse-groups").addEventListener("click", () => {
    const tree = buildTree();
    if (!tree) return;
    const ids = [];
    (function walk(list) { for (const n of list) { ids.push(n.path.join("\u0001")); if (n.children) walk(n.children); } })(tree);
    if (state.collapsed.size) state.collapsed.clear(); else ids.forEach((id) => state.collapsed.add(id));
    render();
    notify();
  });
  $("btn-clear-sort").addEventListener("click", () => { state.sorts = []; render(); notify(); });

  // ---- pager ------------------------------------------------------------------

  const total = () => sortedRows().length;
  const goTo = (page) => { state.page = clampPage(page, total(), pageSize()); render(); $("table-wrap").scrollTop = 0; };
  $("pg-first").addEventListener("click", () => goTo(0));
  $("prev").addEventListener("click", () => goTo(state.page - 1));
  $("next").addEventListener("click", () => goTo(state.page + 1));
  $("pg-last").addEventListener("click", () => goTo(Infinity));
  $("page-input").addEventListener("change", (e) => {
    const page = parsePageInput(e.target.value, total(), pageSize());
    if (page === null) e.target.value = String(state.page + 1); else goTo(page);
  });
  $("page-input").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("page-size").addEventListener("change", (e) => {
    const next = Number(e.target.value);
    state.page = pageAfterSizeChange(state.page, pageSize(), next);
    store.profile.ui.pageSize = next;
    saveProfile();
    render();
    notify();
  });

  return {
    setResult(result) {
      state.result = result;
      state.selected = new Set();           // a new result starts with nothing ticked
      state.sorts = state.sorts.filter((s) => result.columns.some((c) => c.id === s.col));
      state.groupLevels = state.groupLevels.filter((l) => result.columns.some((c) => c.id === l.col));
      state.collapsed.clear();
      state.drill = null;
      state.page = 0;
      state.anchor = null;
      renderGroupControls();
      render();
      notify();
    },
    render() { render(); notify(); },
    setDrill(keys) { state.drill = keys; state.page = 0; render(); notify(); },
    hasDrill: () => state.drill !== null,
    selectAllVisible() { setSelected(visibleRows().map((r) => r.key), true); },
    clearSelection() { state.selected = new Set(); render(); notify(); },
    selectedEntries,
    selectedCount: () => selectedEntries().length,
    /** 1-based pages (current order and page size) holding ticked rows; empty while grouped. */
    selectedPageNumbers: () => (state.groupLevels.length ? [] : selectedPages(sortedRows().map((r) => r.key), state.selected, pageSize())),
    visibleCount: () => visibleRows().length,
    isGrouped: () => state.groupLevels.length > 0,
    sorts: () => state.sorts,
    columns,
    rows: () => state.result?.rows ?? [],
    visibleRows,
    hasResult: () => !!state.result,
  };
}
