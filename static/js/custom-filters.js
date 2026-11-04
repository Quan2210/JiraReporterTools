import { getJson } from "./api.js";
import { $, el } from "./dom.js";
import { createDateField } from "./datefield.js";
import { MultiSelect } from "./multiselect.js";
import { meta } from "./meta.js";

const OP_LABELS = {
  in: "là một trong", not_in: "không phải", eq: "bằng", neq: "khác", contains: "chứa",
  gt: "lớn hơn", gte: "lớn hơn hoặc bằng", lt: "nhỏ hơn", lte: "nhỏ hơn hoặc bằng", empty: "để trống", not_empty: "có giá trị",
};
const OPS_BY_KIND = {
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "empty", "not_empty"],
  date: ["gte", "lte", "gt", "lt", "eq", "empty", "not_empty"],
  text: ["contains", "eq", "neq", "empty", "not_empty"],
  list: ["in", "not_in", "empty", "not_empty"],
};
const NO_VALUE = new Set(["empty", "not_empty"]);
const MULTI = new Set(["in", "not_in"]);

export function kindOf(type) {
  if (type === "number") return "number";
  if (type === "date" || type === "datetime") return "date";
  if (type === "string") return "text";
  return "list";
}

let seq = 0;
const newId = () => `cf${Date.now().toString(36)}${seq++}`;

export function createCustomFilters({ container, addButton, onChange }) {
  let items = [];

  const searchableFields = () => meta.fields.filter((f) => f.searchable);

  function emit() { onChange(items.map((i) => ({ ...i, values: [...i.values] }))); }

  function valueControl(item) {
    if (NO_VALUE.has(item.operator) || !item.fieldId) return el("span");
    if (MULTI.has(item.operator)) {
      const host = el("div");
      const ms = new MultiSelect(host, {
        placeholder: "Gõ giá trị, Enter để thêm",
        allowCustom: true,
        search: async (q) => (await getJson(`/api/meta/suggest?field=${encodeURIComponent(item.fieldId)}&q=${encodeURIComponent(q)}`))
          .map((v) => ({ value: v, label: v })),
        onChange: () => { item.values = ms.values(); emit(); },
      });
      ms.setSelected(item.values.map((v) => ({ value: v, label: v })));
      return host;
    }
    const kind = kindOf(meta.fieldById[item.fieldId]?.type);
    if (kind === "date") {
      const field = createDateField({ label: "Giá trị ngày", onChange: () => { item.values = field.value ? [field.value] : []; emit(); } });
      field.value = item.values[0] || "";
      return field.el;
    }
    return el("input", {
      type: kind === "number" ? "number" : "text",
      step: kind === "number" ? "any" : undefined,
      value: item.values[0] || "",
      placeholder: "Giá trị",
      oninput: (e) => { item.values = e.target.value === "" ? [] : [e.target.value]; emit(); },
    });
  }

  function row(item) {
    const wrap = el("div", { class: "cf-row" });
    const draw = () => {
      const type = meta.fieldById[item.fieldId]?.type;
      const ops = OPS_BY_KIND[kindOf(type)];
      if (!ops.includes(item.operator)) item.operator = ops[0];
      wrap.replaceChildren(
        el("select", {
          onchange: (e) => { item.fieldId = e.target.value; item.values = []; draw(); emit(); },
        }, el("option", { value: "", text: "— chọn field —" }),
        ...searchableFields().map((f) => el("option", { value: f.id, text: f.name, selected: f.id === item.fieldId }))),
        el("select", {
          disabled: !item.fieldId,
          onchange: (e) => { item.operator = e.target.value; if (!MULTI.has(item.operator)) item.values = item.values.slice(0, 1); draw(); emit(); },
        }, ...ops.map((op) => el("option", { value: op, text: OP_LABELS[op], selected: op === item.operator }))),
        valueControl(item),
        el("button", { type: "button", title: "Xoá bộ lọc", text: "✕", onclick: () => { items = items.filter((i) => i !== item); render(); emit(); } }));
    };
    draw();
    return wrap;
  }

  function render() { container.replaceChildren(...items.map(row)); }

  addButton.addEventListener("click", () => {
    items.push({ id: newId(), fieldId: "", operator: "in", values: [] });
    render();
  });

  return {
    setItems(list) {
      items = list.map((i) => ({ id: i.id || newId(), fieldId: i.fieldId, operator: i.operator, values: [...(i.values || [])] }));
      render();
    },
    /** Only complete filters are sent to the backend. */
    active() {
      return items.filter((i) => i.fieldId && (NO_VALUE.has(i.operator) || (MULTI.has(i.operator) ? i.values.length : i.values.length === 1)))
        .map((i) => ({ field_id: i.fieldId, operator: i.operator, values: NO_VALUE.has(i.operator) ? [] : i.values }));
    },
    count() { return this.active().length; },
    fieldsLoaded() { render(); },
  };
}
