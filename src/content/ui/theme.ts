import { formatCount } from '../../shared/format.ts';

/**
 * Shared shadow-DOM styles. Colors come from GitHub's Primer CSS variables,
 * which inherit through the shadow boundary, so light/dark/high-contrast
 * themes just work. Fallbacks cover pages that lack the variables.
 */
export const BASE_CSS = /* css */ `
:host {
  --p-fg: var(--fgColor-default, #1f2328);
  --p-muted: var(--fgColor-muted, #59636e);
  --p-bg: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  --p-bg-muted: var(--bgColor-muted, #f6f8fa);
  --p-border: var(--borderColor-default, #d1d9e0);
  --p-border-muted: var(--borderColor-muted, #d1d9e0b3);
  --p-success: var(--fgColor-success, #1a7f37);
  --p-danger: var(--fgColor-danger, #d1242f);
  --p-accent: var(--fgColor-accent, #0969da);
  --p-done: var(--fgColor-done, #8250df);
  --p-done-bg: var(--bgColor-done-muted, #8250df1a);
  --p-hover: var(--control-transparent-bgColor-hover, #818b981a);
  --p-radius: 6px;
  --p-font: var(--fontStack-sansSerif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif);
  --p-mono: var(--fontStack-monospace, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  font: 400 12px/1.5 var(--p-font);
  color: var(--p-fg);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
.btn:focus-visible, .pill:focus-visible, .row:focus-visible, .switch:focus-visible {
  outline: 2px solid var(--focus-outlineColor, var(--p-accent)); outline-offset: -2px;
}
`;

/**
 * Icons (see icon()), file rows (path, line stats) and buttons, shared by
 * the popover and the section. Kept apart from BASE_CSS so the pill alone
 * doesn't parse them.
 */
export const LIST_CSS = /* css */ `
.icon { display: inline-block; width: 16px; height: 16px; flex: none; background: currentColor; mask: var(--icon) center / contain no-repeat; }
.icon-scissors { --icon: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round'><path d='M6 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.6 5.2 14 12.5M5.6 10.8 14 3.5'/></svg>"); }
.add { color: var(--p-success); font-weight: 600; }
.del { color: var(--p-danger); font-weight: 600; }
.stat { font-family: var(--p-mono); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.path { font-family: var(--p-mono); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.path > bdi { direction: ltr; unicode-bidi: plaintext; }
.path .dir { color: var(--p-muted); }
.btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 0 8px; height: 24px; border-radius: var(--p-radius);
  border: 1px solid var(--p-border); background: var(--button-default-bgColor-rest, var(--p-bg-muted));
  cursor: pointer; font-size: 12px; font-weight: 500; white-space: nowrap;
}
.btn:hover { background: var(--button-default-bgColor-hover, var(--p-hover)); }
`;

/** Renders a path as "dir/" (muted) + "name", ellipsized from the left. */
export function pathElement(path: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'path';
  wrap.title = path;
  const bdi = document.createElement('bdi');
  const slash = path.lastIndexOf('/');
  if (slash >= 0) {
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = path.slice(0, slash + 1);
    bdi.append(dir);
  }
  bdi.append(path.slice(slash + 1));
  wrap.append(bdi);
  return wrap;
}

export function statElement(additions: number, deletions: number): HTMLElement {
  const stat = document.createElement('span');
  stat.className = 'stat';
  const add = document.createElement('span');
  add.className = 'add';
  add.textContent = `+${formatCount(additions)}`;
  const del = document.createElement('span');
  del.className = 'del';
  del.textContent = ` −${formatCount(deletions)}`;
  stat.append(add, del);
  return stat;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One of the icons the stylesheets draw (a mask over the text color: LIST_CSS
 * has the scissors, the popover's and the section's their own): no SVG
 * elements, whose DOM interfaces would cost ~10 KB in this script's world.
 */
export function icon(name: 'scissors' | 'gear' | 'chevron', className = ''): HTMLSpanElement {
  const span = el('span', `icon icon-${name}${className ? ` ${className}` : ''}`);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

export function styleElement(css: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = css;
  return style;
}

/** "Why was this pruned" line; omits the pattern when it is just the file name. */
export function whyElement(file: { path: string; rule: string; source: string }): HTMLElement {
  const why = el('span', 'why');
  const rule = whyText(file);
  if (rule) why.append(el('code', '', rule), ' · ');
  why.append(file.source);
  return why;
}

/** The pattern to show for why a file was pruned, or '' when it is just the file's name. */
export function whyText(file: { path: string; rule: string }): string {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  return file.rule !== name && file.rule !== file.path ? file.rule : '';
}
