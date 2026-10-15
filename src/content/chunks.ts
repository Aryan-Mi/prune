/**
 * Parts of the content script most PR visits never use, each built into a file
 * of its own (scripts/build.ts) and imported on first use: content.js is
 * compiled and kept in memory on every PR page, these only when needed. They
 * are web-accessible resources and run in this content script's world, like
 * content.js when the loader imports it. Each is imported once.
 *
 * `browser` is `chrome` in the Chromium build; spelled out, Mozilla's linter
 * can tell these import the extension's own files.
 */
import type * as CollapseChunk from './dom/collapse.ts';
import type * as PopoverChunk from './ui/popover.ts';
import type * as SectionChunk from './ui/section-box.ts';

let popover: Promise<typeof PopoverChunk> | null = null;
let section: Promise<typeof SectionChunk> | null = null;
let collapse: Promise<typeof CollapseChunk> | null = null;

/** The ✂ pill's popover: imported when the pointer reaches the pill, or it gets focus. */
export function withPopover(use: (chunk: typeof PopoverChunk) => void): void {
  run(() => (popover ??= import(browser.runtime.getURL('popover.js'))), use, () => (popover = null));
}

/** The "Pruned files" box: imported when its placeholder comes near the viewport. */
export function withSection(use: (chunk: typeof SectionChunk) => void): void {
  run(() => (section ??= import(browser.runtime.getURL('section.js'))), use, () => (section = null));
}

/** Collapse mode: imported only when that setting is on. */
export function withCollapse(use: (chunk: typeof CollapseChunk) => void): void {
  run(() => (collapse ??= import(browser.runtime.getURL('collapse.js'))), use, () => (collapse = null));
}

/**
 * Calls `use` once the chunk is there; a failed import is logged and tried
 * again next time. (`getURL` may throw once the extension was updated or
 * removed while the page stayed open.)
 */
function run<T>(load: () => Promise<T>, use: (chunk: T) => void, forget: () => void): void {
  let chunk: Promise<T>;
  try {
    chunk = load();
  } catch (err) {
    chunk = Promise.reject(err);
  }
  chunk.then(use, (err: unknown) => {
    forget();
    console.error('[PRune]', err);
  });
}
