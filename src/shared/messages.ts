import type { PrTotals } from './filetree.ts';
import type { PageSettings } from './settings.ts';

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
  /** Background → content scripts that opened a PR: settings or the remote rules changed. */
  | { type: 'config-changed'; settings: PageSettings; rulesChanged: boolean }
  /** Content → background: the PRs switched off in this tab. */
  | { type: 'set-inactive'; keys: string[] }
  /**
   * Content → background, as soon as a PR page opens: what the background
   * already has for this PR (see background/cache.ts). Also wakes it up, and
   * in Chromium has it start fetching the file list (see background/fetch.ts).
   */
  | { type: 'lookup'; key: string; repoKey: string; basePath: string }
  /**
   * Content → background: prune a PR's file_tree response (see shared/prune.ts).
   * `fileTree` is null when the response has the ETag of the list the
   * background script has a result for (`Lookup.etag`), or when it fetches
   * the list itself (`Lookup.fetches`; then `etag` is null too). If that
   * fails, it replies null and the content script sends the list.
   */
  | {
      type: 'prune';
      key: string;
      repoKey: string;
      basePath: string;
      fileTree: string | null;
      etag: string | null;
      repo: RepoConfig;
      /** `repo` was just fetched (not handed out by `lookup`), so it's worth keeping. */
      repoFetched: boolean;
    };

/** Reply to `lookup`. */
export interface Lookup {
  settings: PageSettings;
  /** PRs switched off in this tab. */
  inactive: string[];
  /** ETag of the file list the stored result is for, to revalidate with. */
  etag: string | null;
  /** That list was capped, so GitHub's totals will be needed as well. */
  capped: boolean;
  /** The repository's recently fetched `.pruneignore`; null if it should be fetched. */
  repo: RepoConfig | null;
  /** The background script fetches the file list (and totals) itself, so the page doesn't. */
  fetches: boolean;
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
