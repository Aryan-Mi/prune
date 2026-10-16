import type { DiffMode, TreeMode } from '../../shared/settings.ts';
import type { PruneResult } from '../../shared/prune.ts';

/**
 * All per-file hiding is done with a single generated stylesheet keyed on the
 * DOM ids GitHub derives from sha256(path). The browser's style engine then
 * applies it to diffs as they stream in, lazy-load, or get re-rendered by
 * React — no per-file JavaScript, no MutationObserver work, no layout thrash.
 *
 * Selectors:
 *   #diff-<digest>                        file diff (classic and new UI)
 *   #file-tree-item-diff-<digest>         file tree row (classic UI)
 *   li#<path>[role=treeitem]              file tree row (new UI uses the path as id;
 *                                         left out on a page known to be classic)
 *
 * Id selectors, not [id="…"], so the style engine can look rules up by id.
 *
 * The sheet is written once per PR and settings, never for a click: in
 * Chromium, any change to a GitHub page's stylesheets restyles nearly the
 * whole document (~1 s on a 3,000-file diff: GitHub links one sheet with
 * cascade layers several times, and then Chromium re-matches all of its
 * rules), while an attribute change only restyles the elements it affects.
 * So a file shown again from the "Pruned files" section gets a
 * `data-prune-show` attribute (its rules end in `:not([data-prune-show])`),
 * and in Chromium every rule starts with `html[data-prune-on]`, an attribute
 * that switches them all off and on (the per-PR switch, the conversation
 * tab). Firefox restyles only elements with the ids and classes in a changed
 * sheet, but an ancestor selector like `html[…]` would make it restyle
 * everything, both when the sheet changes and when the attribute does (past
 * 150 selectors). There the rules start at the id and the sheet is taken out
 * instead. For the same reason a PR seen before gets the sheet as soon as the
 * background script answers, from its stored result: before the page's first
 * paint, the restyle is part of the first one. (The answer often comes just
 * then: page loading tasks go first. Inserted on another tab of the PR, after
 * the first paint, it would cost a restyle that may never pay off, so it isn't.)
 *
 * Pruned diffs shown again render lazily at first, with `content-visibility:
 * auto`: switching PRune off on a big PR would otherwise style and lay out
 * every pruned diff in one frame (tens of thousands of elements, ~250 ms),
 * where now only those on screen are. The rest then render a few diffs per
 * frame ("settle"): left lazy, their placeholder heights would throw off
 * jumps to files further down (GitHub scrolls smoothly, past them). On the
 * classic UI only the diff's body is lazy: the header's menus would be cut
 * off at the diff's edge. In Chromium, groups of these rules switch off one by
 * one as tokens leave <html>'s `data-prune-lazy`; Firefox has each group in a
 * sheet of its own.
 */

declare const PRUNE_ENGINE: 'blink' | 'gecko' | undefined;

/** Chromium: switch the rules with an attribute on <html> (scripts/build.ts sets the engine; tests get Blink's). */
export const GATED = (typeof PRUNE_ENGINE === 'string' ? PRUNE_ENGINE : 'blink') === 'blink';

const STYLE_ID = 'prune-style';
/** Firefox's sheets of `lazyCss()` rules, one per group. */
const LAZY_ID = 'prune-lazy';
/** On <html> while the rules apply (Chromium). */
const ON_ATTR = 'data-prune-on';
/** On <html>: the groups of pruned diffs that render lazily when shown (Chromium). */
const LAZY_ATTR = 'data-prune-lazy';
/** Pruned diffs that settle per frame (see the top of this file). */
const SETTLE_GROUP = 8;
/** On diffs and tree rows of files shown again. */
const SHOW_ATTR = 'data-prune-show';
/** Longest wait for GitHub to take a tab's diffs away before the rules stop applying anyway. */
const LEAVE_MS = 3000;

