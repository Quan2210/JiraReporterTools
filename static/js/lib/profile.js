import { DEFAULT_TEMPLATE } from "./message.js";
import { isHexColor } from "./color.js";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "./paging.js";

export const PROFILE_VERSION = 1;
export const MAX_PROFILE_BYTES = 5 * 1024 * 1024;
const MAX_NOTES = 20000;
const MAX_NOTE_CHARS = 5000;
const OPERATORS = ["in", "not_in", "eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty"];
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const ID_RE = /^[A-Za-z0-9_.\-]{1,100}$/;

export class ProfileError extends Error {}

export function emptyFilters() {
  return {
    projects: [], sprints: [], labels: [], reporters: [], assignees: [], statuses: [], issuetypes: [],
    created_from: "", created_to: "", updated_from: "", updated_to: "", jqlMode: false, jqlText: "",
  };
}

const OPTION_LISTS = ["projects", "sprints", "labels", "reporters", "assignees", "statuses", "issuetypes"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The last-used filter selections ({value,label} options and dates) as stored in the profile. */
function sanitizeFilters(input) {
  const out = emptyFilters();
  if (!isObject(input)) return out;
  for (const name of OPTION_LISTS) {
    if (!Array.isArray(input[name])) continue;
    out[name] = input[name]
      .filter((o) => isObject(o) && typeof o.value === "string" && o.value !== "")
      .slice(0, 200)
      .map((o) => ({ value: o.value.slice(0, 255), label: str(o.label, 300) || o.value.slice(0, 255) }));
  }
  for (const name of ["created_from", "created_to", "updated_from", "updated_to"]) {
    out[name] = typeof input[name] === "string" && DATE_RE.test(input[name]) ? input[name] : "";
  }
  out.jqlMode = input.jqlMode === true;
  out.jqlText = str(input.jqlText, 5000);
  return out;
}

export function defaultProfile() {
  return {
    version: PROFILE_VERSION,
    name: "",
    ui: { hiddenFilters: [], pageSize: DEFAULT_PAGE_SIZE, showNote: true, colorScope: "row" },
    columns: [],
    customFilters: [],
    filters: emptyFilters(),
    statusColors: {},
    messageTemplate: DEFAULT_TEMPLATE,
    notes: {},
  };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/** Validate untrusted input (a file or localStorage) into a well-formed profile; unknown keys are dropped. */
export function sanitizeProfile(input) {
  if (!isObject(input)) throw new ProfileError("Hồ sơ không hợp lệ: không phải đối tượng JSON");
  if (typeof input.version !== "number" || input.version < 1) throw new ProfileError("Hồ sơ thiếu số phiên bản");
  if (input.version > PROFILE_VERSION) throw new ProfileError("Hồ sơ được tạo bởi phiên bản mới hơn của tool");

  const out = defaultProfile();
  out.name = str(input.name, 100);

  const ui = isObject(input.ui) ? input.ui : {};
  out.ui.hiddenFilters = Array.isArray(ui.hiddenFilters)
    ? ui.hiddenFilters.filter((id) => typeof id === "string" && ID_RE.test(id)).slice(0, 100) : [];
  out.ui.pageSize = PAGE_SIZES.includes(ui.pageSize) ? ui.pageSize : DEFAULT_PAGE_SIZE;
  out.ui.showNote = ui.showNote !== false;
  out.ui.colorScope = ui.colorScope === "cell" ? "cell" : "row";

  out.columns = Array.isArray(input.columns)
    ? input.columns.filter((id) => typeof id === "string" && ID_RE.test(id)).slice(0, 100) : [];

  out.customFilters = (Array.isArray(input.customFilters) ? input.customFilters : [])
    .filter((f) => isObject(f) && typeof f.fieldId === "string" && ID_RE.test(f.fieldId) && OPERATORS.includes(f.operator))
    .slice(0, 20)
    .map((f, i) => ({
      id: str(f.id, 50) || `cf${i}`,
      fieldId: f.fieldId,
      operator: f.operator,
      values: Array.isArray(f.values) ? f.values.filter((v) => typeof v === "string").map((v) => v.slice(0, 255)).slice(0, 50) : [],
    }));

  out.filters = sanitizeFilters(input.filters);

  if (isObject(input.statusColors)) {
    for (const [status, color] of Object.entries(input.statusColors).slice(0, 200)) {
      if (isHexColor(color)) out.statusColors[status.slice(0, 100)] = color.toUpperCase();
    }
  }

  out.messageTemplate = typeof input.messageTemplate === "string" && input.messageTemplate.trim()
    ? input.messageTemplate.slice(0, 1000) : DEFAULT_TEMPLATE;

  if (isObject(input.notes)) {
    for (const [key, note] of Object.entries(input.notes).slice(0, MAX_NOTES)) {
      if (KEY_RE.test(key) && typeof note === "string" && note !== "") out.notes[key] = note.slice(0, MAX_NOTE_CHARS);
    }
  }
  return out;
}

export function parseProfileText(text) {
  if (typeof text !== "string" || text.length > MAX_PROFILE_BYTES) throw new ProfileError("File hồ sơ quá lớn (tối đa 5 MB)");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProfileError("File hồ sơ không phải JSON hợp lệ");
  }
  return sanitizeProfile(data);
}

export function serializeProfile(profile) {
  return JSON.stringify({ ...profile, version: PROFILE_VERSION }, null, 2);
}

/** Import with "merge notes": keep everything in `current`, add notes from `incoming` that are not set yet. */
export function mergeNotes(current, incoming) {
  return { ...current, notes: { ...incoming.notes, ...current.notes } };
}
