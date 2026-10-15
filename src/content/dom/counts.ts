import { parseCount, replaceCount } from '../../shared/format.ts';
import type { PrTotals } from '../../shared/filetree.ts';
import { outsideRoots, queryRoots } from './regions.ts';

/**
 * Rewrites the PR header's line counts (+additions −deletions) and the
 * "Files changed" counter in place.
 *
 * Only `nodeValue` of existing text nodes is changed, never the nodes
 * themselves, so React keeps ownership of its tree: if GitHub re-renders, it
 * simply writes its own value back and we patch it again. Targets are found by
 * the exact totals GitHub reports, which keeps per-file stats untouched.
 */

interface TextPatch {
  node: Text;
  original: string;
  patched: string;
}

interface AttrPatch {
  el: Element;
  name: string;
  original: string;
  patched: string;
}

/** Diffstats are found by their deletion count (`+N` `−N` are siblings in both UIs): red text is far rarer than green. */
const DELETION_CLASSES = ['fgColor-danger', 'color-fg-danger'];
const DELETION_SELECTOR = '.fgColor-danger, .color-fg-danger';
const ADDITION_CLASS = /\b(?:fgColor-success|color-fg-success)\b/;
const FILES_LINK_SELECTOR = 'a[href$="/files"], a[href$="/changes"]';
const FILE_DIFF_ID = /^diff-[0-9a-f]{64}$/;
const CAPPED_COUNT = /^[\s\u00a0(]*\d[\d.,\u00a0\u202f ]*\+[)\s]*$/;

export class CountPatcher {
  private texts: TextPatch[] = [];
  private attrs: AttrPatch[] = [];
  private patchedNodes = new WeakSet<Text>();
  private anchor: Element | null = null;
  /**
   * The smallest element holding every counter the last full search found
   * (on GitHub, a small part of the PR header). Searched first next time.
   */
  private scope: Element | null = null;
  /** The numbers last applied; when they change, the whole page is searched again. */
  private values = '';

  /** Container of the primary header diffstat; the indicator is placed here. */
  get diffstatAnchor(): Element | null {
    return this.anchor?.isConnected ? this.anchor : null;
  }

  private counterPatched = false;
  private diffstatPatched = false;
  /** A full scan found nothing that a scan skipping the `bulk` regions missed. */
  private bulkChecked = false;
  /** Whole-page searches in a row that did not find the "Files changed" counter. */
  private counterMisses = 0;

  /** Both the header diffstat and the "Files changed" counter were found and patched (see also `isIntact()`). */
  isComplete(): boolean {
    return this.diffstatPatched && this.counterPatched;
  }

  /** True when every patch is still in the DOM and still shows our value (also when there are none). */
  isIntact(): boolean {
    for (const p of this.texts) {
      if (!p.node.isConnected || p.node.nodeValue !== p.patched) return false;
    }
    for (const p of this.attrs) {
      if (!p.el.isConnected || p.el.getAttribute(p.name) !== p.patched) return false;
    }
    return true;
  }

  /**
   * Finds header counters showing `original` and makes them show `kept`.
   * Already-patched nodes are left alone, so calling this repeatedly is cheap
   * and causes no DOM writes when nothing new appeared.
   *
   * Unless `full`, only the part of the header where the counters were found
   * last time, or else where GitHub's ids say they are, is searched (a few
   * dozen elements), and the whole page only if something is missing there.
   * The whole page is searched without `bulk` (see regions.ts), which is
   * searched only if something is not found elsewhere. Returns whether the
   * whole page was searched.
   */
  apply(basePath: string, original: PrTotals, kept: PrTotals, bulk: () => readonly Element[], full = true): boolean {
    this.prune();
    const values = `${original.additions} ${original.deletions} ${original.files} ${kept.additions} ${kept.deletions} ${kept.files}`;
    if (values !== this.values) {
      // Patches outside the scope need the new numbers too.
      if (this.texts.length > 0 || this.attrs.length > 0) full = true;
      this.values = values;
    }
    if (!full) {
      for (const scope of [this.scope, landmarkScope()]) {
        if (!scope?.isConnected) continue;
        this.scan(basePath, original, kept, queryWithin(scope, DELETION_SELECTOR), queryWithin(scope, FILES_LINK_SELECTOR));
        if (this.diffstatPatched && this.counterPatched) {
          this.scope = scope;
          return false;
        }
      }
    }
    const regions = bulk();
    const roots = outsideRoots(regions);
    const found = this.scan(basePath, original, kept, findDeletions(roots), findTabLinks(roots));
    if (!this.counterPatched && (this.diffstatPatched || this.counterMisses >= 2)) {
      // The header is there (or had time to render), but its "Files changed" link isn't in a tab bar.
      found.push(...this.scan(basePath, original, kept, [], queryRoots(roots, FILES_LINK_SELECTOR)));
    }
    this.counterMisses = this.counterPatched ? 0 : this.counterMisses + 1;
    if (
      regions.length > 0 &&
      !this.bulkChecked &&
      !(this.diffstatPatched && this.counterPatched) &&
      // Before then, it is far more likely that the page hasn't rendered it yet.
      document.readyState === 'complete'
    ) {
      // Something is missing. Make sure it is not in `bulk`; if it was, keep looking there.
      const patches = this.texts.length + this.attrs.length;
      found.push(
        ...this.scan(basePath, original, kept, findDeletions(outsideRoots([])), document.querySelectorAll(FILES_LINK_SELECTOR)),
      );
      this.bulkChecked = this.texts.length + this.attrs.length === patches;
    }
    this.scope = commonAncestor(found);
    return true;
  }