export interface StyleOptions {
  diffMode: DiffMode;
  treeMode: TreeMode;
  /** Digests the user chose to reveal from the "Pruned files" section. */
  revealed: ReadonlySet<string>;
  /**
   * The page is known to be the classic UI, so the new UI's tree rows (path
   * ids: a third of the stylesheet, and all the escaping) are left out.
   */
  classic?: boolean;
}

export class PruneStyles {
  private el: HTMLStyleElement | null = null;
  /** Groups of `lazyCss()` rules in the sheet. */
  private groups = 0;
  /** `data-prune-lazy` while none of them has settled. */
  private tokens = '';
  /** Firefox: a sheet per group, which stay while the others are taken out, until settled. */
  private lazy: HTMLStyleElement[] = [];
  /** Animation frame of the next settling step. */
  private settling = 0;
  /**
   * What the stylesheet was built from. The CSS text itself is not kept: it can
   * be ~50 KB on a big PR, and the browser already holds it.
   */
  private built: {
    result: PruneResult;
    diffMode: DiffMode;
    treeMode: TreeMode;
    classic: boolean;
  } | null = null;
  /** Whether the rules apply. */
  private on = false;
  /**
   * Ids of the revealed files' diffs and tree rows, marked again when GitHub
   * re-renders them. Paths (new UI tree rows) only mark tree items.
   */
  private shown: string[] = [];
  /** Elements marked as shown. */
  private marked: Element[] = [];
  /** Whether a revealed file's diff is not in the page, so the diff list must be watched for it. */
  waiting = false;
  /** Set while leaving the diffs for another tab of the PR (see leave()). */
  private leaveTimer = 0;

  /** Applies the rules for `result`; null when the page has no diffs (another tab of the PR). */
  update(result: PruneResult | null, options: StyleOptions): void {
    if (!result) {
      this.leave();
      return;
    }
    if (result.pruned.length === 0) {
      this.off();
      return;
    }
    this.stopLeaving();
    const { diffMode, treeMode } = options;
    const built = this.built;
    // A PR's data is refetched now and then: the same files need no new sheet.
    const same = !!built && (built.result === result || sameFiles(built.result, result));
    // A sheet built for both UIs still does once the page turns out to be classic.
    const classic = isClassicUi() && (!same || built!.classic);
    if (!same || built!.diffMode !== diffMode || built!.treeMode !== treeMode || built!.classic !== classic) {
      const lazy = diffMode === 'hide' ? lazyCss(result, GATED) : [];
      this.groups = lazy.length;
      this.tokens = lazyTokens(0, lazy.length);
      this.el ??= styleElement(STYLE_ID);
      this.el.textContent = [buildCss(result, { ...options, classic, gated: GATED }), ...(GATED ? lazy : [])].join('\n');
      if (!GATED) {
        for (const el of this.lazy) el.remove();
        this.lazy = lazy.map((css, i) => {
          const el = styleElement(`${LAZY_ID}-${i}`);
          el.textContent = css;
          return el;
        });
      }
    }
    this.built = { result, diffMode, treeMode, classic };
    this.reveal(result, options.revealed);
    this.on = true;
    this.ensure();
  }

  /**
   * Re-attaches the stylesheet if a full-page navigation swapped <head>, and
   * re-marks revealed files GitHub has rendered again. Cheap to call often.
   */
  ensure(): void {
    if (!this.on || !this.el) return;
    if (this.leaveTimer && !this.diffsShown()) {
      this.off(false);
      return;
    }
    if (this.settling) this.stopSettling();
    const parent = document.head ?? document.documentElement;
    if (!this.el.isConnected) parent.append(this.el);
    for (const el of this.lazy) if (!el.isConnected) parent.append(el);
    const root = document.documentElement;
    if (GATED && !root.hasAttribute(ON_ATTR)) root.setAttribute(ON_ATTR, '');
    if (GATED && root.getAttribute(LAZY_ATTR) !== this.tokens) root.setAttribute(LAZY_ATTR, this.tokens);
    this.waiting = false;
    for (let i = 0; i < this.shown.length; i++) {
      const el = document.getElementById(this.shown[i]!);
      // A revealed diff GitHub hasn't rendered (yet): it is marked when it shows up.
      if (!el && i % 3 === 0) this.waiting = true;
      if (!el || el.hasAttribute(SHOW_ATTR) || (i % 3 === 2 && el.getAttribute('role') !== 'treeitem')) continue;
      el.setAttribute(SHOW_ATTR, '');
      // Drop the ones GitHub has re-rendered meanwhile.
      if (this.marked.length >= this.shown.length) this.marked = this.marked.filter((m) => m.isConnected);
      this.marked.push(el);
    }
  }

