import type { PrTotals } from '../content/github.ts';

export type Message =
  | { type: 'open-options' }
  | { type: 'refresh-remote'; force?: boolean }
  | { type: 'get-status' }
  | { type: 'set-active'; active: boolean };

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