  /** Finds the header diffstat without changing it (used when nothing is pruned). */
  locate(original: PrTotals, bulk: () => readonly Element[]): Element | null {
    if (this.diffstatAnchor) return this.diffstatAnchor;
    const regions = bulk();
    this.scanDiffstats(original, null, findDeletions(outsideRoots(regions)), []);
    if (!this.diffstatAnchor && regions.length > 0 && !this.bulkChecked) {
      this.scanDiffstats(original, null, findDeletions(outsideRoots([])), []);
      this.bulkChecked = !this.diffstatAnchor;
    }
    return this.diffstatAnchor;
  }

  restore(): void {
    for (const p of this.texts) {
      if (p.node.isConnected && p.node.nodeValue === p.patched) p.node.nodeValue = p.original;
    }
    for (const p of this.attrs) {
      if (p.el.isConnected && p.el.getAttribute(p.name) === p.patched) p.el.setAttribute(p.name, p.original);
    }
    this.texts = [];
    this.attrs = [];
    this.patchedNodes = new WeakSet();
    this.anchor = null;
    this.scope = null;
    this.values = '';
    this.counterPatched = false;
    this.diffstatPatched = false;
    this.bulkChecked = false;
    this.counterMisses = 0;
  }

  /** Makes the next `apply()` search the whole page (e.g. another tab of the PR is showing). */
  rescope(): void {
    this.scope = null;
    this.counterMisses = 0;
  }

  /** Drops bookkeeping for nodes GitHub removed or rewrote. */
  private prune(): void {
    this.texts = this.texts.filter((p) => {
      const alive = p.node.isConnected && p.node.nodeValue === p.patched;
      if (!alive) this.patchedNodes.delete(p.node);
      return alive;
    });
    this.attrs = this.attrs.filter((p) => p.el.isConnected && p.el.getAttribute(p.name) === p.patched);
    this.counterPatched = false;
    this.diffstatPatched = false;
  }

  /** Patches the counters among the candidates; returns the elements of those it found. */
  private scan(
    basePath: string,
    original: PrTotals,
    kept: PrTotals,
    deletions: Iterable<Element>,
    links: Iterable<Element>,
  ): Element[] {
    const found: Element[] = [];
    this.scanDiffstats(original, kept, deletions, found);
    this.patchFileCounters(basePath, original.files, kept.files, links as Iterable<HTMLAnchorElement>, found);
    return found;
  }

  /** Finds diffstats by their deletion count (`deletions`, in document order). */
  private scanDiffstats(original: PrTotals, kept: PrTotals | null, deletions: Iterable<Element>, found: Element[]): void {
    let first: Element | null = null;
    for (const del of deletions) {
      // Cheapest test first: most matches are other red text, not a diffstat.
      const add = del.previousElementSibling;
      if (!add || !ADDITION_CLASS.test(add.getAttribute('class') ?? '')) continue;
      if (insideFileDiff(add) || add.closest('[data-prune-ui]')) continue;
      const addNode = numberNode(add);
      const delNode = numberNode(del);
      if (!addNode || !delNode) continue;

      const addOk = this.patchedNodes.has(addNode) || isSigned(addNode, '+', original.additions);
      const delOk = this.patchedNodes.has(delNode) || isSigned(delNode, '-', original.deletions);
      if (!addOk || !delOk) continue;

      // First in document order is the main header (sticky copies come later).
      // Deliberately no visibility check: offsetParent & co. force a layout.
      first ??= add.parentElement;
      if (!kept) continue;

      found.push(del.parentElement ?? del);
      this.patchText(addNode, kept.additions);
      this.patchText(delNode, kept.deletions);
      this.diffstatPatched = true;

      // Screen-reader summary, e.g. "Lines changed: 751 additions & 1136 deletions".
      for (let sib = del.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (!/\b(?:sr-only|VisuallyHidden)/.test(sib.getAttribute('class') ?? '')) continue;
        const node = numberNode(sib);
        if (node && !this.patchedNodes.has(node)) {
          const text = node.nodeValue ?? '';
          const nums = text.match(/\d[\d.,]*/g)?.map((n) => Number(n.replace(/\D/g, '')));
          if (nums && nums[0] === original.additions && nums[1] === original.deletions) {
            let i = 0;
            const values = [kept.additions, kept.deletions];
            this.setText(
              node,
              text.replace(/\d[\d.,]*/g, (m) => (i < 2 ? replaceCount(m, values[i++]!) : m)),
            );
          }
        }
        break;
      }
    }
    if (!this.diffstatAnchor) this.anchor = first;
  }

