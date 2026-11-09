import { getJson } from "./api.js";
import { el, iconButton } from "./dom.js";
import { MultiSelect } from "./multiselect.js";
import { meta } from "./meta.js";
import { MAX_RULES, RULE_ACTIONS, RULE_OPS, newRule, splitValues } from "./lib/reminder-form.js";
import { attachVarPicker } from "./varpicker.js";

let ruleSeq = 0;

const suggest = (field) => async (q) =>
  (await getJson(`/api/meta/suggest?field=${encodeURIComponent(field)}&q=${encodeURIComponent(q)}`)).map((v) => ({ value: v, label: v }));

/** Status first, then the Jira fields: the default list of fields a rule can look at. */
export const allFieldOptions = () => [{ id: "status", name: "Status" }, ...meta.fields.filter((f) => f.id !== "status" && f.id !== "issuekey")];

/**
 * The note-rules editor shared by the reminder form and the "Xuất tin nhắn" dialog. Each rule reads as a sentence:
 * "Khi [field] [op] [values]" / "Thì [Ghi chú | Ẩn dòng] [text]".
 *
 *   list, empty, addButton : elements (the rule cards, the "no rules yet" hint, the "+" button)
 *   onChange()             : called after any edit (rules are edited in place; read them with getRules())
 *   onAdd()                : called after a rule is added (e.g. to open the collapsed section)
 *   fieldOptions()         : [{id, name, custom?}] the fields a rule may use
 *   variables()            : [{id, label}] for the "{" suggestions in a note text
 *
 * A row keeps its controls alive; only add / delete / reorder rebuild the list.
 */
export function createRulesEditor({ list, empty, addButton, onChange = () => {}, onAdd = () => {}, fieldOptions = allFieldOptions, variables = () => [] }) {
  let rules = [];
  let views = [];

  function fillFieldSelect(select, current) {
    const options = fieldOptions();
    if (current && !options.some((f) => f.id === current)) options.push({ id: current, name: current });
    select.replaceChildren(...options.map((f) => el("option", { value: f.id, text: f.custom ? `${f.name} (custom)` : f.name })));
    select.value = current ?? options[0]?.id ?? "status";
  }

  function ruleView(rule) {
    const field = el("select", { class: "rule-field", "aria-label": "Field" });
    fillFieldSelect(field, rule.field);
    const op = el("select", { class: "rule-op", "aria-label": "Phép so sánh" }, ...RULE_OPS.map((o) => el("option", { value: o.id, text: o.label })));
    op.value = rule.op;
    const host = el("div", { class: "rule-values" });
    const ms = new MultiSelect(host, { placeholder: "Chọn hoặc gõ giá trị, Enter để thêm", allowCustom: true, onChange: () => { rule.values = ms.values(); onChange(); } });
    const contains = el("input", { type: "text", class: "rule-contains", placeholder: "Từ cần tìm", "aria-label": "Từ cần tìm", autocomplete: "off" });
    const action = el("select", { class: "rule-action", "aria-label": "Hành động" }, ...RULE_ACTIONS.map((a) => el("option", { value: a.id, text: a.label })));
    action.value = rule.action;
    const text = el("input", { type: "text", class: "rule-text", maxLength: 200, placeholder: "Nội dung ghi chú, gõ { để chèn biến", "aria-label": "Nội dung ghi chú", autocomplete: "off", value: rule.text ?? "" });
    text.id = `rule-text-${++ruleSeq}`;
    const hint = el("span", { class: "muted rule-hint", text: "Issue này sẽ không xuất hiện trong tin" });
    const picker = attachVarPicker(text, null, variables);

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
      onChange();
    });
    op.addEventListener("change", () => {
      const carry = rule.values ?? [];
      rule.op = op.value;
      if (rule.op === "empty" || rule.op === "not_empty") rule.values = [];
      else if (rule.op === "contains") { rule.values = carry.slice(0, 1); contains.value = rule.values[0] ?? ""; }
      else { rule.values = carry; ms.setSelected(carry.map((v) => ({ value: v, label: v }))); }
      sync();
      onChange();
    });
    contains.addEventListener("input", () => { rule.values = splitValues(contains.value).slice(0, 1); onChange(); });
    action.addEventListener("change", () => { rule.action = action.value; sync(); onChange(); });
    text.addEventListener("input", () => { rule.text = text.value; onChange(); });

    const move = (by) => () => {
      const i = rules.indexOf(rule);
      const j = i + by;
      if (j < 0 || j >= rules.length) return;
      [rules[i], rules[j]] = [rules[j], rules[i]];
      render();
      onChange();
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
        iconButton("trash", "Xóa quy tắc", () => { rules.splice(rules.indexOf(rule), 1); render(); onChange(); }, { danger: true })));
    return { rule, picker, ms, node };
  }

  function destroyViews() {
    for (const view of views) { view.picker.destroy(); view.ms.destroy(); }
    views = [];
  }

  function render() {
    destroyViews();
    views = rules.map(ruleView);
    list.replaceChildren(...views.map((v) => v.node));
    if (empty) empty.hidden = rules.length > 0;
    addButton.disabled = rules.length >= MAX_RULES;
  }

  addButton.addEventListener("click", () => {
    if (rules.length >= MAX_RULES) return;
    rules.push(newRule(fieldOptions()[0]?.id ?? "status"));
    render();
    onAdd();
    onChange();
    list.lastElementChild?.querySelector("input:not([hidden])")?.focus();
  });

  return {
    /** Replace the rules (a copy is edited; the caller's objects are untouched). */
    setRules(next) {
      rules = (next ?? []).map((r) => ({ ...r, values: [...(r.values ?? [])] }));
      render();
    },
    getRules: () => rules,
    count: () => rules.length,
    destroy: destroyViews,
  };
}
