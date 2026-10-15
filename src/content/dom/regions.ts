import type { PruneResult } from '../../shared/prune.ts';

/**
 * On a big "Files changed" tab, the diff list and the file tree are nearly the
 * whole DOM (200k+ elements on a 3000-file PR), and the header counters are
 * never inside them. Header scans skip them, which turns a document-wide
 * querySelectorAll into a few small ones.
 */

const FILE_DIFF_ID = /^diff-[0-9a-f]{64}$/;

export class BulkRegions {
  private list: Element | null = null;
  private tree: Element | null = null;

  /** The diff list and file tree that are on the page. Cheap once found. */
  find(result: PruneResult): Element[] {
    if (!this.list?.isConnected) this.list = firstDiff(result);
    if (this.list) this.list = growList(this.list);
    if (!this.tree?.isConnected) this.tree = findTree(result);
    const regions: Element[] = [];
    if (this.list) regions.push(this.list);
    if (this.tree && !this.tree.contains(this.list)) regions.push(this.tree);
    return regions;
  }

  /**
   * The element whose children are the file diffs, as of the last `find()`:
   * the diff list without the wrappers it may be the only child of.
   */
  diffList(): Element | null {
    let list = this.list;
    if (!list?.isConnected) return null;
    if (FILE_DIFF_ID.test(list.id)) return list.parentElement;
    while (list.childElementCount === 1 && !FILE_DIFF_ID.test(list.firstElementChild!.id)) list = list.firstElementChild!;
    return list;
  }

  reset(): void {
    this.list = null;
    this.tree = null;
  }
}

/** Some file diff on the page: by id when possible, else the first one in the document. */
function firstDiff(result: PruneResult): Element | null {
  for (const digest of result.probes) {
    const diff = document.getElementById(`diff-${digest}`);
    if (diff) return diff;
  }
  for (const file of result.pruned) {
    const diff = document.getElementById(`diff-${file.digest}`);
    if (diff) return diff;
  }
  // Other `diff-` ids (like a wrapper's) come before the diffs they contain.
  let el = document.querySelector('[id^="diff-"]');
  while (el && !FILE_DIFF_ID.test(el.id)) el = el.querySelector('[id^="diff-"]');
  return el;
}

/**
 * Climbs from `el` while the parent's other children hold file diffs too (or
 * there are none), up to the element holding all of them. GitHub renders
 * diffs in batches and not in file-tree order, so this is re-run as they load.
 */
function growList(el: Element): Element {
  let list = el;
  for (let parent = list.parentElement; parent && parent !== document.body; parent = list.parentElement) {
    let others = false;
    let holders = false;
    for (let child = parent.firstElementChild; child && !holders; child = child.nextElementSibling) {
      if (child === list) continue;
      others = true;
      holders = holdsDiff(child);
    }
    if (others && !holders) break;
    list = parent;
  }
  return list;
}

function holdsDiff(el: Element): boolean {
  const diff = el.id.startsWith('diff-') ? el : el.querySelector('[id^="diff-"]');
  return !!diff && FILE_DIFF_ID.test(diff.id);
}

/** The file tree: rows are `#file-tree-item-diff-<digest>` (classic UI) or have the path as id (new UI). */
function findTree(result: PruneResult): Element | null {
  if (!result.firstPath) return null;
  const item =
    document.getElementById(`file-tree-item-diff-${result.probes[0]}`) ?? document.getElementById(result.firstPath);
  return item?.matches('[role="treeitem"]') ? item.closest('[role="tree"]') : null;
}

/** `document.querySelectorAll(selector)` without the subtrees of `skip`, in document order. */
export function queryOutside(selector: string, skip: readonly Element[]): Iterable<Element> {
  const root = document.documentElement;
  // Only proper containers in the document itself (not <html>/<body>, not in a shadow tree).
  const skipped = new Set(skip.filter((el) => el !== document.body && el !== root && root.contains(el)));
  if (skipped.size === 0) return document.querySelectorAll(selector);
  const ancestors = new Set<Element>();
  for (const el of skipped) for (let n = el.parentElement; n && !ancestors.has(n); n = n.parentElement) ancestors.add(n);
  const found: Element[] = root.matches(selector) ? [root] : [];
  // Walk down the ancestors of skipped elements; their other children are queried whole.
  const visit = (parent: Element): void => {
    for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
      if (skipped.has(child)) continue;
      if (child.matches(selector)) found.push(child);
      if (ancestors.has(child)) visit(child);
      else for (const el of child.querySelectorAll(selector)) found.push(el);
    }
  };
  visit(root);
  return found;
}