  /** The elements marked as shown, so their replacement by GitHub can be watched for. */
  shownElements(): readonly Element[] {
    return this.marked;
  }

  /**
   * Stops applying the rules, keeping them for when they apply again (same
   * PR). Shown pruned diffs settle, unless they're gone (`settle` false).
   */
  off(settle = true): void {
    this.waiting = false;
    this.stopLeaving();
    if (!this.on) return;
    this.on = false;
    if (GATED) document.documentElement.removeAttribute(ON_ATTR);
    else this.el?.remove();
    if (settle) this.settle();
  }

  /** Stops applying the rules and forgets them (another PR, or none). */
  clear(): void {
    this.off(false);
    this.stopSettling();
    if (GATED) document.documentElement.removeAttribute(LAZY_ATTR);
    for (const el of this.lazy) el.remove();
    this.lazy = [];
    this.groups = 0;
    this.tokens = '';
    this.built = null;
    this.unmark(new Set());
    this.shown = [];
  }

  /**
   * Leaving the diffs for another tab of the PR: the rules stop applying once
   * GitHub has taken the diffs away. Until then they're still there, and
   * showing the pruned ones would only restyle (in a big PR, ~100k) elements
   * that are about to go.
   */
  private leave(): void {
    if (!this.on || this.leaveTimer) return;
    if (!this.diffsShown()) {
      this.off(false);
      return;
    }
    this.leaveTimer = window.setTimeout(() => this.off(), LEAVE_MS);
  }

  /** Has the shown pruned diffs render fully, a group per frame, from the frame after next. */
  private settle(): void {
    this.stopSettling();
    let done = -1;
    const step = () => {
      this.settling = 0;
      // The first frame is the one that shows the diffs.
      if (++done > 0) {
        if (GATED) document.documentElement.setAttribute(LAZY_ATTR, lazyTokens(done, this.groups));
        else this.lazy[done - 1]?.remove();
      }
      if (done < this.groups) this.settling = requestAnimationFrame(step);
    };
    if (this.groups > 0) this.settling = requestAnimationFrame(step);
  }

  private stopSettling(): void {
    cancelAnimationFrame(this.settling);
    this.settling = 0;
  }

  private stopLeaving(): void {
    clearTimeout(this.leaveTimer);
    this.leaveTimer = 0;
  }

  /** Whether the page still has a pruned file's diff. */
  private diffsShown(): boolean {
    return !!this.built?.result.pruned.some((f) => document.getElementById(`diff-${f.digest}`));
  }

  private reveal(result: PruneResult, revealed: ReadonlySet<string>): void {
    const ids: string[] = [];
    if (revealed.size > 0) {
      for (const file of result.pruned) {
        // Three per file; ensure() relies on the path coming last.
        if (revealed.has(file.digest)) ids.push(`diff-${file.digest}`, `file-tree-item-diff-${file.digest}`, file.path);
      }
    }
    if (ids.length === this.shown.length && ids.every((id, i) => id === this.shown[i])) return;
    this.shown = ids;
    this.unmark(new Set(ids));
  }

  /** Unmarks the elements not in `keep` (or no longer in the page). */
  private unmark(keep: ReadonlySet<string>): void {
    this.marked = this.marked.filter((el) => {
      if (el.isConnected && keep.has(el.id)) return true;
      el.removeAttribute(SHOW_ATTR);
      return false;
    });
  }
}

