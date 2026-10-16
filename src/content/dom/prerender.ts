import type { PrTotals } from '../../shared/filetree.ts';
import { parseCount, replaceCount } from '../../shared/format.ts';
import type { PruneResult } from '../../shared/prune.ts';
import type { DiffMode, TreeMode } from '../../shared/settings.ts';
import { landmarks } from './counts.ts';

/**
 * Pre-rendering: a PR seen before shows pruned from the first frame, before
 * the background script or GitHub have answered anything. What PRune showed
 * last time (the pruned files, the totals and the modes) is kept in the page's
 * localStorage, the one store a content script can read synchronously at
 * document_start. Nothing is written in private windows; Firefox keeps a
 * localStorage per container. GitHub's own scripts can read it, but it only
 * holds what GitHub sent: paths and digests of files in PRs the user opened.
 *
 * The stylesheet is built from it by dom/styles.ts as for real data. When the
 * real data prunes the same files, that sheet is already the right one and is
 * not written again: in Chromium any stylesheet change restyles the whole
 * document, which before the diffs have rendered costs nothing and after can
 * cost a second.
 *
 * The header counters are not patched ahead of the data: React hydrates
 * GitHub's header, and text that doesn't match what the server rendered would
 * make it render the header again. Instead, each counter showing the stored
 * totals gets a `data-prune-kept` attribute holding its pruned text, which a
 * static stylesheet shows in place of its own (`CountMarks`). Counters are
 * looked for from requestAnimationFrame callbacks, which run before every
 * frame is drawn, so the original numbers never show. A counter showing other numbers
 * means the PR changed since: then no counter is marked, and the stylesheet's
 * rules, keyed on file paths, stay right (only new files may show until the
 * data is here). Once the real data has patched a counter's text, its mark
 * goes.
 */

/** A PR's pre-render, as stored. */
export interface Snapshot {
  diffMode: DiffMode;
  treeMode: TreeMode;
  /**
   * The pruned files, their directories and the totals, enough to build the
   * stylesheet and to compare with the real result (see `sameSnapshot()`).
   */
  result: PruneResult;
  /** The stored text, to tell whether there is anything new to store. */
  raw: string;
}

const PREFIX = 'prune:';
/** Stored keys (without the prefix) and sizes, most recently used first. */
const INDEX_KEY = 'prune:index';
const VERSION = 1;
/**
 * localStorage is held in memory by every github.com tab, so the pre-renders
 * kept are few and small: most are a few hundred characters; a PR pruning a
 * thousand vendored files would be ~100k and is not kept.
 */
export const MAX_ENTRIES = 50;
export const MAX_ENTRY_CHARS = 64 * 1024;
export const MAX_TOTAL_CHARS = 256 * 1024;

const DIFF_MODES: readonly DiffMode[] = ['hide', 'collapse', 'show'];
const TREE_MODES: readonly TreeMode[] = ['hide', 'dim'];
const DIGESTS = /^(?:[0-9a-f]{64})+$/;

/** The page's localStorage; null where it is unavailable (storage blocked, sandboxed). */
export function pageStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The pre-render stored for `key` (a PR key), if valid. */
export function readSnapshot(storage: Storage, key: string): Snapshot | null {
  try {
    const raw = storage.getItem(PREFIX + key);
    return raw ? decode(raw) : null;
  } catch {
    return null;
  }
}

/** What `result` looks like, stored. Its order is kept: the stylesheet is built in that order. */
export function encode(result: PruneResult, diffMode: DiffMode, treeMode: TreeMode): string {
  const { original: o, kept: k } = result;
  return JSON.stringify([
    VERSION,
    diffMode,
    treeMode,
    o.additions,
    o.deletions,
    o.files,
    k.additions,
    k.deletions,
    k.files,
    result.pruned.map((f) => f.digest).join(''),
    result.pruned.map((f) => f.path),
    result.prunedDirs,
  ]);
}

/**
 * Parses a stored pre-render. Anything off is rejected: the page can write
 * here too, and digests and paths end up in CSS selectors.
 */
export function decode(raw: string): Snapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 12 || value[0] !== VERSION) return null;
  const [, diffMode, treeMode, ...rest] = value as unknown[];
  const numbers = rest.slice(0, 6);
  const [digests, paths, dirs] = rest.slice(6) as [unknown, unknown, unknown];
  if (!DIFF_MODES.includes(diffMode as DiffMode) || !TREE_MODES.includes(treeMode as TreeMode)) return null;
  if (!numbers.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return null;
  if (typeof digests !== 'string' || !DIGESTS.test(digests)) return null;
  if (!isStrings(paths) || paths.length * 64 !== digests.length || !isStrings(dirs)) return null;
  const [oa, od, of, ka, kd, kf] = numbers as number[];
  const original: PrTotals = { additions: oa!, deletions: od!, files: of! };
  const kept: PrTotals = { additions: ka!, deletions: kd!, files: kf! };
  return {
    diffMode: diffMode as DiffMode,
    treeMode: treeMode as TreeMode,
    raw,
    result: {
      listed: 0,
      pruned: paths.map((path, i) => ({
        path,
        digest: digests.slice(i * 64, i * 64 + 64),
        additions: 0,
        deletions: 0,
        generated: false,
        rule: '',
        source: '',
      })),
      prunedDirs: dirs,
      original,
      kept,
      removed: {
        additions: original.additions - kept.additions,
        deletions: original.deletions - kept.deletions,
        files: original.files - kept.files,
      },
      sources: [],
      probes: [],
      firstPath: null,
    },
  };
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === 'string');
}

