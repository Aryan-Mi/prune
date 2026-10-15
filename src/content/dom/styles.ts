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
 *   li[role=treeitem][id="<path>"]        file tree row (new UI uses the path as id)
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
  /**
   * What the stylesheet was built from. The CSS text itself is not kept: it can
   * be ~50 KB on a big PR, and the browser already holds it.
   */
  private built: { result: PruneResult; diffMode: DiffMode; treeMode: TreeMode; revealed: string } | null = null;
  private active = false;

  update(result: PruneResult | null, options: StyleOptions): void {
    if (!result || result.pruned.length === 0) {
      this.clear();
      return;
    }
    const { diffMode, treeMode } = options;
    const revealed = [...options.revealed].join();
    const built = this.built;
    if (
      built?.result !== result ||
      built.diffMode !== diffMode ||
      built.treeMode !== treeMode ||
      built.revealed !== revealed
    ) {
      this.built = { result, diffMode, treeMode, revealed };
      const css = buildCss(result, options);
      this.active = css !== '';
      if (!this.active) {
        this.el?.remove();
        return;
      }
      if (!this.el) {
        this.el = document.createElement('style');
        this.el.id = STYLE_ID;
      }
      this.el.textContent = css;
    }
    this.ensure();
  }

  /** Re-attaches the stylesheet if a full-page navigation swapped <head>. */
  ensure(): void {
    if (this.active && this.el && !this.el.isConnected) {
      (document.head ?? document.documentElement).append(this.el);
    }
  }

  clear(): void {
    this.built = null;
    this.active = false;
    this.el?.remove();
  }
}

function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
}

export function buildCss(result: PruneResult, options: StyleOptions): string {
  const diffSelectors: string[] = [];
  const treeSelectors: string[] = [];
  for (const file of result.pruned) {
    if (options.revealed.has(file.digest)) continue;
    diffSelectors.push(`#diff-${file.digest}`);
    treeSelectors.push(`#file-tree-item-diff-${file.digest}`, `li[role="treeitem"][id=${cssString(file.path)}]`);
  }
  // Directories whose every file is pruned (new UI tree ids are paths).
  for (const dir of result.prunedDirs) {
    treeSelectors.push(`li[role="treeitem"][id=${cssString(dir)}]`);
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
