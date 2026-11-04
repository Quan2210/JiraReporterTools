export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const CATEGORY_DEFAULTS = { new: "#DFE1E6", indeterminate: "#FFF2CC", done: "#D5F5E3" };

export const isHexColor = (value) => typeof value === "string" && HEX_RE.test(value);

/** Black or white text, whichever contrasts better with the #RRGGBB background (same rule as the backend). */
export function textColorFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? "#000000" : "#FFFFFF";
}

/**
 * Colour for a status: the user's setting wins, then the Jira status category default.
 * statusCategories: {statusName: categoryKey}
 */
export function statusColor(status, statusColors, statusCategories) {
  if (!status) return null;
  const custom = statusColors[status];
  if (isHexColor(custom)) return custom.toUpperCase();
  return CATEGORY_DEFAULTS[statusCategories[status]] || null;
}
