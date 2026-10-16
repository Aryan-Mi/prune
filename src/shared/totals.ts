/**
 * When GitHub's own totals for a PR are needed. Kept apart from prune.ts, so
 * the content script doesn't bundle the rule matcher.
 */
import type { PrTotals } from './filetree.ts';
import type { PruneResult } from './prune.ts';

/**
 * GitHub lists at most this many files (in its UI and API alike). Below it,
 * the listed files' sums are exactly the totals in the PR header (checked on
 * PRs with renames, deletions, binary files and submodules), so GitHub's
 * separate totals endpoints are only needed for longer lists.
 */
export const LIST_CAP = 3000;

/** Whether GitHub may have left files out of the list, so that its own totals are needed. */
export function isCapped(result: Pick<PruneResult, 'listed'>): boolean {
  return result.listed >= LIST_CAP;
}

/** Whether `totals` holds all of GitHub's numbers. */
export function hasAllTotals(totals: Partial<PrTotals> | null | undefined): totals is PrTotals {
  return totals?.additions !== undefined && totals.deletions !== undefined && totals.files !== undefined;
}

export function keptTotals(original: PrTotals, removed: PrTotals): PrTotals {
  return {
    additions: Math.max(0, original.additions - removed.additions),
    deletions: Math.max(0, original.deletions - removed.deletions),
    files: Math.max(0, original.files - removed.files),
  };
}
