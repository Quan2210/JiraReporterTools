import { $, bindMenu, choose, download, el, setMsg } from "./dom.js";
import { CATEGORY_DEFAULTS, isHexColor, statusColor } from "./lib/color.js";
import { ProfileError, mergeNotes, parseProfileText, serializeProfile } from "./lib/profile.js";
import { meta } from "./meta.js";
import { onPersist, replaceProfile, saveProfile, store } from "./store.js";

export function initProfileUi({ onProfileApplied, onColorsChanged }) {
  onPersist(() => { $("persist-warn").hidden = !store.persistFailed; });
  const closeMenu = bindMenu($("btn-profile-menu"), $("profile-menu"));
  $("profile-menu").addEventListener("click", closeMenu);

  // ---- export / import ------------------------------------------------------

  $("btn-profile-export").addEventListener("click", () => {
    download(new Blob([serializeProfile(store.profile)], { type: "application/json" }), "jira-report-profile.json");
    setMsg("Đã tải hồ sơ về máy.", "ok");
  });

  $("btn-profile-import").addEventListener("click", () => $("profile-file").click());
  $("profile-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new ProfileError("File hồ sơ quá lớn (tối đa 5 MB)");
      const incoming = parseProfileText(await file.text());
      const noteCount = Object.keys(incoming.notes).length;
      const choice = await choose("Nhập hồ sơ", [
        el("p", { text: `Hồ sơ "${incoming.name || file.name}" có ${noteCount} ghi chú, ${incoming.customFilters.length} bộ lọc tuỳ chỉnh và ${Object.keys(incoming.statusColors).length} màu status.` }),
        el("p", { class: "muted", text: "Ghi đè sẽ thay toàn bộ cấu hình hiện tại. Gộp ghi chú chỉ thêm các ghi chú chưa có, giữ nguyên mọi thiết lập khác." }),
      ], [
        { label: "Ghi đè toàn bộ", value: "replace", primary: true },
        { label: "Chỉ gộp ghi chú", value: "merge" },
        { label: "Huỷ", value: null },
      ]);
      if (!choice) return;
      replaceProfile(choice === "merge" ? mergeNotes(store.profile, incoming) : incoming);
      await onProfileApplied();
      setMsg(choice === "merge" ? "Đã gộp ghi chú." : "Đã nhập hồ sơ.", "ok");
    } catch (err) {
      setMsg(err instanceof ProfileError ? err.message : "Không đọc được file hồ sơ", "err");
    }
  });

  // ---- status colours ---------------------------------------------------------

  const colorOf = (name) => statusColor(name, store.profile.statusColors, meta.statusCategories) || "#FFFFFF";

  function renderColorList() {
    $("color-list").replaceChildren(...meta.statuses.map((s) => {
      const input = el("input", {
        type: "color", value: colorOf(s.name).toLowerCase(), "aria-label": `Màu cho ${s.name}`,
        onchange: (e) => {
          const value = e.target.value.toUpperCase();
          if (!isHexColor(value)) return;
          if (value === (CATEGORY_DEFAULTS[s.category] || "").toUpperCase()) delete store.profile.statusColors[s.name];
          else store.profile.statusColors[s.name] = value;
          saveProfile();
          onColorsChanged();
        },
      });
      return el("div", { class: "color-row" },
        el("span", { text: s.name }), input,
        el("button", {
          type: "button", class: "btn btn-icon", text: "↺", title: "Về màu mặc định", "aria-label": `Về màu mặc định của ${s.name}`,
          onclick: () => { delete store.profile.statusColors[s.name]; saveProfile(); renderColorList(); onColorsChanged(); },
        }));
    }));
  }

  $("btn-colors").addEventListener("click", () => {
    for (const radio of document.querySelectorAll('input[name="color-scope"]')) radio.checked = radio.value === store.profile.ui.colorScope;
    renderColorList();
    $("dlg-colors").showModal();
  });
  for (const radio of document.querySelectorAll('input[name="color-scope"]')) {
    radio.addEventListener("change", (e) => {
      store.profile.ui.colorScope = e.target.value;
      saveProfile();
      onColorsChanged();
    });
  }
  $("colors-reset").addEventListener("click", () => {
    store.profile.statusColors = {};
    saveProfile();
    renderColorList();
    onColorsChanged();
  });
}
