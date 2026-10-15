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
