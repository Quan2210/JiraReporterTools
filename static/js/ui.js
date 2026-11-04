import { $, setMsg } from "./dom.js";
import { iconSvg } from "./icons.js";

const THEME_KEY = "jira-report-theme";
const THEMES = [
  { id: "system", icon: "auto", label: "Theo hệ thống" },
  { id: "light", icon: "sun", label: "Sáng" },
  { id: "dark", icon: "moon", label: "Tối" },
];

function readTheme() {
  try { const t = localStorage.getItem(THEME_KEY); return THEMES.some((x) => x.id === t) ? t : "system"; } catch { return "system"; }
}

export function initTheme() {
  const button = $("btn-theme");
  let current = readTheme();
  const apply = () => {
    const theme = THEMES.find((t) => t.id === current);
    if (current === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = current;
    button.querySelector(".ico").innerHTML = iconSvg(theme.icon);
    button.title = `Giao diện: ${theme.label} (bấm để đổi)`;
    button.setAttribute("aria-label", `Giao diện: ${theme.label}. Bấm để đổi`);
  };
  button.addEventListener("click", () => {
    current = THEMES[(THEMES.findIndex((t) => t.id === current) + 1) % THEMES.length].id;
    try { localStorage.setItem(THEME_KEY, current); } catch { /* storage blocked: the choice just lasts for this visit */ }
    apply();
  });
  apply();
}

/** Focus mode hides the filter sidebar so the table / dashboard gets the whole width; the top bar stays. */
export function initFocusMode() {
  const button = $("btn-focus");
  const set = (on) => {
    document.body.classList.toggle("focus", on);
    $("sidebar").inert = on;
    button.setAttribute("aria-pressed", String(on));
    button.querySelector(".ico").innerHTML = iconSvg(on ? "collapse" : "expand");
    button.querySelector(".lbl").textContent = on ? "Thu nhỏ" : "Mở rộng";
    button.title = on ? "Hiện lại bộ lọc (Esc)" : "Ẩn bộ lọc để xem rộng hơn";
  };
  button.addEventListener("click", () => set(!document.body.classList.contains("focus")));
  document.addEventListener("keydown", (e) => {
    const busy = document.querySelector("dialog[open]") || document.querySelector(".menu:not([hidden]), .popover:not([hidden]), .ms-list:not([hidden])");
    if (e.key === "Escape" && document.body.classList.contains("focus") && !busy) set(false);
  });
  set(false);
}

export function initFullscreen() {
  const button = $("btn-fullscreen");
  if (!document.documentElement.requestFullscreen) { button.hidden = true; return; }
  const sync = () => {
    const on = !!document.fullscreenElement;
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Thoát toàn màn hình" : "Toàn màn hình";
    button.setAttribute("aria-label", button.title);
  };
  button.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setMsg("Trình duyệt không cho phép toàn màn hình ở đây. Hãy thử phím F11.", "err");
    }
  });
  document.addEventListener("fullscreenchange", sync);
  sync();
}
