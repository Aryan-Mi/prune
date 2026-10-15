/**
 * What the page and (in Chromium) the background script share about GitHub's
 * PR data endpoints. Kept apart from prune.ts, so the content script doesn't
 * bundle the rule matcher.
 */
import type { PrTotals } from './filetree.ts';
import type { PruneResult } from './prune.ts';

export const JSON_HEADERS = {
  Accept: 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
};

/**
 * GitHub lists at most this many files (in its UI and API alike). Below it,
 * the listed files' sums are exactly the totals in the PR header (checked on
 * PRs with renames, deletions, binary files and submodules), so GitHub's
 * separate totals endpoints are only needed for longer lists.
 */
export const LIST_CAP = 3000;

/** Whether GitHub may have left files out of the list, so that its own totals are needed. */
export function isCapped(result: PruneResult): boolean {
  return result.listed >= LIST_CAP;
}

/** `result` with GitHub's totals for the whole PR (for capped lists). */
export function applyTotals(result: PruneResult, totals: Partial<PrTotals>): PruneResult {
  const original: PrTotals = {
    additions: totals.additions ?? result.original.additions,
    deletions: totals.deletions ?? result.original.deletions,
    files: totals.files ?? result.original.files,
  };
  return { ...result, original, kept: keptTotals(original, result.removed) };
}

export function keptTotals(original: PrTotals, removed: PrTotals): PrTotals {
  return {
    additions: Math.max(0, original.additions - removed.additions),
    deletions: Math.max(0, original.deletions - removed.deletions),
    files: Math.max(0, original.files - removed.files),
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, headers: JSON_HEADERS });
    if (!res.ok) return null;
    return JSON.parse(await res.text()) as T;
  } catch {
    return null;
  }
}

/**
 * The exact totals GitHub shows in the PR header, for PRs whose file list is
 * capped. `base` is the PR's URL (`/owner/repo/pull/123` in the page).
 */
export async function fetchPrTotals(
  base: string,
  init: RequestInit = { credentials: 'same-origin' },
): Promise<Partial<PrTotals>> {
  const [diffstat, counts] = await Promise.all([
    fetchJson<{ diffstat?: { linesAdded?: number; linesDeleted?: number } }>(`${base}/page_data/diffstat`, init),
    fetchJson<{ filesChangedCount?: number }>(`${base}/page_data/tab_counts`, init),
  ]);
  const totals: Partial<PrTotals> = {};
  if (diffstat?.diffstat) {
    totals.additions = diffstat.diffstat.linesAdded ?? 0;
    totals.deletions = diffstat.diffstat.linesDeleted ?? 0;
  }
  if (typeof counts?.filesChangedCount === 'number') totals.files = counts.filesChangedCount;
  return totals;
}
