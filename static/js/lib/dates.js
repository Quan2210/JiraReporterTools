// Dates are shown as dd/MM/yyyy (with HH:mm when there is a time) and kept as ISO internally.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/** "2026-10-01" -> "01/10/2026"; "2026-10-01T09:09" -> "01/10/2026 09:09"; anything else is returned as is. */
export function isoToDisplay(text) {
  const m = ISO_RE.exec(String(text ?? ""));
  if (!m) return String(text ?? "");
  const day = `${m[3]}/${m[2]}/${m[1]}`;
  return m[4] === undefined ? day : `${day} ${m[4]}:${m[5]}`;
}

/** What a person typed ("1/2/2026", "01-02-2026", "01.02.2026") -> "2026-02-01", or null if it is not a real date. */
export function parseDisplay(text) {
  const m = /^\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2200 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Keep the text in dd/MM/yyyy shape while typing: separators are normalised to "/", extra digits flow into the
 * next part ("01102026" -> "01/10/2026", "01/102" -> "01/10/2"), and slashes the person typed are kept ("1/" stays).
 */
export function autoSlash(text) {
  const parts = String(text ?? "").replace(/[.\-]/g, "/").replace(/[^\d/]/g, "").split("/");
  let [day = "", month = "", year = ""] = parts;
  if (day.length > 2) { month = day.slice(2) + month; day = day.slice(0, 2); }
  if (month.length > 2) { year = month.slice(2) + year; month = month.slice(0, 2); }
  year = year.slice(0, 4);
  let out = day;
  if (month !== "" || parts.length > 1) out += `/${month}`;
  if (year !== "" || parts.length > 2) out += `/${year}`;
  return out;
}

/** Group / pivot bucket labels: "2026-10-01" -> "01/10/2026", "2026-10" -> "10/2026"; weeks and plain text are unchanged. */
export function formatBucket(value) {
  const v = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isoToDisplay(v);
  const month = /^(\d{4})-(\d{2})$/.exec(v);
  return month ? `${month[2]}/${month[1]}` : v;
}

// ---- dynamic dates ("today", "today-7", "today+3") --------------------------------------------------------------
// Resolved by the server on every run; keep MAX_DATE_OFFSET_DAYS equal to app/schemas.py.

export const MAX_DATE_OFFSET_DAYS = 3660;
const TOKEN_RE = /^today(?:([+-])(\d{1,4}))?$/;

/** "today-7" -> {sign: "-", days: 7}; "today" -> {sign: "", days: 0}; anything else (or too far) -> null. */
export function parseDateToken(text) {
  const m = TOKEN_RE.exec(String(text ?? "").trim());
  if (!m) return null;
  const days = Number(m[2] ?? 0);
  if (days > MAX_DATE_OFFSET_DAYS) return null;
  return { sign: days === 0 ? "" : m[1], days };
}

export const isDateToken = (text) => parseDateToken(text) !== null;

/** sign "", "-" or "+" and a day count -> canonical token. */
export function makeDateToken(sign, days) {
  const n = Math.min(MAX_DATE_OFFSET_DAYS, Math.max(0, Math.trunc(Number(days) || 0)));
  return n === 0 || !sign ? "today" : `today${sign}${n}`;
}

export function tokenLabel(text) {
  const t = parseDateToken(text);
  if (!t) return String(text ?? "");
  if (!t.sign) return "hôm nay";
  return `hôm nay ${t.sign === "-" ? "−" : "+"} ${t.days} ngày`;
}

/** Short label for a field: "Hôm nay", "−7 ngày", "+3 ngày". */
export function tokenShort(text) {
  const t = parseDateToken(text);
  if (!t) return String(text ?? "");
  return t.sign ? `${t.sign === "-" ? "−" : "+"}${t.days} ngày` : "Hôm nay";
}
