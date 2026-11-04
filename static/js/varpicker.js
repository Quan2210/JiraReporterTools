import { el } from "./dom.js";
import { iconSvg } from "./icons.js";
import { completeVariable, filterVariables, insertVariable, varTokenAt } from "./lib/reminder-form.js";

/**
 * Variable suggestions for a text input holding a template such as "{key}: {summary}".
 *  - typing "{" (or "{par") opens a list of variables; arrows move, Enter / Tab / click completes to "{id}", Esc closes;
 *  - a "+" button opens the same list (with a search box) and inserts "{id}" at the caret.
 * getOptions() returns [{id, label, hint?}] and is called each time the list opens.
 */
export function attachVarPicker(input, button, getOptions) {
  const list = el("div", { class: "var-pop", role: "listbox", hidden: true });
  const search = el("input", { type: "text", class: "var-search", placeholder: "Tìm cột…", "aria-label": "Tìm biến", autocomplete: "off" });
  const items = el("div", { class: "var-items" });
  list.append(search, items);
  (input.closest("dialog") ?? document.body).append(list);   // a modal <dialog> is in the top layer: the list must be inside it

  let mode = "typing";                     // "typing": filtered by what follows "{"; "button": filtered by the search box
  let shown = [];
  let active = 0;
  let caret = { start: 0, end: 0 };        // remembered because the input loses focus when the button is used

  const remember = () => { caret = { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length }; };

  function place() {
    const anchor = (mode === "button" ? button : input).getBoundingClientRect();
    const width = Math.max(260, Math.min(360, anchor.width));
    list.style.width = `${width}px`;
    list.style.left = `${Math.max(4, Math.min(anchor.right - width, window.innerWidth - width - 4))}px`;
    const below = anchor.bottom + 4;
    const room = window.innerHeight - below - 8;
    if (room < 180 && anchor.top > room) {                    // not enough room below: open upwards
      list.style.top = "";
      list.style.bottom = `${window.innerHeight - anchor.top + 4}px`;
      items.style.maxHeight = `${Math.min(280, anchor.top - 60)}px`;
    } else {
      list.style.bottom = "";
      list.style.top = `${below}px`;
      items.style.maxHeight = `${Math.max(120, Math.min(280, room - 44))}px`;
    }
  }

  function close() {
    list.hidden = true;
    input.removeAttribute("aria-activedescendant");
  }

  function paint() {
    items.replaceChildren(...(shown.length ? shown.map((option, i) => el("div", {
      role: "option", id: `${input.id}-opt-${i}`, class: `var-item${i === active ? " active" : ""}`, "aria-selected": String(i === active),
      // mousedown, not click: the input must not lose focus / caret before we insert
      onmousedown: (e) => { e.preventDefault(); choose(option); },
    }, el("code", { text: `{${option.id}}` }), el("span", { class: "var-label", text: option.label }),
    option.hint ? el("span", { class: "var-hint", text: option.hint }) : null))
      : [el("div", { class: "var-empty", text: "Không có biến phù hợp" })]));
    input.setAttribute("aria-activedescendant", `${input.id}-opt-${active}`);
    items.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  function open(nextMode, query) {
    mode = nextMode;
    shown = filterVariables(getOptions(), query, 60);
    active = 0;
    search.hidden = mode !== "button";
    list.hidden = false;
    place();
    paint();
  }

  function write(result) {
    input.value = result.text;
    input.setSelectionRange(result.caret, result.caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function choose(option) {
    const text = input.value;
    if (mode === "typing") {
      const token = varTokenAt(text, input.selectionStart ?? text.length);
      if (token) write(completeVariable(text, input.selectionStart ?? text.length, token, option.id));
    } else {
      write(insertVariable(text, caret.start, caret.end, option.id));
    }
    close();
    input.focus();
  }

  function refreshTyping() {
    const token = varTokenAt(input.value, input.selectionStart ?? input.value.length);
    if (!token) { if (mode === "typing") close(); return; }
    open("typing", token.query);
    if (!shown.length) close();
  }

  input.addEventListener("input", () => { remember(); refreshTyping(); });
  input.addEventListener("click", () => { remember(); if (!list.hidden && mode === "typing") refreshTyping(); });
  input.addEventListener("keyup", (e) => {
    remember();
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refreshTyping();
  });
  input.addEventListener("blur", () => { remember(); if (mode === "typing") close(); });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || mode !== "typing") return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, shown.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + shown.length) % Math.max(1, shown.length); paint(); }
    else if ((e.key === "Enter" || e.key === "Tab") && shown[active]) { e.preventDefault(); choose(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });

  button?.addEventListener("mousedown", () => remember());           // before the click moves focus away
  button?.addEventListener("click", () => {
    if (!list.hidden && mode === "button") { close(); return; }
    search.value = "";
    open("button", "");
    search.focus({ preventScroll: true });
  });
  search.addEventListener("input", () => { shown = filterVariables(getOptions(), search.value, 60); active = 0; paint(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, shown.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + shown.length) % Math.max(1, shown.length); paint(); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); choose(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); input.focus(); }
  });

  document.addEventListener("mousedown", (e) => {
    if (!list.hidden && !list.contains(e.target) && e.target !== input && !button?.contains(e.target)) close();
  });
  window.addEventListener("resize", close);
  document.addEventListener("scroll", (e) => { if (!list.hidden && !list.contains(e.target)) close(); }, true);

  return { close, element: list };
}

/** The "+" icon button that goes next to a variable-aware input. */
export function varButton(label = "Chèn biến Jira") {
  const button = el("button", { type: "button", class: "btn btn-icon", title: label, "aria-label": label, "aria-haspopup": "listbox" });
  button.innerHTML = `<span class="ico">${iconSvg("plus")}</span>`;
  return button;
}
