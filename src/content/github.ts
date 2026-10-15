import { REPO_CONFIG_PATHS } from '../shared/defaults.ts';
import { JSON_HEADERS } from '../shared/endpoints.ts';
import { PR_PATH } from './route.ts';
import type { RepoConfig } from '../shared/messages.ts';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** `owner/repo` lowercased; used for per-repo settings. */
  repoKey: string;
  /** `owner/repo#123` lowercased; identifies the PR for caching. */
  key: string;
  /** `/owner/repo/pull/123` as it appears in the URL. */
  basePath: string;
  /** True on the "Files changed" tab (classic `/files` or new `/changes`) or a single-commit diff. */
  isDiffView: boolean;
  /** True on the "Files changed" tab only (the whole PR's diff). */
  isFilesTab: boolean;
}

export function parsePrUrl(pathname: string): PrRef | null {
  const m = PR_PATH.exec(pathname);
  if (!m) return null;
  const [, owner, repo, num, tab, sub] = m as unknown as [string, string, string, string, string?, string?];
  const repoKey = `${owner}/${repo}`.toLowerCase();
  return {
    owner,
    repo,
    number: Number(num),
    repoKey,
    key: `${repoKey}#${num}`,
    basePath: `/${owner}/${repo}/pull/${num}`,
    isDiffView: tab === 'files' || tab === 'changes' || (tab === 'commits' && sub !== undefined),
    isFilesTab: tab === 'files' || tab === 'changes',
  };
}

/**
 * Same-origin request to the JSON endpoint GitHub's PR UI uses for its file
 * tree. Runs with the user's session, so private repositories work, and it is
 * far cheaper than downloading the diff (no file contents, ~250 bytes/file).
 * GitHub caps the list at 3000 files, the same limit as its UI and API.
 *
 * The body is left unread: parsing and matching happen in the background
 * script (see shared/prune.ts), and if it already has this exact list (same
 * ETag) the body isn't needed at all.
 */
export async function fetchFileTree(pr: PrRef, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${pr.basePath}/page_data/file_tree`, {
    headers: JSON_HEADERS,
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) throw new Error(`file_tree request failed: HTTP ${res.status}`);
  return res;
}

/**
 * Looks for a `.pruneignore` in the repository at the PR's base commit.
 * `/raw/` redirects to raw.githubusercontent.com (CORS-enabled, and with a
 * short-lived token for private repos), so this also works without an API token.
 */
export async function fetchRepoConfig(pr: PrRef, ref: string, signal?: AbortSignal): Promise<RepoConfig> {
  const attempts = REPO_CONFIG_PATHS.map(async (path) => {
    const res = await fetch(`/${pr.owner}/${pr.repo}/raw/${encodeURIComponent(ref)}/${path}`, {
      credentials: 'same-origin',
      signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Guard against HTML error pages slipping through.
    if (/^\s*<!DOCTYPE html/i.test(text)) return null;
    return { path, text };
  });
  const results = await Promise.allSettled(attempts);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return { path: null, text: null };
}
