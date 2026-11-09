import { $, choose, download, el, setMsg } from "./dom.js";
import { postJson } from "./api.js";
import { statusColor } from "./lib/color.js";
import { buildExportMessage } from "./lib/message.js";
import { cleanRules } from "./lib/note-rules.js";
import { templateVariables } from "./lib/reminder-form.js";
import { buildTablePayload, payloadToHtml, payloadToTsv } from "./lib/table-payload.js";
import { meta } from "./meta.js";
import { createRulesEditor } from "./rules-editor.js";
import { saveProfile, store } from "./store.js";
import { attachVarPicker, varButton } from "./varpicker.js";

export function createActions({ table }) {
  function payload() {
    const entries = table.selectedEntries();
    return buildTablePayload({
      columns: table.columns(),
      entries,
      notes: store.profile.notes,
      showNote: store.profile.ui.showNote,
      colorFor: (row) => statusColor(row.status, store.profile.statusColors, meta.statusCategories),
      colorScope: store.profile.ui.colorScope,
      statusColId: "status",
      grouped: table.isGrouped(),
    });
  }

  async function exportFile(format) {
    const data = payload();
    if (!data.rows.length) { setMsg("Hãy tích chọn ít nhất một dòng để xuất.", "err"); return; }
    setMsg("Đang tạo file…");
    try {
      const resp = await postJson(`/api/export?format=${format}`, data);
      const blob = await resp.blob();
      const match = /filename="([^"]+)"/.exec(resp.headers.get("Content-Disposition") || "");
      download(blob, match ? match[1] : `jira_report.${format}`);
      setMsg(`Đã xuất ${data.rows.length} dòng${format === "csv" ? ". CSV không lưu màu." : ""}`, "ok");
    } catch (e) {
      setMsg(e.message, "err");
    }
  }

  async function copyTable() {
    const data = payload();
    if (!data.rows.length) { setMsg("Hãy tích chọn ít nhất một dòng để copy.", "err"); return; }
    const tsv = payloadToTsv(data);
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([tsv], { type: "text/plain" }),
        "text/html": new Blob([payloadToHtml(data)], { type: "text/html" }),
      })]);
      setMsg(`Đã copy ${data.rows.length} dòng — dán vào Excel/Google Sheets`, "ok");
    } catch {
      try { await navigator.clipboard.writeText(tsv); setMsg(`Đã copy ${data.rows.length} dòng (không kèm màu)`, "ok"); }
      catch { setMsg("Trình duyệt không cho phép copy", "err"); }
    }
  }

  // ---- message export -----------------------------------------------------

  // Columns the table shows are the only fields a row carries, so only they can be used as {variables} and in rules.
  const exportFieldOptions = () => [{ id: "status", name: "Status" },
    ...table.columns().filter((c) => c.id !== "status").map((c) => ({ id: c.id, name: c.name, custom: meta.fieldById[c.id]?.custom }))];
  const exportVariables = () => [{ id: "note", label: "Ghi chú (Note)" },
    ...templateVariables(table.columns().map((c) => ({ id: c.id, name: c.name, custom: meta.fieldById[c.id]?.custom })))];

  let edited = false;                                   // the text was changed by hand: keep it until "Tạo lại"
  function setEdited(on) {
    edited = on;
    $("msg-tag").hidden = !on;
  }
  const updateBadge = () => { $("msg-rules-count").textContent = rulesEditor.count() ? String(rulesEditor.count()) : ""; };

  function regenerate() {
    const rows = table.selectedEntries().map((e) => e.row);
    const out = buildExportMessage({
      rows, template: store.profile.messageTemplate, notes: store.profile.notes,
      rules: store.profile.noteRules, defaultNote: store.profile.defaultNote,
    });
    $("msg-text").value = out.text;
    setEdited(false);
    $("msg-count").textContent = `${out.count} dòng${out.hidden ? ` · ẩn ${out.hidden}` : ""}${out.matched ? ` · ${out.matched} khớp điều kiện` : ""}`;
  }
  function refreshMessage() { if (!edited) regenerate(); }

  const rulesEditor = createRulesEditor({
    list: $("msg-rules"), empty: $("msg-rules-empty"), addButton: $("msg-rule-add"),
    fieldOptions: exportFieldOptions, variables: exportVariables,
    onAdd: () => { $("msg-rules-box").open = true; },
    onChange: () => {
      store.profile.noteRules = cleanRules(rulesEditor.getRules());     // incomplete rules stay in the editor but are not saved
      saveProfile();
      updateBadge();
      refreshMessage();
    },
  });
  const templateAdd = varButton("Chèn cột vào mẫu");
  $("msg-template-add-slot").replaceWith(templateAdd);
  attachVarPicker($("msg-template"), templateAdd, exportVariables);

  function openMessage() {
    if (!table.selectedCount()) { setMsg("Hãy tích chọn ít nhất một dòng.", "err"); return; }
    $("msg-template").value = store.profile.messageTemplate;
    rulesEditor.setRules(store.profile.noteRules);
    $("msg-default-note").value = store.profile.defaultNote;
    $("msg-rules-box").open = store.profile.noteRules.length > 0 || !!store.profile.defaultNote;
    updateBadge();
    setEdited(false);
    regenerate();
    $("dlg-message").showModal();
  }

  $("msg-template").addEventListener("input", (e) => {
    store.profile.messageTemplate = e.target.value || "{key}:{summary} ==> {note}";
    saveProfile();
    refreshMessage();
  });
  $("msg-default-note").addEventListener("input", (e) => {
    store.profile.defaultNote = e.target.value.slice(0, 200);
    saveProfile();
    refreshMessage();
  });
  $("msg-text").addEventListener("input", () => setEdited(true));
  $("msg-regen").addEventListener("click", async () => {
    if (edited) {
      const answer = await choose("Tạo lại nội dung?", [el("p", { text: "Phần bạn đã sửa tay sẽ bị thay bằng tin tạo từ mẫu và điều kiện hiện tại." })],
        [{ label: "Tạo lại", value: "yes", primary: true }, { label: "Giữ", value: "no" }]);
      if (answer !== "yes") return;
    }
    regenerate();
  });
  $("msg-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("msg-text").value); $("msg-count").textContent = "Đã copy"; }
    catch { $("msg-text").select(); $("msg-count").textContent = "Chọn và copy thủ công (Ctrl+C)"; }
  });

  $("btn-csv").addEventListener("click", () => exportFile("csv"));
  $("btn-xlsx").addEventListener("click", () => exportFile("xlsx"));
  $("btn-copy").addEventListener("click", copyTable);
  $("btn-message").addEventListener("click", openMessage);
}
