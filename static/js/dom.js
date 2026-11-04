import { textColorFor } from "./lib/color.js";

export const $ = (id) => document.getElementById(id);

/** Tiny element builder. Text is always set through textContent / text nodes (Jira data is untrusted). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Give a node a Jira status colour. CSS decides how it looks in the light and dark theme. */
export function applyStatus(node, hex) {
  node.classList.add("st");
  node.style.setProperty("--st", hex);
  node.style.setProperty("--st-ink", textColorFor(hex));
}

// ---- toast ----------------------------------------------------------------

let toastTimer = null;

/** kind: "" (stays until replaced) | "ok" (4 s) | "err" (10 s). setMsg("") hides it. */
export function setMsg(text, kind = "") {
  const toast = $("toast");
  clearTimeout(toastTimer);
  if (!text) { toast.hidden = true; return; }
  toast.textContent = text;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  if (kind) toastTimer = setTimeout(() => { toast.hidden = true; }, kind === "err" ? 10000 : 4000);
}

// ---- menus / popovers -----------------------------------------------------

/** Click the button to toggle the menu; click elsewhere or press Esc to close it. */
export function bindMenu(button, menu) {
  const close = () => { menu.hidden = true; button.setAttribute("aria-expanded", "false"); };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    document.dispatchEvent(new CustomEvent("close-menus"));
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("close-menus", close);
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { close(); button.focus(); } });
  return close;
}

export function download(blob, filename) {
  const a = el("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/** Modal with custom buttons; resolves to the clicked button's value (null if dismissed). */
export function choose(title, bodyNodes, buttons) {
  const dlg = $("dlg-confirm");
  $("confirm-title").textContent = title;
  $("confirm-body").replaceChildren(...bodyNodes);
  return new Promise((resolve) => {
    const actions = $("confirm-actions");
    actions.replaceChildren(...buttons.map((b) =>
      el("button", { type: "button", class: `btn${b.primary ? " btn-primary" : ""}`, text: b.label, onclick: () => { dlg.close(); resolve(b.value); } })));
    dlg.addEventListener("close", () => resolve(null), { once: true });
    dlg.showModal();
  });
}
