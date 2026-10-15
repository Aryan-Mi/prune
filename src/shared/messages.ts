import type { PrTotals } from './filetree.ts';

export type Message =
  | { type: 'open-options' }
  | { type: 'refresh-remote'; force?: boolean }
  | { type: 'get-status' }
  | { type: 'set-active'; active: boolean }
  /** Content → background: prune a PR's file_tree response (see shared/prune.ts). */
  | { type: 'prune'; fileTree: string; totals: Partial<PrTotals>; repoText: string | null; repoPath: string | null }
  /** Content → background: wakes the background script up ahead of a `prune`. */
  | { type: 'warm' };

/** Reply to `get-status`, sent from the content script to the popup. */
export interface TabStatus {
  pr: string | null;
  repo: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'disabled';
  error?: string;
  active: boolean;
  pruned: number;
  original?: PrTotals;
  kept?: PrTotals;
  sources: string[];
  repoConfigPath: string | null;
}
