import type { CompiledRules } from '../shared/rules.ts';
import type { Settings } from '../shared/settings.ts';
import type { PrFile, PrTotals } from './github.ts';

export interface PrunedFile extends PrFile {
  /** The pattern that matched, or "linguist-generated". */
  rule: string;
  /** Where the rule came from, e.g. "Built-in · Lockfiles". */
  source: string;
}

export interface PruneResult {
  /** Every file in the PR (up to GitHub's 3000-file cap), in GitHub's order. */
  files: PrFile[];
  pruned: PrunedFile[];
  prunedDigests: Set<string>;
  /** Totals as GitHub reports them. */
  original: PrTotals;
  /** Totals after pruning. */
  kept: PrTotals;
  /** Totals of the pruned files alone. */
  removed: PrTotals;
}

export function computePrune(
  files: PrFile[],
  githubTotals: Partial<PrTotals>,
  compiled: CompiledRules,
  settings: Settings,
): PruneResult {
  const pruned: PrunedFile[] = [];
  const removed: PrTotals = { additions: 0, deletions: 0, files: 0 };
  const sum: PrTotals = { additions: 0, deletions: 0, files: files.length };

  for (const file of files) {
    sum.additions += file.additions;
    sum.deletions += file.deletions;
    const rule = compiled.matcher.match(file.path);
    let hit: PrunedFile | null = null;
    if (rule) {
      hit = { ...file, rule: rule.pattern, source: rule.source };
    } else if (
      settings.respectLinguistGenerated &&
      file.generated &&
      !compiled.matcher.isExplicitlyKept(file.path)
    ) {
      hit = { ...file, rule: 'linguist-generated', source: '.gitattributes' };
    }
    if (hit) {
      pruned.push(hit);
      removed.additions += file.additions;
      removed.deletions += file.deletions;
      removed.files += 1;
    }
  }

  const original: PrTotals = {
    additions: githubTotals.additions ?? sum.additions,
    deletions: githubTotals.deletions ?? sum.deletions,
    files: githubTotals.files ?? sum.files,
  };
  const kept: PrTotals = {
    additions: Math.max(0, original.additions - removed.additions),
    deletions: Math.max(0, original.deletions - removed.deletions),
    files: Math.max(0, original.files - removed.files),
  };

  return {
    files,
    pruned,
    prunedDigests: new Set(pruned.map((f) => f.digest)),
    original,
    kept,
    removed,
  };
}