  private patchFileCounters(
    basePath: string,
    original: number,
    kept: number,
    links: Iterable<HTMLAnchorElement>,
    found: Element[],
  ): void {
    for (const link of links) {
      const path = link.pathname;
      if (path !== `${basePath}/files` && path !== `${basePath}/changes`) continue;
      let counter = false;
      const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (this.patchedNodes.has(node)) {
          counter = true;
          continue;
        }
        const text = node.nodeValue ?? '';
        if (CAPPED_COUNT.test(text)) {
          // GitHub shows e.g. "5,000+" on huge PRs: nothing to patch, and nothing missing.
          counter = true;
          continue;
        }
        // Only bare counters like "38" or " (38)" — never labels.
        if (!/^[\s\u00a0(]*\d[\d.,\u00a0\u202f ]*[)\s]*$/.test(text)) continue;
        if (parseCount(text) !== original) continue;
        this.patchText(node, kept);
        counter = true;
      }
      for (const el of link.querySelectorAll('[title]')) {
        const title = el.getAttribute('title')!;
        if (parseCount(title) === original && /^[\d.,\s]+$/.test(title)) {
          const patched = replaceCount(title, kept);
          if (patched !== title) {
            this.attrs.push({ el, name: 'title', original: title, patched });
            el.setAttribute('title', patched);
          }
        }
      }
      if (counter) {
        this.counterPatched = true;
        found.push(link);
      }
    }
  }

  private patchText(node: Text, value: number): void {
    if (this.patchedNodes.has(node)) {
      // Already ours; update if the kept value changed (e.g. rules edited).
      const patch = this.texts.find((p) => p.node === node);
      if (patch) {
        const next = replaceCount(patch.original, value);
        if (next !== patch.patched) {
          patch.patched = next;
          node.nodeValue = next;
        }
      }
      return;
    }
    this.setText(node, replaceCount(node.nodeValue ?? '', value));
  }

  private setText(node: Text, patched: string): void {
    const original = node.nodeValue ?? '';
    this.texts.push({ node, original, patched });
    this.patchedNodes.add(node);
    if (patched !== original) node.nodeValue = patched;
  }
}

/*
 * Whole-page searches use one class or tag name per query: browsers answer
 * those from a fast path that is several times cheaper than a selector list
 * (on a 5,000-element page ~30 µs instead of ~230 µs).
 */

/** Elements with a deletion class in `roots` (see regions.ts), in document order. */
function findDeletions(roots: readonly Element[]): Element[] {
  const [a, b] = DELETION_CLASSES.map((name) => queryRoots(roots, `.${name}`)) as [Element[], Element[]];
  if (a.length === 0 || b.length === 0) return a.length === 0 ? b : a;
  return [...new Set([...a, ...b])].sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/** "Files changed" links in the tab bars (`<nav>`, in both UIs) in `roots`. */
function findTabLinks(roots: readonly Element[]): Set<Element> {
  const links = new Set<Element>();
  for (const nav of queryRoots(roots, 'nav')) {
    for (const link of nav.querySelectorAll(FILES_LINK_SELECTOR)) links.add(link);
  }
  return links;
}

/**
 * The part of the PR header holding its counters, by the ids GitHub gives
 * them: `#diffstat` and `#files_tab_counter` (classic UI), and the "Files
 * changed" tab `#prs-files-anchor-tab` (React header, whose diffstat is next
 * to the tabs). Free to look up; whatever it misses is searched for anyway.
 */
function landmarkScope(): Element | null {
  const diffstat = document.getElementById('diffstat');
  const link = document.getElementById('prs-files-anchor-tab') ?? document.getElementById('files_tab_counter');
  if (diffstat && link) return commonAncestor([diffstat, link]);
  return link?.closest('[data-component="PH_Navigation"]') ?? link?.closest('a') ?? diffstat;
}

/** `root` and its descendants that match `selector`, in document order. */
function queryWithin(root: Element, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)];
  if (root.matches(selector)) found.unshift(root);
  return found;
}

/** The deepest element containing all of `els`; null if that is <body> or above (no point scoping). */
function commonAncestor(els: readonly Element[]): Element | null {
  let common: Element | null = els[0] ?? null;
  for (const el of els) while (common && !common.contains(el)) common = common.parentElement;
  return common && common !== document.body && common !== document.documentElement ? common : null;
}

/** The text node that holds the digits inside `el`. */
function numberNode(el: Element): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (/\d/.test(node.nodeValue ?? '')) return node;
  }
  return null;
}

/** Checks the node (plus its preceding sign node, if React split them) shows `sign` + `value`. */
function isSigned(node: Text, sign: '+' | '-', value: number): boolean {
  const own = node.nodeValue ?? '';
  const full = (node.parentElement?.textContent ?? own).trim();
  const signOk = sign === '+' ? full.startsWith('+') : /^[-\u2212\u2013]/.test(full);
  return signOk && parseCount(own) === value;
}

function insideFileDiff(el: Element): boolean {
  for (let c = el.closest('[id^="diff-"]'); c; c = c.parentElement?.closest('[id^="diff-"]') ?? null) {
    if (FILE_DIFF_ID.test(c.id)) return true;
  }
  return false;
}
