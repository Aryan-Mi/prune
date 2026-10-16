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
.icon-chevron { --icon: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z'/></svg>"); }
.icon-gear { --icon: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z'/></svg>"); }
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
 * One of the icons LIST_CSS draws (a mask over the text color): no SVG
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
