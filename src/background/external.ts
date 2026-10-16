import type { PrTotals } from '../shared/filetree.ts';
import type { Message, RepoConfig } from '../shared/messages.ts';

/**
 * Security model of the Chromium build. Its content scripts run in the GitHub
 * page's own JS world (world.d.ts) and message this script the way a web
 * page can (`externally_connectable` in the manifest). So whatever a
 * github.com page runs can send the same messages, and they are answered as
 * the page's:
 *
 * - Only from a tab's top-level github.com document (the manifest lets no
 *   other site, nor any other extension, connect).
 * - Only the messages a PR page sends, checked to be well formed and of
 *   sane size. Nothing that changes settings or rules, refreshes the remote
 *   rules file or reads a tab's state other than the sender's own.
 * - Settings are only shared as far as the PR asked about needs them
 *   (`lookup` in index.ts): whether PRune is on there and how it shows pruned
 *   files, not the other repositories it's switched off for. Pruning a list
 *   tells which of its files the user's rules match, as the pill's popover on
 *   the page does anyway.
 * - What a page can change: which PRs are switched off in its own tab, and
 *   the results and `.pruneignore` copies stored for its cookie partition.
 *   Those only decide what PRune shows on github.com, where the page's
 *   scripts decide what is shown anyway.
 */

export const PAGE_ORIGIN = 'https://github.com';

const MAX_KEY = 300;
/** GitHub's file list is ~250 bytes per file and capped at 3000 files. */
const MAX_FILE_TREE = 16 * 1024 * 1024;
const MAX_REPO_CONFIG = 512 * 1024;
const MAX_INACTIVE = 1000;

const REPO_KEY = /^[^\s/#]+\/[^\s/#]+$/;
const PR_KEY = /^([^\s/#]+\/[^\s/#]+)#\d+$/;

const isString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isNullableString = (v: unknown, max: number): v is string | null => v === null || isString(v, max);
const isPrKey = (v: unknown): v is string => isString(v, MAX_KEY) && PR_KEY.test(v);

/** The sender is a tab's top-level github.com document. */
export function isPageSender(sender: browser.runtime.MessageSender & { origin?: string }): boolean {
  let origin = sender.origin;
  try {
    origin ??= new URL(sender.url ?? '').origin;
  } catch {
    return false;
  }
  return origin === PAGE_ORIGIN && sender.tab?.id !== undefined && sender.frameId === 0 && sender.id === undefined;
}

/** `msg` from a page, rebuilt from its checked fields; null if it isn't one a PR page sends. */
export function pageMessage(msg: unknown): Message | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'open-options':
      return { type: 'open-options' };
    case 'set-inactive':
      return Array.isArray(m.keys) && m.keys.length <= MAX_INACTIVE && m.keys.every(isPrKey)
        ? { type: 'set-inactive', keys: [...(m.keys as string[])] }
        : null;
    case 'lookup':
      return isPr(m.key, m.repoKey) && typeof m.files === 'boolean'
        ? { type: 'lookup', key: m.key, repoKey: m.repoKey as string, files: m.files }
        : null;
    case 'prune': {
      const repo = m.repo as Partial<RepoConfig> | null;
      const totals = m.totals === null ? null : pageTotals(m.totals);
      if (
        totals === undefined ||
        typeof m.files !== 'boolean' ||
        !isPr(m.key, m.repoKey) ||
        !isNullableString(m.fileTree, MAX_FILE_TREE) ||
        !isNullableString(m.etag, MAX_KEY) ||
        typeof m.repoFetched !== 'boolean' ||
        !repo ||
        typeof repo !== 'object' ||
        !isNullableString(repo.path, MAX_KEY) ||
        !isNullableString(repo.text, MAX_REPO_CONFIG)
      ) {
        return null;
      }
      return {
        type: 'prune',
        key: m.key,
        repoKey: m.repoKey as string,
        fileTree: m.fileTree,
        etag: m.etag,
        repo: { path: repo.path, text: repo.text },
        repoFetched: m.repoFetched,
        totals,
        files: m.files,
      };
    }
    default:
      return null;
  }
}

/** GitHub's totals as a page passes them on (any of them may be missing); undefined if malformed. */
function pageTotals(value: unknown): Partial<PrTotals> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const totals: Partial<PrTotals> = {};
  for (const name of ['additions', 'deletions', 'files'] as const) {
    const n = v[name];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return undefined;
    totals[name] = n;
  }
  return totals;
}

/** `key` is a PR of `repoKey` (`owner/repo#123`, as content/github.ts makes them). */
function isPr(key: unknown, repoKey: unknown): key is string {
  return isPrKey(key) && isString(repoKey, MAX_KEY) && REPO_KEY.test(repoKey) && PR_KEY.exec(key)![1] === repoKey;
}