function styleElement(id: string): HTMLStyleElement {
  const el = document.createElement('style');
  el.id = id;
  return el;
}

/** Whether two results prune the same files, so their sheets would be the same. */
function sameFiles(a: PruneResult, b: PruneResult): boolean {
  return (
    a.pruned.length === b.pruned.length &&
    a.prunedDirs.length === b.prunedDirs.length &&
    a.pruned.every((f, i) => f.digest === b.pruned[i]!.digest && f.path === b.pruned[i]!.path) &&
    a.prunedDirs.every((d, i) => d === b.prunedDirs[i])
  );
}

/**
 * Whether this is the classic "Files changed" page: its server-rendered diff
 * list is there before PRune's data is. Anything else (not rendered yet, or
 * the new UI) gets the selectors for both.
 */
function isClassicUi(): boolean {
  return !!document.getElementById('files')?.classList.contains('js-diff-container');
}

/** Ids that need more than a backslash before some characters. */
const NEEDS_CODE_POINTS = /^-?\d|^-$|[\0-\x1f\x7f]/;

/** `#id` selector for any id, escaped as `CSS.escape` would. */
function idSelector(id: string): string {
  // Nearly every path: only `.`, `/` and the like to escape, no callback needed (twice as fast).
  if (!NEEDS_CODE_POINTS.test(id)) return `#${id.replace(/[^\w\u0080-\uffff-]/g, '\\$&')}`;
  return `#${id.replace(/^-?\d|^-$|[^\w\u0080-\uffff-]/g, (m) => {
    const prefix = m.length === 2 ? '-' : '';
    const code = m.charCodeAt(m.length - 1);
    if (code === 0) return '\ufffd';
    if (code < 0x20 || code === 0x7f || (code >= 0x30 && code <= 0x39)) return `${prefix}\\${code.toString(16)} `;
    return `\\${m}`;
  })}`;
}

export function buildCss(
  result: PruneResult,
  options: Omit<StyleOptions, 'revealed'> & { gated?: boolean },
): string {
  const gate = options.gated ? `html[${ON_ATTR}] ` : '';
  const shown = `:not([${SHOW_ATTR}])`;
  const diffSelectors: string[] = [];
  const treeSelectors: string[] = [];
  const newUi = !options.classic;
  for (const file of result.pruned) {
    diffSelectors.push(`${gate}#diff-${file.digest}${shown}`);
    treeSelectors.push(`${gate}#file-tree-item-diff-${file.digest}${shown}`);
    if (newUi) treeSelectors.push(`${gate}li${idSelector(file.path)}[role="treeitem"]${shown}`);
  }
  // Directories whose every file is pruned (new UI tree ids are paths).
  if (newUi) {
    for (const dir of result.prunedDirs) treeSelectors.push(`${gate}li${idSelector(dir)}[role="treeitem"]`);
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

/** `data-prune-lazy` for groups `from` to `to` (exclusive). */
function lazyTokens(from: number, to: number): string {
  let tokens = '';
  for (let i = from; i < to; i++) tokens += i > from ? ` ${i}` : `${i}`;
  return tokens;
}

/** Rules that render shown pruned diffs lazily, a group per settling step (see the top of this file). */
export function lazyCss(result: PruneResult, gated = false): string[] {
  const groups: string[] = [];
  for (let i = 0; i < result.pruned.length; i += SETTLE_GROUP) {
    const gate = gated ? `html[${LAZY_ATTR}~="${groups.length}"] ` : '';
    const selectors: string[] = [];
    for (const { digest } of result.pruned.slice(i, i + SETTLE_GROUP)) {
      // Classic UI: the body; new UI: the whole diff (its menus are layers of their own).
      selectors.push(`${gate}#diff-${digest} > .js-file-content`, `${gate}#diff-${digest}:not(.js-file)`);
    }
    // Placeholder height of a diff not rendered yet (about the median).
    groups.push(`${selectors.join(',\n')} { content-visibility: auto; contain-intrinsic-size: auto 240px; }`);
  }
  return groups;
}
