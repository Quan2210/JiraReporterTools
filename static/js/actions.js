import { $, download, setMsg } from "./dom.js";
import { postJson } from "./api.js";
import { statusColor } from "./lib/color.js";
import { buildMessage } from "./lib/message.js";
import { buildTablePayload, payloadToHtml, payloadToTsv } from "./lib/table-payload.js";
import { meta } from "./meta.js";
import { saveProfile, store } from "./store.js";

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

  function refreshMessage() {
    const rows = table.selectedEntries().map((e) => e.row);
    $("msg-text").value = buildMessage(rows, store.profile.messageTemplate, store.profile.notes);
    $("msg-count").textContent = `${rows.length} dòng`;
  }

  function openMessage() {
    if (!table.selectedCount()) { setMsg("Hãy tích chọn ít nhất một dòng.", "err"); return; }
    $("msg-template").value = store.profile.messageTemplate;
    refreshMessage();
    $("dlg-message").showModal();
  }

  $("msg-template").addEventListener("input", (e) => {
    store.profile.messageTemplate = e.target.value || "{key}:{summary} ==> {note}";
    saveProfile();
    refreshMessage();
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
