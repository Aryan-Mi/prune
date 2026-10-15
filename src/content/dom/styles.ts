import type { DiffMode, TreeMode } from '../../shared/settings.ts';
import type { PruneResult } from '../prune.ts';

/**
 * All per-file hiding is done with a single generated stylesheet keyed on the
 * DOM ids GitHub derives from sha256(path). The browser's style engine then
 * applies it to diffs as they stream in, lazy-load, or get re-rendered by
 * React — no per-file JavaScript, no MutationObserver work, no layout thrash.
 *
 * Selectors:
 *   #diff-<digest>                        file diff (classic and new UI)
 *   #file-tree-item-diff-<digest>         file tree row (classic UI)
 *   li#<path>[role=treeitem]              file tree row (new UI uses the path as id)
 *
 * Id selectors, not [id="…"], so the style engine can look rules up by id.
 */

const STYLE_ID = 'prune-style';

export interface StyleOptions {
  diffMode: DiffMode;
  treeMode: TreeMode;
  /** Digests the user chose to reveal from the "Pruned files" section. */
  revealed: ReadonlySet<string>;
}

export class PruneStyles {
  private el: HTMLStyleElement | null = null;
  private css = '';

  update(result: PruneResult | null, options: StyleOptions): void {
    const css = result && result.pruned.length > 0 ? buildCss(result, options) : '';
    if (css === this.css && (css === '' || this.el?.isConnected)) return;
    this.css = css;
    if (!css) {
      this.el?.remove();
      return;
    }
    if (!this.el) {
      this.el = document.createElement('style');
      this.el.id = STYLE_ID;
    }
    this.el.textContent = css;
    this.ensure();
  }

  /** Re-attaches the stylesheet if a full-page navigation swapped <head>. */
  ensure(): void {
    if (this.css && this.el && !this.el.isConnected) {
      (document.head ?? document.documentElement).append(this.el);
    }
  }

  clear(): void {
    this.css = '';
    this.el?.remove();
  }
}

/** `#id` selector for any id, escaped as `CSS.escape` would. */
function idSelector(id: string): string {
  return `#${id.replace(/^-?\d|^-$|[^\w\u0080-\uffff-]/g, (m) => {
    const prefix = m.length === 2 ? '-' : '';
    const code = m.charCodeAt(m.length - 1);
    if (code === 0) return '\ufffd';
    if (code < 0x20 || code === 0x7f || (code >= 0x30 && code <= 0x39)) return `${prefix}\\${code.toString(16)} `;
    return `\\${m}`;
  })}`;
}

export function buildCss(result: PruneResult, options: StyleOptions): string {
  const diffSelectors: string[] = [];
  const treeSelectors: string[] = [];
  for (const file of result.pruned) {
    if (options.revealed.has(file.digest)) continue;
    diffSelectors.push(`#diff-${file.digest}`);
    treeSelectors.push(`#file-tree-item-diff-${file.digest}`, `li${idSelector(file.path)}[role="treeitem"]`);
  }
  // Directories whose every file is pruned (new UI tree ids are paths).
  for (const dir of fullyPrunedDirs(result)) {
    treeSelectors.push(`li${idSelector(dir)}[role="treeitem"]`);
  }

  const rules: string[] = [];
  if (diffSelectors.length > 0) {
    if (options.diffMode === 'hide') {
      rules.push(`${diffSelectors.join(',\n')} { display: none !important; }`);
    } else if (options.diffMode === 'collapse') {
      rules.push(`${diffSelectors.join(',\n')} { opacity: 0.6; }`);
    }
  }
  if (treeSelectors.length > 0) {
    if (options.treeMode === 'hide' && options.diffMode === 'hide') {
      rules.push(`${treeSelectors.join(',\n')} { display: none !important; }`);
    } else {
      rules.push(`${treeSelectors.join(',\n')} { opacity: 0.45; }`);
    }
  }
  return rules.join('\n');
}

function fullyPrunedDirs(result: PruneResult): string[] {
  const keptDirs = new Set<string>();
  const prunedDirs = new Set<string>();
  for (const file of result.files) {
    const target = result.prunedDigests.has(file.digest) ? prunedDirs : keptDirs;
    for (let i = file.path.lastIndexOf('/'); i > 0; i = file.path.lastIndexOf('/', i - 1)) {
      const dir = file.path.slice(0, i);
      // Its parents were added along with it.
      if (target.has(dir)) break;
      target.add(dir);
    }
  }
  return [...prunedDirs].filter((d) => !keptDirs.has(d));
}