/** Whether the header shows the same numbers with `snapshot` as with `result`. */
export function sameTotals(snapshot: Snapshot, result: PruneResult): boolean {
  const a = snapshot.result;
  return (
    a.original.additions === result.original.additions &&
    a.original.deletions === result.original.deletions &&
    a.original.files === result.original.files &&
    a.kept.additions === result.kept.additions &&
    a.kept.deletions === result.kept.deletions &&
    a.kept.files === result.kept.files
  );
}

/**
 * Stores `raw` (from `encode()`) for `key`, as the most recently used. The
 * least recently used go once there are more than MAX_ENTRIES or more than
 * MAX_TOTAL_CHARS; one larger than MAX_ENTRY_CHARS is not kept at all.
 * `unchanged`: the same text is stored already, so only its place in the
 * index is updated.
 */
export function saveSnapshot(storage: Storage, key: string, raw: string, unchanged = false): void {
  try {
    const index = readIndex(storage);
    const at = index.findIndex(([k]) => k === key);
    if (unchanged && at === 0) return;
    if (at >= 0) index.splice(at, 1);
    if (raw.length > MAX_ENTRY_CHARS) {
      storage.removeItem(PREFIX + key);
      if (at >= 0) storage.setItem(INDEX_KEY, JSON.stringify(index));
      return;
    }
    index.unshift([key, raw.length]);
    // Entries the index lost track of (two tabs saving at once) are dropped.
    const known = new Set(index.map(([k]) => PREFIX + k));
    known.add(INDEX_KEY);
    for (const k of ownKeys(storage)) if (!known.has(k)) storage.removeItem(k);
    let total = 0;
    let keep = 0;
    while (keep < index.length && keep < MAX_ENTRIES && total + index[keep]![1] <= MAX_TOTAL_CHARS) {
      total += index[keep]![1];
      keep++;
    }
    for (const [k] of index.splice(keep)) storage.removeItem(PREFIX + k);
    if (!unchanged) storage.setItem(PREFIX + key, raw);
    storage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Out of quota (GitHub's own data comes first) or unavailable: keep nothing.
    clearSnapshots(storage);
  }
}

/** Forgets the pre-renders of the PRs `drop` picks (a PR key), or all of them. */
export function clearSnapshots(storage: Storage, drop: (key: string) => boolean = () => true): void {
  try {
    const index = readIndex(storage).filter(([k]) => !drop(k));
    for (const k of ownKeys(storage)) {
      if (k !== INDEX_KEY && drop(k.slice(PREFIX.length))) storage.removeItem(k);
    }
    if (index.length > 0) storage.setItem(INDEX_KEY, JSON.stringify(index));
    else storage.removeItem(INDEX_KEY);
  } catch {
    // Nothing to do without storage.
  }
}

function readIndex(storage: Storage): [string, number][] {
  try {
    const index: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? '[]');
    if (!Array.isArray(index)) return [];
    return index.filter(
      (e): e is [string, number] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number',
    );
  } catch {
    return [];
  }
}

/** PRune's keys in `storage`. */
function ownKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

// ---- Header counters ----------------------------------------------------------

const STYLE_ID = 'prune-pre';
const KEPT_ATTR = 'data-prune-kept';
/**
 * A marked counter shows its mark instead of its text, at the same size and
 * in the same style: the text is hidden and squeezed into a zero-width grid
 * column, the mark comes after it. Counters with a background (`.Counter`,
 * `CounterLabel`) keep their box: only their text is made transparent there.
 * Hidden text is left out of the accessibility tree; the mark is read instead.
 */
const MARK_CSS = /* css */ `
  :root [data-prune-kept]:not([hidden]) {
    display: inline-grid;
    grid-template-columns: 0 auto;
    white-space: nowrap;
    visibility: hidden;
  }
  :root [data-prune-kept]::after {
    content: attr(data-prune-kept);
    visibility: visible;
  }
  :root .Counter[data-prune-kept], :root [data-component="CounterLabel"][data-prune-kept] {
    visibility: visible;
    -webkit-text-fill-color: transparent;
  }
  :root .Counter[data-prune-kept]::after, :root [data-component="CounterLabel"][data-prune-kept]::after {
    -webkit-text-fill-color: currentcolor;
  }
`;

