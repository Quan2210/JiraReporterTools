import { el } from "./dom.js";
import { iconSvg } from "./icons.js";
import { autoSlash, isoToDisplay, parseDisplay } from "./lib/dates.js";

/**
 * Date input shown as dd/MM/yyyy whatever the browser's locale is, with a calendar button.
 * `.value` reads and writes the ISO date ("2026-10-01"), or "" when empty / not a valid date yet.
 */
export function createDateField({ label, onChange = () => {} }) {
  let iso = "";
  const text = el("input", {
    type: "text", class: "date-text", inputMode: "numeric", placeholder: "dd/MM/yyyy", maxLength: 10,
    autocomplete: "off", "aria-label": label,
  });
  const native = el("input", { type: "date", class: "date-native", tabIndex: -1, "aria-hidden": "true" });
  const button = el("button", { type: "button", class: "date-btn", title: "Chọn từ lịch", "aria-label": `Mở lịch: ${label}` });
  button.innerHTML = iconSvg("calendar");
  button.querySelector("svg").classList.add("date-ico");

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

  return {
    el: el("div", { class: "date-field" }, text, button, native),
    get value() { return iso; },
    set value(v) {
      iso = v || "";
      text.value = iso ? isoToDisplay(iso) : "";
      native.value = iso;
      setInvalid(false);
    },
  };
}
