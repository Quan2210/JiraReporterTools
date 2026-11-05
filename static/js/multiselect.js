import { debounce } from "./api.js";
import { el } from "./dom.js";

const MIN_LIST_WIDTH = 240;

/**
 * Chips + dropdown. Options are {value, label}. Either static `options` or `search(q) -> Promise<options>`.
 * allowCustom: Enter / the first list entry adds the typed text itself (free-text values).
 * The dropdown is position:fixed, so no scrolling panel or dialog can clip it.
 */
export class MultiSelect {
  constructor(root, { placeholder = "", options = [], search = null, reorder = false, allowCustom = false, onChange = () => {} }) {
    Object.assign(this, { root, options, search, reorder, allowCustom, onChange, selected: [], token: 0 });
    root.classList.add("ms");
    this.input = el("input", { class: "ms-input", placeholder, autocomplete: "off", "aria-label": placeholder });
    this.box = el("div", { class: "ms-box" }, this.input);
    this.list = el("ul", { class: "ms-list", hidden: true, role: "listbox" });
    root.append(this.box, this.list);

    const refresh = debounce(() => this.refreshOptions(), 250);
    this.input.addEventListener("input", () => (this.search ? refresh() : this.renderList()));
    this.input.addEventListener("focus", () => this.refreshOptions());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this.list.hidden = true; e.stopPropagation(); }
      if (e.key === "Enter") {
        e.preventDefault();
        const first = this.visibleOptions()[0];
        if (first) this.add(first);
      }
      if (e.key === "Backspace" && !this.input.value && this.selected.length) this.remove(this.selected.at(-1).value);
    });
    this.onDocClick = (e) => { if (!root.contains(e.target)) this.list.hidden = true; };
    this.reposition = () => { if (!this.list.hidden) this.place(); };
    document.addEventListener("click", this.onDocClick);
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, { capture: true, passive: true });
  }

  /** Detach the global listeners (call when the control is thrown away, e.g. a deleted row). */
  destroy() {
    document.removeEventListener("click", this.onDocClick);
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, { capture: true });
    this.list.hidden = true;
  }

  async refreshOptions() {
    if (this.search) {
      const token = ++this.token;
      try {
        const result = await this.search(this.input.value.trim());
        if (token !== this.token) return;
        this.options = result;
      } catch { this.options = []; }
    }
    this.renderList();
  }

  visibleOptions() {
    const text = this.input.value.trim();
    const q = text.toLowerCase();
    const chosen = new Set(this.selected.map((s) => s.value));
    const found = this.options
      .filter((o) => !chosen.has(o.value) && (this.search || !q || o.label.toLowerCase().includes(q)))
      .slice(0, 200);
    if (this.allowCustom && text && !chosen.has(text) && !found.some((o) => o.value === text)) {
      found.unshift({ value: text, label: text, custom: true });
    }
    return found;
  }

  /** Anchor the fixed list under the box, or above it when there is no room below. */
  place() {
    const r = this.box.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 180 && above > below;
    const width = Math.max(r.width, MIN_LIST_WIDTH);
    Object.assign(this.list.style, {
      left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(120, Math.min(300, up ? above : below))}px`,
      top: up ? "auto" : `${r.bottom + 4}px`,
      bottom: up ? `${innerHeight - r.top + 4}px` : "auto",
    });
  }

  renderList() {
    const items = this.visibleOptions();
    this.list.replaceChildren(...(items.length
      ? items.map((opt) => el("li", {
        role: "option",
        text: opt.custom ? `Dùng "${opt.label}"` : opt.label,
        onmousedown: (e) => { e.preventDefault(); this.add(opt); },
      }))
      : [el("li", { class: "empty", text: "Không có lựa chọn" })]));
    this.list.hidden = false;
    this.place();
  }

  setOptions(options) { this.options = options; if (!this.list.hidden) this.renderList(); }

  add(opt) {
    if (this.selected.some((s) => s.value === opt.value)) return;
    this.selected.push({ value: opt.value, label: opt.label });
    this.input.value = "";
    this.renderChips();
    this.renderList();
    this.onChange();
  }

  remove(value) {
    this.selected = this.selected.filter((s) => s.value !== value);
    this.renderChips();
    this.onChange();
  }

  move(value, delta) {
    const i = this.selected.findIndex((s) => s.value === value);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.selected.length) return;
    [this.selected[i], this.selected[j]] = [this.selected[j], this.selected[i]];
    this.renderChips();
    this.onChange();
  }

  setSelected(opts, { silent = true } = {}) {
    this.selected = opts.map((o) => ({ value: o.value, label: o.label }));
    this.renderChips();
    if (!silent) this.onChange();
  }

  clear() { this.setSelected([]); this.input.value = ""; }

  values() { return this.selected.map((s) => s.value); }

  renderChips() {
    this.box.querySelectorAll(".chip").forEach((c) => c.remove());
    for (const opt of this.selected) {
      const btn = (text, title, fn) => el("button", { type: "button", text, title, "aria-label": `${title}: ${opt.label}`, onclick: (e) => { e.preventDefault(); fn(); } });
      const chip = el("span", { class: "chip" },
        el("span", { class: "t", text: opt.label, title: opt.label }),
        this.reorder && btn("◀", "Sang trái", () => this.move(opt.value, -1)),
        this.reorder && btn("▶", "Sang phải", () => this.move(opt.value, 1)),
        btn("✕", "Bỏ chọn", () => this.remove(opt.value)));
      this.box.insertBefore(chip, this.input);
    }
  }
}
