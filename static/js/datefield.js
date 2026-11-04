import { el } from "./dom.js";
import { iconSvg } from "./icons.js";
import { MAX_DATE_OFFSET_DAYS, autoSlash, isoToDisplay, makeDateToken, parseDateToken, parseDisplay, tokenShort } from "./lib/dates.js";

/**
 * Date input shown as dd/MM/yyyy whatever the browser's locale is, with a calendar button.
 * `.value` reads and writes the ISO date ("2026-10-01"), or "" when empty / not a valid date yet.
 * A second button switches to a dynamic date ("today", "today-7", "today+3"): the field then shows one short label
 * ("Hôm nay", "−7 ngày") that opens a small popover to change it, and `.value` is the token. The server turns the
 * token into the real date on every run, so a saved filter or reminder follows the calendar.
 */
export function createDateField({ label, onChange = () => {}, allowDynamic = true, placeholder = "dd/MM/yyyy" }) {
  let iso = "";
  let dynamic = false;
  let token = "today";
  const text = el("input", {
    type: "text", class: "date-text", inputMode: "numeric", placeholder, maxLength: 10,
    autocomplete: "off", "aria-label": label,
  });
  const native = el("input", { type: "date", class: "date-native", tabIndex: -1, "aria-hidden": "true" });
  const button = el("button", { type: "button", class: "date-btn", title: "Chọn từ lịch", "aria-label": `Mở lịch: ${label}` });
  button.innerHTML = iconSvg("calendar");
  button.querySelector("svg").classList.add("date-ico");

  const dynBtn = el("button", { type: "button", class: "date-btn date-dyn-btn", "aria-pressed": "false", title: "Ngày động: hôm nay ± N ngày", "aria-label": `Ngày động: ${label}` });
  dynBtn.innerHTML = iconSvg("refresh");
  dynBtn.querySelector("svg").classList.add("date-ico");

  const dynLabel = el("button", { type: "button", class: "date-dyn-label", hidden: true, "aria-haspopup": "dialog", "aria-expanded": "false" });
  const mode = el("select", { class: "date-dyn-mode", title: "So với hôm nay", "aria-label": `${label}: so với hôm nay` },
    el("option", { value: "", text: "Hôm nay" }), el("option", { value: "-", text: "Trước hôm nay" }), el("option", { value: "+", text: "Sau hôm nay" }));
  const days = el("input", { type: "number", class: "date-dyn-days", min: "1", max: String(MAX_DATE_OFFSET_DAYS), value: "1", title: "Số ngày", "aria-label": `${label}: số ngày` });
  const pop = el("div", { class: "date-dyn-pop", role: "dialog", "aria-label": `${label}: ngày động`, hidden: true }, mode, days, el("span", { class: "muted", text: "ngày" }));

  const setInvalid = (bad) => {
    text.classList.toggle("bad", bad);
    text.setAttribute("aria-invalid", String(bad));
    text.title = bad ? "Ngày không hợp lệ. Nhập theo dạng dd/MM/yyyy." : "";
  };

  function apply(next, { notify }) {
    const changed = next !== iso;
    iso = next;
    native.value = iso;
    if (changed && notify) onChange();
  }

  function closePop() {
    pop.hidden = true;
    dynLabel.setAttribute("aria-expanded", "false");
  }

  function showMode() {
    text.hidden = button.hidden = native.hidden = dynamic;
    dynLabel.hidden = !dynamic;
    dynLabel.textContent = tokenShort(token);
    dynLabel.title = `Ngày động (${tokenShort(token)}). Bấm để đổi.`;
    dynBtn.setAttribute("aria-pressed", String(dynamic));
    dynBtn.classList.toggle("on", dynamic);
    dynBtn.title = dynamic ? "Về ngày cố định" : "Ngày động: hôm nay ± N ngày";
    days.hidden = !mode.value;
    pop.querySelector(".muted").hidden = !mode.value;
    if (!dynamic) closePop();
  }

  function openPop() {
    pop.hidden = false;
    dynLabel.setAttribute("aria-expanded", "true");
    const rect = dynLabel.getBoundingClientRect();
    const width = pop.offsetWidth || 230;
    pop.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))}px`;
    pop.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - pop.offsetHeight - 4)}px`;
    (mode.value ? days : mode).focus({ preventScroll: true });
  }

  function readDynamic() {
    token = makeDateToken(mode.value, days.value);
    if (mode.value && token === "today") days.value = "1";       // "-" with 0 days is just today: keep the control honest
  }

  function setDynamic(on, { notify }) {
    if (on === dynamic) return;
    dynamic = on;
    if (on) { mode.value = ""; days.value = "1"; token = "today"; iso = ""; text.value = ""; native.value = ""; setInvalid(false); }
    showMode();
    if (notify) onChange();
  }

  text.addEventListener("input", () => {
    const tidy = autoSlash(text.value);
    if (tidy !== text.value) text.value = tidy;
    const parsed = text.value === "" ? "" : parseDisplay(text.value);
    setInvalid(parsed === null && text.value.length >= 10);
    apply(parsed ?? "", { notify: true });
  });
  text.addEventListener("blur", () => {
    const bad = text.value !== "" && parseDisplay(text.value) === null;
    setInvalid(bad);
  });
  button.addEventListener("click", () => { try { native.showPicker(); } catch { native.focus(); native.click(); } });
  native.addEventListener("change", () => {
    text.value = native.value ? isoToDisplay(native.value) : "";
    setInvalid(false);
    apply(native.value, { notify: true });
  });

  dynBtn.addEventListener("click", () => setDynamic(!dynamic, { notify: true }));
  dynLabel.addEventListener("click", () => (pop.hidden ? openPop() : closePop()));
  const onDynChange = () => { readDynamic(); showMode(); onChange(); };
  mode.addEventListener("change", () => { onDynChange(); if (mode.value) days.focus({ preventScroll: true }); });
  days.addEventListener("input", onDynChange);
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); closePop(); dynLabel.focus(); }
  });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !dynLabel.contains(e.target)) closePop(); });
  document.addEventListener("scroll", (e) => { if (!pop.hidden && !pop.contains(e.target)) closePop(); }, true);

  return {
    el: el("div", { class: `date-field${allowDynamic ? "" : " no-dyn"}` }, text, button, native, dynLabel, allowDynamic ? dynBtn : null, pop),
    get value() { return dynamic ? token : iso; },
    set value(v) {
      const parsed = parseDateToken(v);
      if (parsed) {
        dynamic = true;
        mode.value = parsed.sign;
        days.value = String(parsed.days || 1);
        token = makeDateToken(parsed.sign, parsed.days);
        iso = ""; text.value = ""; native.value = "";
        setInvalid(false);
        showMode();
        return;
      }
      dynamic = false;
      iso = v || "";
      text.value = iso ? isoToDisplay(iso) : "";
      native.value = iso;
      setInvalid(false);
      showMode();
    },
  };
}
