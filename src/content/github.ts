import { REPO_CONFIG_PATHS } from '../shared/defaults.ts';

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

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/([^/]+)(\/[^/]+)?)?/;

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

/** One changed file, as reported by GitHub's own `page_data/file_tree` endpoint. */
export interface PrFile {
  path: string;
  /** sha256(path) hex. GitHub uses `diff-<digest>` as the DOM id/anchor of each file diff. */
  digest: string;
  additions: number;
  deletions: number;
  /** GitHub's change type, e.g. ADDED, MODIFIED, DELETED, RENAMED. */
  status: string;
  /** Marked `linguist-generated` via .gitattributes. */
  generated: boolean;
}

export interface PrFiles {
  files: PrFile[];
  baseOid: string | null;
}

interface RawDiff {
  path?: string;
  pathDigest?: string;
  linesAdded?: number;
  linesDeleted?: number;
  changeType?: string;
  isGenerated?: boolean;
}

const JSON_HEADERS = {
  Accept: 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
};

/**
 * Same-origin request to the JSON endpoint GitHub's PR UI uses for its file
 * tree. Runs with the user's session, so private repositories work, and it is
 * far cheaper than downloading the diff (no file contents, ~250 bytes/file).
 * GitHub caps the list at 3000 files, the same limit as its UI and API.
 */
export async function fetchPrFiles(pr: PrRef, signal?: AbortSignal): Promise<PrFiles> {
  const res = await fetch(`${pr.basePath}/page_data/file_tree`, {
    headers: JSON_HEADERS,
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) throw new Error(`file_tree request failed: HTTP ${res.status}`);
  const data = JSON.parse(await res.text()) as { diffs?: RawDiff[]; baseRefOid?: string };
  const files: PrFile[] = [];
  for (const d of data.diffs ?? []) {
    if (!d.path || !d.pathDigest) continue;
    files.push({
      path: d.path,
      digest: d.pathDigest,
      additions: d.linesAdded ?? 0,
      deletions: d.linesDeleted ?? 0,
      status: (d.changeType ?? '').replace('CHANGE_TYPE_', ''),
      generated: d.isGenerated === true,
    });
  }
  return { files, baseOid: data.baseRefOid ?? null };
}

export interface RepoConfig {
  path: string | null;
  text: string | null;
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

export interface PrTotals {
  additions: number;
  deletions: number;
  files: number;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: JSON_HEADERS, credentials: 'same-origin', signal });
    if (!res.ok) return null;
    return JSON.parse(await res.text()) as T;
  } catch {
    return null;
  }
}

/**
 * The exact totals GitHub shows in the PR header. These are fetched separately
 * because the file list is capped at 3000 entries; for huge PRs the header
 * totals cannot be derived from the list.
 */
export async function fetchPrTotals(pr: PrRef, signal?: AbortSignal): Promise<Partial<PrTotals>> {
  const [diffstat, counts] = await Promise.all([
    fetchJson<{ diffstat?: { linesAdded?: number; linesDeleted?: number } }>(
      `${pr.basePath}/page_data/diffstat`,
      signal,
    ),
    fetchJson<{ filesChangedCount?: number }>(`${pr.basePath}/page_data/tab_counts`, signal),
  ]);
  const totals: Partial<PrTotals> = {};
  if (diffstat?.diffstat) {
    totals.additions = diffstat.diffstat.linesAdded ?? 0;
    totals.deletions = diffstat.diffstat.linesDeleted ?? 0;
  }
  if (typeof counts?.filesChangedCount === 'number') totals.files = counts.filesChangedCount;
  return totals;
}
