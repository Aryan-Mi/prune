/** Matches a number as GitHub renders it in any locale: 1,136 · 1.136 · 1 136. */
const NUMBER_RUN = /\d(?:[\d.,\u00a0\u202f ]*\d)?/;

/** Extracts the integer from text like "+1,136", "−1.136" or "(38)". */
export function parseCount(text: string): number | null {
  const m = NUMBER_RUN.exec(text);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  return digits ? Number(digits) : null;
}

export function groupDigits(value: number, separator: string): string {
  const s = String(Math.max(0, Math.round(value)));
  if (!separator) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Replaces the number inside `original` with `value`, keeping the prefix,
 * suffix and digit-grouping style GitHub used (which follows the browser locale).
 */
export function replaceCount(original: string, value: number): string {
  const m = NUMBER_RUN.exec(original);
  if (!m) return original;
  const separator = /\d([^\d])\d/.exec(m[0])?.[1] ?? (value >= 1000 ? ',' : '');
  return original.slice(0, m.index) + groupDigits(value, separator) + original.slice(m.index + m[0].length);
}

/** Display formatting for PRune's own UI. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}
