import type { PrTotals } from './filetree.ts';
import type { PageSettings } from './settings.ts';

/**
 * Chromium build: the DOM event that carries messages to the content script,
 * which runs in the page's own JS world there (see shared/tabs.ts).
 */
export const PAGE_EVENT = 'prune-extension-message';

/** A repository's `.pruneignore`, as found on its default branch. */
export interface RepoConfig {
  path: string | null;
  text: string | null;
}

export type Message =
  | { type: 'open-options' }
  | { type: 'refresh-remote'; force?: boolean }
  | { type: 'get-status' }
  | { type: 'set-active'; active: boolean }
  /**
   * Background → content scripts that opened a PR: settings or the remote
   * rules changed. They `lookup` the PR again for the new settings.
   */
  | { type: 'config-changed' }
  /** Content → background: the PRs switched off in this tab. */
  | { type: 'set-inactive'; keys: string[] }
  /**
   * Content → background, as soon as a PR page opens: what the background
   * already has for this PR (see background/cache.ts). Also wakes it up.
   */
  | { type: 'lookup'; key: string; repoKey: string }
  /**
   * Content → background: prune a PR's file_tree response (see shared/prune.ts).
   * `fileTree` is null when the response has the ETag of the list the
   * background script has a result for (`Lookup.etag`); if that result is
   * gone by now or for other rules, it replies null and the content script
   * sends the list.
   */
  | {
      type: 'prune';
      key: string;
      repoKey: string;
      fileTree: string | null;
      etag: string | null;
      repo: RepoConfig;
      /** `repo` was just fetched (not handed out by `lookup`), so it's worth keeping. */
      repoFetched: boolean;
    };

/** Reply to `lookup`. */
export interface Lookup {
  /** `disabledRepos` lists at most the PR's own repository: pages don't learn about others. */
  settings: PageSettings;
  /** PRs switched off in this tab. */
  inactive: string[];
  /** ETag of the file list the stored result is for, to revalidate with. */
  etag: string | null;
  /** That list was capped, so GitHub's totals will be needed as well. */
  capped: boolean;
  /** The repository's recently fetched `.pruneignore`; null if it should be fetched. */
  repo: RepoConfig | null;
}

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
