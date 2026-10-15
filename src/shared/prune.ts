import { keptTotals } from './endpoints.ts';
import { parseFileTree, type PrFile, type PrFileList, type PrTotals } from './filetree.ts';
import { compileRules, type CompiledRules, type RuleInputs } from './rules.ts';
import type { Settings } from './settings.ts';

export interface PrunedFile extends PrFile {
  /** The pattern that matched, or "linguist-generated". */
  rule: string;
  /** Where the rule came from, e.g. "Built-in · Lockfiles". */
  source: string;
}

/**
 * Everything the content script needs about a PR, computed in the background
 * script and sent over as plain data. It holds the pruned files only, never
 * the whole file list.
 */
export interface PruneResult {
  /** How many files GitHub listed (it stops at 3000, see isCapped()). */
  listed: number;
  pruned: PrunedFile[];
  /** Directories that contain only pruned files. */
  prunedDirs: string[];
  /**
   * Totals as GitHub reports them. The listed files' sums are the same
   * numbers unless the list is capped (see applyTotals()).
   */
  original: PrTotals;
  /** Totals after pruning. */
  kept: PrTotals;
  /** Totals of the pruned files alone. */
  removed: PrTotals;
  /** Active rule sources, in precedence order. */
  sources: string[];
  /** Digests of the first and last few files, to find the diff list on the page. */
  probes: string[];
  /** Path of the first file, to find the new UI's file tree (its rows have the path as id). */
  firstPath: string | null;
}

/** How many digests from each end of the list go into `probes`. */
const PROBES = 16;

/** Parses GitHub's file_tree response and prunes it. Runs in the background script. */
export function prunePr(
  fileTree: string,
  githubTotals: Partial<PrTotals>,
  settings: Settings,
  inputs: RuleInputs,
): PruneResult {
  return computePrune(parseFileTree(fileTree), githubTotals, compileRules(settings, inputs), settings);
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
  const kept = keptTotals(original, removed);

  const probes: string[] = [];
  for (let i = 0; i < files.length; i++) {
    if (i === PROBES) i = Math.max(i, files.length - PROBES);
    probes.push(files.digest(i));
  }

  return {
    listed: files.length,
    pruned,
    prunedDirs: pruned.length > 0 ? fullyPrunedDirs(files, isPruned) : [],
    original,
    kept,
    removed,
    sources: compiled.sources,
    probes,
    firstPath: files.length > 0 ? files.path(0) : null,
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
