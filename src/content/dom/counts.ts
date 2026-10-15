import { parseCount, replaceCount } from '../../shared/format.ts';
import type { PrTotals } from '../../shared/filetree.ts';
import { queryOutside } from './regions.ts';

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

const ADDITION_SELECTOR = '.fgColor-success, .color-fg-success';
const FILES_LINK_SELECTOR = 'a[href$="/files"], a[href$="/changes"]';
const DELETION_CLASS = /\b(?:fgColor-danger|color-fg-danger)\b/;
const FILE_DIFF_ID = /^diff-[0-9a-f]{64}$/;
const CAPPED_COUNT = /^[\s\u00a0(]*\d[\d.,\u00a0\u202f ]*\+[)\s]*$/;

export class CountPatcher {
  private texts: TextPatch[] = [];
  private attrs: AttrPatch[] = [];
  private patchedNodes = new WeakSet<Text>();
  private anchor: Element | null = null;

  /** Container of the primary header diffstat; the indicator is placed here. */
  get diffstatAnchor(): Element | null {
    return this.anchor?.isConnected ? this.anchor : null;
  }

  private counterPatched = false;
  private diffstatPatched = false;
  /** A full scan found nothing that a scan skipping the `bulk` regions missed. */
  private bulkChecked = false;

  /** Both the header diffstat and the "Files changed" counter were found and patched. */
  isComplete(): boolean {
    return this.isIntact() && this.diffstatPatched && this.counterPatched;
  }

  /** True when every patch is still in the DOM and still shows our value. */
  isIntact(): boolean {
    for (const p of this.texts) {
      if (!p.node.isConnected || p.node.nodeValue !== p.patched) return false;
    }
    for (const p of this.attrs) {
      if (!p.el.isConnected || p.el.getAttribute(p.name) !== p.patched) return false;
    }
    return this.texts.length > 0;
  }

  /**
   * Finds header counters showing `original` and makes them show `kept`.
   * Already-patched nodes are left alone, so calling this repeatedly is cheap
   * and causes no DOM writes when nothing new appeared. `bulk` (see regions.ts)
   * is searched only if something is not found elsewhere.
   */
  apply(basePath: string, original: PrTotals, kept: PrTotals, bulk: readonly Element[] = []): void {
    this.prune();
    // One pass over the DOM for both kinds of counters.
    const additions: Element[] = [];
    const links: HTMLAnchorElement[] = [];
    for (const el of queryOutside(`${ADDITION_SELECTOR}, ${FILES_LINK_SELECTOR}`, bulk)) {
      if (el.localName === 'a' && el.matches(FILES_LINK_SELECTOR)) links.push(el as HTMLAnchorElement);
      if (el.classList.contains('fgColor-success') || el.classList.contains('color-fg-success')) additions.push(el);
    }
    this.scanDiffstats(original, kept, additions);
    this.patchFileCounters(basePath, original.files, kept.files, links);
    if (
      bulk.length > 0 &&
      !this.bulkChecked &&
      !(this.diffstatPatched && this.counterPatched) &&
      // Before then, it is far more likely that the page hasn't rendered it yet.
      document.readyState === 'complete'
    ) {
      // Something is missing. Make sure it is not in `bulk`; if it was, keep looking there.
      const patches = this.texts.length + this.attrs.length;
      this.apply(basePath, original, kept);
      this.bulkChecked = this.texts.length + this.attrs.length === patches;
    }
  }

  /** Finds the header diffstat without changing it (used when nothing is pruned). */
  locate(original: PrTotals, bulk: readonly Element[] = []): Element | null {
    if (!this.diffstatAnchor) this.scanDiffstats(original, null, queryOutside(ADDITION_SELECTOR, bulk));
    if (!this.diffstatAnchor && bulk.length > 0 && !this.bulkChecked) {
      this.scanDiffstats(original, null, document.querySelectorAll(ADDITION_SELECTOR));
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
    this.counterPatched = false;
    this.diffstatPatched = false;
    this.bulkChecked = false;
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

  private scanDiffstats(original: PrTotals, kept: PrTotals | null, additions: Iterable<Element>): void {
    let first: Element | null = null;
    for (const add of additions) {
      // Cheapest test first: most matches are other green text, not a diffstat.
      const del = add.nextElementSibling;
      if (!del || !DELETION_CLASS.test(del.getAttribute('class') ?? '')) continue;
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

  private patchFileCounters(basePath: string, original: number, kept: number, links: Iterable<HTMLAnchorElement>): void {
    const targets = new Set([`${basePath}/files`, `${basePath}/changes`]);
    for (const link of links) {
      if (!targets.has(link.pathname)) continue;
      const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (this.patchedNodes.has(node)) {
          this.counterPatched = true;
          continue;
        }
        const text = node.nodeValue ?? '';
        if (CAPPED_COUNT.test(text)) {
          // GitHub shows e.g. "5,000+" on huge PRs: nothing to patch, and nothing missing.
          this.counterPatched = true;
          continue;
        }
        // Only bare counters like "38" or " (38)" — never labels.
        if (!/^[\s\u00a0(]*\d[\d.,\u00a0\u202f ]*[)\s]*$/.test(text)) continue;
        if (parseCount(text) !== original) continue;
        this.patchText(node, kept);
        this.counterPatched = true;
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
