import type { CompiledRules } from '../shared/rules.ts';
import type { Settings } from '../shared/settings.ts';
import type { PrFile, PrFileList, PrTotals } from './github.ts';

export interface PrunedFile extends PrFile {
  /** The pattern that matched, or "linguist-generated". */
  rule: string;
  /** Where the rule came from, e.g. "Built-in · Lockfiles". */
  source: string;
}

export interface PruneResult {
  /** How many files GitHub listed (it stops at 3000). */
  listed: number;
  pruned: PrunedFile[];
  prunedDigests: Set<string>;
  /** Directories that contain only pruned files. */
  prunedDirs: string[];
  /** Totals as GitHub reports them. */
  original: PrTotals;
  /** Totals after pruning. */
  kept: PrTotals;
  /** Totals of the pruned files alone. */
  removed: PrTotals;
}

export function computePrune(
  files: PrFileList,
  githubTotals: Partial<PrTotals>,
  compiled: CompiledRules,
  settings: Settings,
): PruneResult {
  const pruned: PrunedFile[] = [];
  const isPruned = new Uint8Array(files.length);
  const removed: PrTotals = { additions: 0, deletions: 0, files: 0 };
  const sum: PrTotals = { additions: 0, deletions: 0, files: files.length };

  for (let i = 0; i < files.length; i++) {
    const path = files.path(i);
    const additions = files.additions(i);
    const deletions = files.deletions(i);
    sum.additions += additions;
    sum.deletions += deletions;
    const rule = compiled.matcher.match(path);
    let hit: PrunedFile | null = null;
    if (rule) {
      hit = { ...files.get(i), rule: rule.pattern, source: rule.source };
    } else if (
      settings.respectLinguistGenerated &&
      files.isGenerated(i) &&
      !compiled.matcher.isExplicitlyKept(path)
    ) {
      hit = { ...files.get(i), rule: 'linguist-generated', source: '.gitattributes' };
    }
    if (hit) {
      pruned.push(hit);
      isPruned[i] = 1;
      removed.additions += additions;
      removed.deletions += deletions;
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
    listed: files.length,
    pruned,
    prunedDigests: new Set(pruned.map((f) => f.digest)),
    prunedDirs: pruned.length > 0 ? fullyPrunedDirs(files, isPruned) : [],
    original,
    kept,
    removed,
  };
}

function fullyPrunedDirs(files: PrFileList, isPruned: Uint8Array): string[] {
  const keptDirs = new Set<string>();
  const prunedDirs = new Set<string>();
  for (let f = 0; f < files.length; f++) {
    const target = isPruned[f] ? prunedDirs : keptDirs;
    const path = files.path(f);
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const dir = path.slice(0, i);
      // Its parents were added along with it.
      if (target.has(dir)) break;
      target.add(dir);
    }
  }
  return [...prunedDirs].filter((d) => !keptDirs.has(d));
}
