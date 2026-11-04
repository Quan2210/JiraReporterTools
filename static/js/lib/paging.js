export const PAGE_SIZES = [20, 50, 100, 200, 500];
export const DEFAULT_PAGE_SIZE = 100;

export const pageCount = (total, size) => Math.max(1, Math.ceil(total / size));

/** 0-based page index kept inside [0, pageCount - 1]. */
export const clampPage = (page, total, size) => Math.min(Math.max(0, Math.trunc(page) || 0), pageCount(total, size) - 1);

/** Slice bounds [start, end) of a 0-based page. */
export function pageRange(page, total, size) {
  const start = clampPage(page, total, size) * size;
  return { start, end: Math.min(total, start + size) };
}

export const pageOfIndex = (index, size) => Math.floor(index / size);

/** What a user typed in the "go to page" box (1-based) -> 0-based page, or null when it is not a number. */
export function parsePageInput(text, total, size) {
  const n = Number.parseInt(String(text).trim(), 10);
  return Number.isFinite(n) ? clampPage(n - 1, total, size) : null;
}

/** 1-based page numbers that contain at least one selected row, for the current order and page size. */
export function selectedPages(orderedKeys, selected, size) {
  const pages = new Set();
  orderedKeys.forEach((key, index) => { if (selected.has(key)) pages.add(pageOfIndex(index, size) + 1); });
  return [...pages].sort((a, b) => a - b);
}

/** Page that keeps the first row of the old page in view after the page size changes. */
export const pageAfterSizeChange = (oldPage, oldSize, newSize) => pageOfIndex(oldPage * oldSize, newSize);
