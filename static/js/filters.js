import { getJson, postJson } from "./api.js";
import { $, bindMenu, choose, el, setMsg } from "./dom.js";
import { createDateField } from "./datefield.js";
import { MultiSelect } from "./multiselect.js";
import { meta } from "./meta.js";
import { emptyFilters } from "./lib/profile.js";
import { saveProfile, store } from "./store.js";
import { createCustomFilters } from "./custom-filters.js";

const FILTERS = [
  { id: "projects", label: "Project" },
  { id: "sprints", label: "Sprint" },
  { id: "labels", label: "Label" },
  { id: "reporters", label: "Reporter hoặc nhóm" },
  { id: "assignees", label: "Assignee hoặc nhóm" },
  { id: "created", label: "Ngày tạo" },
  { id: "updated", label: "Ngày cập nhật" },
  { id: "statuses", label: "Status" },
  { id: "issuetypes", label: "Issue type" },
];
const OPTION_FILTERS = ["projects", "sprints", "labels", "reporters", "assignees", "statuses", "issuetypes"];

export function createFilters({ onChange }) {
  const ms = {};
  const dates = {};
  const wrappers = {};
  const grid = $("filter-grid");
  let jqlMode = false;
  let groupsWarned = false;
  let restoring = false;

  const changed = () => {
    if (restoring) return;
    persist();
    updateSummary();
    onChange?.();
  };

  function field(id, label, control) {
    const wrap = el("div", { class: "field", "data-filter": id }, el("span", { text: label }), control);
    wrappers[id] = wrap;
    return wrap;
  }
  const dateRange = (id, label) => {
    const from = createDateField({ label: `${label} từ ngày`, onChange: changed });
    const to = createDateField({ label: `${label} đến ngày`, onChange: changed });
    dates[id] = { from, to };
    return el("div", { class: "range" }, from.el, to.el);
  };

  // users and groups share one picker: values are "u:<username>" / "g:<group>"
  async function userAndGroupSearch(q) {
    const [users, groups] = await Promise.all([
      getJson(`/api/meta/users?q=${encodeURIComponent(q)}`),
      getJson(`/api/meta/groups?q=${encodeURIComponent(q)}`).catch((e) => {
        if (!groupsWarned) { groupsWarned = true; setMsg(`Không tìm được nhóm: ${e.message}`, "err"); }
        return [];
      }),
    ]);
    return [
      ...groups.map((g) => ({ value: `g:${g}`, label: `👥 ${g} (nhóm)` })),
      ...users.map((u) => ({ value: `u:${u.username}`, label: u.displayName ? `${u.displayName} (${u.username})` : u.username })),
    ];
  }

  const make = (id, placeholder, extra = {}) => {
    const root = el("div");
    ms[id] = new MultiSelect(root, { placeholder, onChange: changed, ...extra });
    return root;
  };

  grid.replaceChildren(
    field("projects", "Project", make("projects", "Chọn project…")),
    field("sprints", "Sprint", make("sprints", "Chọn project trước…")),
    field("labels", "Label", make("labels", "Gõ để tìm label…", {
      search: async (q) => (await getJson(`/api/meta/labels?q=${encodeURIComponent(q)}`)).map((l) => ({ value: l, label: l })),
    })),
    field("reporters", "Reporter hoặc nhóm", make("reporters", "Gõ tên user hoặc nhóm…", { search: userAndGroupSearch })),
    field("assignees", "Assignee hoặc nhóm", make("assignees", "Gõ tên user hoặc nhóm…", { search: userAndGroupSearch })),
    field("created", "Ngày tạo", dateRange("created", "Ngày tạo")),
    field("updated", "Ngày cập nhật", dateRange("updated", "Ngày cập nhật")),
    field("statuses", "Status", make("statuses", "Chọn status…")),
    field("issuetypes", "Issue type", make("issuetypes", "Chọn issue type…")),
  );

  const custom = createCustomFilters({
    container: $("custom-filters"),
    addButton: $("btn-add-custom"),
    onChange: (list) => { store.profile.customFilters = list; saveProfile(); changed(); },
  });

  ms.projects.onChange = () => { loadSprints(); changed(); };

  async function loadSprints() {
    const keys = ms.projects.values();
    ms.sprints.input.placeholder = keys.length ? "Chọn sprint…" : "Chọn project trước…";
    if (!keys.length) { ms.sprints.setOptions([]); ms.sprints.setSelected([]); return; }
    try {
      const lists = await Promise.all(keys.map((k) => getJson(`/api/meta/sprints?project=${encodeURIComponent(k)}`)));
      const opts = lists.flat().map((s) => ({ value: String(s.id), label: `${s.name}${s.state ? ` [${s.state}]` : ""} · ${s.board}` }));
      ms.sprints.setOptions(opts);
      const kept = ms.sprints.selected.filter((s) => opts.some((o) => o.value === s.value));
      if (kept.length !== ms.sprints.selected.length) { ms.sprints.setSelected(kept); changed(); }
    } catch (e) {
      setMsg(`Không tải được sprint: ${e.message}`, "err");
    }
  }

  // ---- show / hide individual filters ---------------------------------------

  function applyVisibility() {
    const hidden = new Set(store.profile.ui.hiddenFilters);
    for (const f of FILTERS) wrappers[f.id].hidden = hidden.has(f.id);
    $("visibility-menu").replaceChildren(...FILTERS.map((f) => el("label", {},
      el("input", {
        type: "checkbox", checked: !hidden.has(f.id),
        onchange: (e) => {
          const set = new Set(store.profile.ui.hiddenFilters);
          if (e.target.checked) set.delete(f.id); else set.add(f.id);
          store.profile.ui.hiddenFilters = [...set];
          saveProfile();
          applyVisibility();
        },
      }), f.label)));
  }
  bindMenu($("btn-visibility"), $("visibility-menu"));

  // ---- query <-> UI ----------------------------------------------------------

  function split(id) {
    const vals = ms[id].values();
    return {
      users: vals.filter((v) => v.startsWith("u:")).map((v) => v.slice(2)),
      groups: vals.filter((v) => v.startsWith("g:")).map((v) => v.slice(2)),
    };
  }

  function structuredQuery() {
    const rep = split("reporters");
    const asg = split("assignees");
    return {
      projects: ms.projects.values(),
      labels: ms.labels.values(),
      sprints: ms.sprints.values().map(Number),
      reporters: rep.users, reporter_groups: rep.groups,
      assignees: asg.users, assignee_groups: asg.groups,
      statuses: ms.statuses.values(),
      issue_types: ms.issuetypes.values(),
      created_from: dates.created.from.value || null, created_to: dates.created.to.value || null,
      updated_from: dates.updated.from.value || null, updated_to: dates.updated.to.value || null,
      custom_filters: custom.active(),
    };
  }

  function getQuery() {
    if (jqlMode) {
      const jql = $("jql-text").value.trim();
      if (!jql) throw new Error("Hãy nhập JQL hoặc tắt chế độ JQL.");
      return { jql };
    }
    return structuredQuery();
  }

  function activeCount() {
    if (jqlMode) return $("jql-text").value.trim() ? 1 : 0;
    const q = structuredQuery();
    return [q.projects, q.labels, q.sprints, q.reporters.concat(q.reporter_groups), q.assignees.concat(q.assignee_groups),
      q.statuses, q.issue_types, q.custom_filters].filter((list) => list.length).length
      + (q.created_from || q.created_to ? 1 : 0) + (q.updated_from || q.updated_to ? 1 : 0);
  }

  function updateSummary() {
    const n = activeCount();
    const badge = $("filter-count");
    badge.hidden = n === 0;
    badge.textContent = String(n);
    badge.title = `${n} bộ lọc đang áp dụng`;
    $("btn-clear-filters").disabled = n === 0;
  }

  // ---- saved selection (profile.filters) ---------------------------------------

  function captureState() {
    const state = emptyFilters();
    for (const id of OPTION_FILTERS) state[id] = ms[id].selected.map((o) => ({ value: o.value, label: o.label }));
    state.created_from = dates.created.from.value; state.created_to = dates.created.to.value;
    state.updated_from = dates.updated.from.value; state.updated_to = dates.updated.to.value;
    state.jqlMode = jqlMode;
    state.jqlText = $("jql-text").value;
    return state;
  }

  function persist() {
    store.profile.filters = captureState();
    saveProfile();
  }

  async function restoreState() {
    restoring = true;
    const f = store.profile.filters;
    for (const id of OPTION_FILTERS) ms[id].setSelected(f[id]);
    dates.created.from.value = f.created_from; dates.created.to.value = f.created_to;
    dates.updated.from.value = f.updated_from; dates.updated.to.value = f.updated_to;
    $("jql-text").value = f.jqlText;
    jqlMode = f.jqlMode;
    showMode();
    await loadSprints();
    restoring = false;
    updateSummary();
  }

  function clearAll() {
    restoring = true;
    for (const id of OPTION_FILTERS) ms[id].clear();
    for (const { from, to } of Object.values(dates)) { from.value = ""; to.value = ""; }
    custom.setItems([]);
    store.profile.customFilters = [];
    $("jql-text").value = "";
    ms.sprints.setOptions([]);
    ms.sprints.input.placeholder = "Chọn project trước…";
    restoring = false;
    changed();
  }
  $("btn-clear-filters").addEventListener("click", () => { clearAll(); setMsg("Đã xóa toàn bộ bộ lọc", "ok"); });

  const opt = (value, label = value) => ({ value, label });

  async function setFromFilters(f) {
    restoring = true;
    ms.projects.setSelected(f.projects.map((k) => {
      const p = meta.projects.find((x) => x.key === k);
      return opt(k, p ? `${k} – ${p.name}` : k);
    }));
    ms.sprints.setSelected(f.sprints.map((id) => opt(String(id), `Sprint #${id}`)));
    await loadSprints();
    ms.sprints.setSelected(ms.sprints.selected.map((s) => ms.sprints.options.find((o) => o.value === s.value) || s));
    ms.labels.setSelected(f.labels.map((l) => opt(l)));
    const people = (names, groups) => [...groups.map((g) => opt(`g:${g}`, `👥 ${g} (nhóm)`)), ...names.map((u) => opt(`u:${u}`, u))];
    ms.reporters.setSelected(people(f.reporters, f.reporter_groups));
    ms.assignees.setSelected(people(f.assignees, f.assignee_groups));
    ms.statuses.setSelected(f.statuses.map((s) => opt(s)));
    ms.issuetypes.setSelected(f.issue_types.map((s) => opt(s)));
    dates.created.from.value = f.created_from || ""; dates.created.to.value = f.created_to || "";
    dates.updated.from.value = f.updated_from || ""; dates.updated.to.value = f.updated_to || "";
    const items = f.custom_filters.map((c) => ({ fieldId: c.field_id, operator: c.operator, values: c.values }));
    custom.setItems(items);
    store.profile.customFilters = items;
    restoring = false;
    changed();
  }

  // ---- JQL mode ----------------------------------------------------------------

  function showMode() {
    $("filter-grid").hidden = jqlMode;
    $("custom-filters-wrap").hidden = jqlMode;
    $("jql-panel").hidden = !jqlMode;
    $("btn-visibility").disabled = jqlMode;
    $("jql-toggle").checked = jqlMode;
  }

  $("jql-toggle").addEventListener("change", async (e) => {
    const wantJql = e.target.checked;
    e.target.disabled = true;
    try {
      if (wantJql) {
        const resp = await postJson("/api/jql/build", { ...structuredQuery(), columns: ["summary"] });
        $("jql-text").value = (await resp.json()).jql;
        jqlMode = true;
      } else {
        const text = $("jql-text").value.trim();
        if (text) {
          const parsed = await (await postJson("/api/jql/parse", { jql: text })).json();
          if (!parsed.exact) {
            const choice = await choose("Một số điều kiện không chuyển được thành bộ lọc", [
              el("p", { text: "Các điều kiện sau sẽ bị bỏ nếu chuyển về bộ lọc:" }),
              el("ul", {}, ...parsed.unsupported.map((c) => el("li", {}, el("code", { text: c })))),
            ], [{ label: "Ở lại chế độ JQL", value: "stay", primary: true }, { label: "Bỏ phần này và chuyển", value: "go" }]);
            if (choice !== "go") { e.target.checked = true; return; }
          }
          await setFromFilters(parsed.filters);
        }
        jqlMode = false;
      }
    } catch (err) {
      setMsg(err.message, "err");
      e.target.checked = jqlMode;
    } finally {
      e.target.disabled = false;
      showMode();
      changed();
    }
  });

  $("jql-text").addEventListener("input", changed);

  return {
    getQuery,
    setFromFilters,
    activeCount,
    clearAll,
    isJql: () => jqlMode,
    /** After meta is loaded or a profile is imported: show saved selections and visibility. */
    async applyProfile() {
      applyVisibility();
      custom.setItems(store.profile.customFilters);
      await restoreState();
    },
    initOptions() {
      ms.projects.setOptions(meta.projects.map((p) => opt(p.key, `${p.key} – ${p.name}`)));
      ms.statuses.setOptions(meta.statuses.map((s) => opt(s.name)));
      ms.issuetypes.setOptions(meta.issueTypes.map((t) => opt(t)));
      custom.fieldsLoaded();
    },
  };
}
