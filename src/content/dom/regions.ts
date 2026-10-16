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

/**
 * Some file diff on the page: by id when possible, else the first one in the
 * document. (Looking up the pruned files' ids too would only cost more while
 * the diffs haven't rendered yet: the search below finds any.)
 */
function firstDiff(result: PruneResult): Element | null {
  for (const digest of result.probes) {
    const diff = document.getElementById(`diff-${digest}`);
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
 * A batch that hasn't loaded yet looks like a loaded one (same tag and
 * class), so it counts too: otherwise the list would stop at the first batch.
 */
function growList(el: Element): Element {
  let list = el;
  for (let parent = list.parentElement; parent && parent !== document.body; parent = list.parentElement) {
    const kind = list.getAttribute('class');
    let others = false;
    let holders = false;
    for (let child = parent.firstElementChild; child && !holders; child = child.nextElementSibling) {
      if (child === list) continue;
      others = true;
      holders = (!!kind && child.localName === list.localName && child.getAttribute('class') === kind) || holdsDiff(child);
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

/**
 * The largest subtrees of the document that hold none of `skip`, in document
 * order. Querying them (see `queryRoots`) is `document.querySelectorAll()`
 * without `skip`, and without the ancestors of `skip` (which hold no counters,
 * since they hold a diff list or file tree). Compute once, query many times.
 */
export function outsideRoots(skip: readonly Element[]): Element[] {
  const root = document.documentElement;
  // Only proper containers in the document itself (not <html>/<body>, not in a shadow tree).
  const skipped = new Set(skip.filter((el) => el !== document.body && el !== root && root.contains(el)));
  if (skipped.size === 0) return [root];
  const ancestors = new Set<Element>();
  for (const el of skipped) for (let n = el.parentElement; n && !ancestors.has(n); n = n.parentElement) ancestors.add(n);
  const roots: Element[] = [];
  // Walk down the ancestors of skipped elements; their other children are roots.
  const visit = (parent: Element): void => {
    for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
      if (skipped.has(child)) continue;
      if (ancestors.has(child)) visit(child);
      else roots.push(child);
    }
  };
  visit(root);
  return roots;
}

/**
 * Elements in `roots` (from `outsideRoots`) matching `selector`, in document
 * order. Pass one class or tag name: browsers answer those from a fast path
 * that is several times cheaper than a selector list.
 */
export function queryRoots(roots: readonly Element[], selector: string): Element[] {
  const found: Element[] = [];
  for (const root of roots) {
    if (root.matches(selector)) found.push(root);
    // Most roots next to the big regions are leaves (<link>, <button>, ...).
    if (root.firstElementChild) for (const el of root.querySelectorAll(selector)) found.push(el);
  }
  return found;
}
