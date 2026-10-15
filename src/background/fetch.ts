import { fetchPrTotals, JSON_HEADERS } from '../shared/endpoints.ts';
import { parseFileTree, type PrFileList, type PrTotals } from '../shared/filetree.ts';
import { CHROMIUM } from '../shared/target.ts';

/**
 * Chromium only: the background script fetches a PR's file list (and, for
 * capped lists, its totals) itself, so the page doesn't fetch, read or pass
 * along anything. In Chromium every regular tab of a profile uses the
 * profile's cookies, and so do the service worker's requests to github.com
 * (it has host access through the content script's match pattern), so
 * GitHub answers them for the same session the tab's own request would have.
 *
 * Everywhere else the page fetches with its own cookies (content/github.ts):
 * in Firefox the background script would use the default container's cookies
 * whatever container the tab is in, and in Chromium an incognito tab's
 * requests would go out with the regular profile's cookies (extensions span
 * both). Either would ask GitHub with another session than the tab's, and
 * show what that session can see.
 */
export function fetchesFor(sender: browser.runtime.MessageSender): boolean {
  const tab = sender.tab;
  // Firefox sets cookieStoreId on every tab; Chromium never does.
  return CHROMIUM && !!tab && !tab.incognito && tab.cookieStoreId === undefined;
}

const ORIGIN = 'https://github.com';
/** The only paths fetched: a PR's own. */
const PR_BASE_PATH = /^\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/**
 * Requests are never redirected (to a login page or anywhere else with the
 * cookies) and skip the HTTP cache: stored results take its place.
 */
const INIT: RequestInit = { credentials: 'include', redirect: 'error', cache: 'no-store' };

export interface FetchedList {
  etag: string | null;
  /** Null when GitHub answered 304 Not Modified to the ETag passed in. */
  files: PrFileList | null;
}

/** The PR's file list, or null for anything but GitHub's JSON for it. */
export async function fetchFileList(basePath: string, etag: string | null): Promise<FetchedList | null> {
  if (!PR_BASE_PATH.test(basePath)) return null;
  try {
    const res = await fetch(`${ORIGIN}${basePath}/page_data/file_tree`, {
      ...INIT,
      headers: etag ? { ...JSON_HEADERS, 'If-None-Match': etag } : JSON_HEADERS,
    });
    if (res.status === 304 && etag) return { etag, files: null };
    if (res.status !== 200) return null;
    return { etag: res.headers.get('ETag'), files: parseFileTree(await res.text()) };
  } catch {
    return null;
  }
}

export function fetchTotals(basePath: string): Promise<Partial<PrTotals>> {
  return PR_BASE_PATH.test(basePath) ? fetchPrTotals(`${ORIGIN}${basePath}`, INIT) : Promise.resolve({});
}

interface Pending {
  list: Promise<FetchedList | null>;
  /** Started along with the list when the stored one was capped. */
  totals: Promise<Partial<PrTotals>> | null;
}

/** Fetches started on `lookup`, for the `prune` that follows, by tab and PR. */
const pending = new Map<string, Pending>();
/** A started fetch nobody asked for is dropped after this long. */
const PENDING_TTL_MS = 30_000;

/** Starts fetching for `id` (tab and PR) ahead of the `prune` message. */
export function prefetch(id: string, basePath: string, etag: string | null, capped: boolean): void {
  const entry: Pending = { list: fetchFileList(basePath, etag), totals: capped ? fetchTotals(basePath) : null };
  pending.set(id, entry);
  setTimeout(() => {
    if (pending.get(id) === entry) pending.delete(id);
  }, PENDING_TTL_MS);
}

/** What prefetch() started for `id`, if anything (only once). */
export function takePrefetched(id: string): Pending | null {
  const entry = pending.get(id) ?? null;
  pending.delete(id);
  return entry;
}