const DELETIONS = '.fgColor-danger, .color-fg-danger';
const ADDITION_CLASS = /\b(?:fgColor-success|color-fg-success)\b/;
const SCREEN_READER_CLASS = /\b(?:sr-only|VisuallyHidden)/;
const COUNTERS = '#files_tab_counter, #prs-files-anchor-tab [data-component="CounterLabel"]';

/**
 * Shows the header counters with the stored pruned totals until the real data
 * has patched them (see the top of this file).
 */
export class CountMarks {
  private markSheet: HTMLStyleElement | null = null;
  private shownTotals: PrTotals | null = null;
  private prunedTotals: PrTotals | null = null;
  private markedEls: Element[] = [];
  private frameId = 0;
  /** The header's diffstat and files counter have been marked (or found patched). */
  private foundCounters = 0;

  /** Starts marking the counters that show `original`. */
  start(original: PrTotals, kept: PrTotals): void {
    this.stop();
    this.shownTotals = original;
    this.prunedTotals = kept;
    if (!this.markSheet) {
      this.markSheet = document.createElement('style');
      this.markSheet.id = STYLE_ID;
      this.markSheet.textContent = MARK_CSS;
    }
    // Before <head> exists at document_start; a full-page navigation may take it away.
    if (!this.markSheet.isConnected) document.documentElement.append(this.markSheet);
    this.onFrame();
  }

  /** Unmarks the counters that now show their mark as text (the real data's patches). */
  settle(): void {
    this.markedEls = this.markedEls.filter((el) => {
      if (el.isConnected && el.textContent?.trim() !== el.getAttribute(KEPT_ATTR)) return true;
      el.removeAttribute(KEPT_ATTR);
      return false;
    });
  }

  /** Unmarks every counter and stops looking for more. */
  stop(): void {
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.shownTotals = this.prunedTotals = null;
    this.foundCounters = 0;
    for (const el of this.markedEls) el.removeAttribute(KEPT_ATTR);
    this.markedEls = [];
  }

  /** Whether counters are still marked or looked for. */
  get active(): boolean {
    return !!this.shownTotals || this.markedEls.length > 0;
  }

  private readonly onFrame = (): void => {
    this.frameId = 0;
    if (!this.shownTotals) return;
    if (!this.markCounters()) {
      // The PR has changed since: its numbers are no longer known.
      this.stop();
      return;
    }
    // Looked for until both are found; the real data's patches take over the rest.
    if (this.foundCounters !== 3) this.frameId = requestAnimationFrame(this.onFrame);
  };

  /** Marks the counters that render meanwhile. False if one shows other numbers. */
  private markCounters(): boolean {
    const original = this.shownTotals!;
    const kept = this.prunedTotals!;
    for (const place of landmarks()) {
      for (const del of place.querySelectorAll(DELETIONS)) {
        const add = del.previousElementSibling;
        if (!add || !ADDITION_CLASS.test(add.getAttribute('class') ?? '')) continue;
        const a = this.check(add, [original.additions], [kept.additions]);
        const d = this.check(del, [original.deletions], [kept.deletions]);
        if (a === null || d === null) return false;
        const sr = del.nextElementSibling;
        if (sr && SCREEN_READER_CLASS.test(sr.getAttribute('class') ?? '')) {
          // "Lines changed: 751 additions & 1136 deletions": both numbers, or it is not ours to mark.
          this.check(sr, [original.additions, original.deletions], [kept.additions, kept.deletions]);
        }
        this.foundCounters |= 1;
      }
      for (const counter of place.querySelectorAll(COUNTERS)) {
        const c = this.check(counter, [original.files], [kept.files]);
        if (c === null) return false;
        const sr = counter.nextElementSibling;
        if (sr && SCREEN_READER_CLASS.test(sr.getAttribute('class') ?? '')) this.check(sr, [original.files], [kept.files]);
        this.foundCounters |= 2;
      }
    }
    return true;
  }

  /**
   * Marks `el` if its text shows the numbers `from`, with them replaced by
   * `to`. True if it is marked or shows `to` already; null if it shows other
   * numbers.
   */
  private check(el: Element, from: readonly number[], to: readonly number[]): boolean | null {
    if (el.hasAttribute(KEPT_ATTR)) return true;
    // Only a counter's own text (no elements inside) can be swapped for a mark.
    if (el.childElementCount > 0) return false;
    const text = (el.textContent ?? '').trim();
    const numbers = text.match(/\d(?:[\d.,   ]*\d)?/g)?.map((n) => parseCount(n)) ?? [];
    if (numbers.length < from.length) return false;
    if (to.every((n, i) => numbers[i] === n)) return true;
    if (!from.every((n, i) => numbers[i] === n)) return null;
    if (from.every((n, i) => n === to[i])) return true;
    let i = 0;
    const mark = text.replace(/\d(?:[\d.,   ]*\d)?/g, (m) => (i < to.length ? replaceCount(m, to[i++]!) : m));
    el.setAttribute(KEPT_ATTR, mark);
    this.markedEls.push(el);
    return true;
  }
}
