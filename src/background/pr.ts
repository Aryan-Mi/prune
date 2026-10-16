import { parseFileTree } from '../shared/filetree.ts';
import type { Lookup, Message, RepoConfig } from '../shared/messages.ts';
import { computePrune, type PruneResult } from '../shared/prune.ts';
import { compileRules } from '../shared/rules.ts';
import { loadRemoteCache, loadSettings, pageSettings, REMOTE_TTL_MS, rulesKey, type Settings } from '../shared/settings.ts';
import { hasAllTotals, LIST_CAP } from '../shared/totals.ts';
import { cachePartition, loadResult, rulesFingerprint, saveRepoConfig, saveResult, stored, storedRepoConfig } from './cache.ts';
import { refreshOnce } from './remote.ts';
import { openTab } from './tabs.ts';

const NO_REPO_CONFIG: RepoConfig = { path: null, text: null };

/** The remote rules file's text for `settings`; has it fetched again (for next time) if it's stale. */
async function remoteRules(settings: Settings): Promise<string | null> {
  const remote = await loadRemoteCache();
  if (settings.remoteUrl && (remote?.url !== settings.remoteUrl || Date.now() - remote.fetchedAt > REMOTE_TTL_MS)) {
    // Content scripts reload when the new copy lands in storage.
    refreshOnce().catch(() => {});
  }
  return remote?.url === settings.remoteUrl ? remote.text : null;
}

/**
 * Everything a PR page needs before GitHub has answered: settings, the tab's
 * switched-off PRs, and what's stored for this PR. That is the result itself
 * when it's for the current rules, so a PR whose file list hasn't changed
 * since the last visit takes the page this one message (see cache.ts).
 */
export async function lookup(
  msg: Extract<Message, { type: 'lookup' }>,
  sender: browser.runtime.MessageSender,
): Promise<Lookup> {
  const partition = cachePartition(sender);
  const [inactive, settings, entry, repoConfig] = await Promise.all([
    openTab(sender.tab?.id),
    loadSettings(),
    partition === null ? null : stored(partition + msg.key),
    partition === null ? null : storedRepoConfig(partition + msg.repoKey),
  ]);
  const repo = settings.useRepoConfig ? repoConfig : NO_REPO_CONFIG;
  let result: PruneResult | null = null;
  // Without the repository's rules (not fetched lately), the page fetches them and asks with `prune`.
  if (partition !== null && entry && repo) {
    const rules = await rulesFingerprint(rulesKey(settings), repo, await remoteRules(settings));
    result = await loadResult(partition + msg.key, entry.etag, rules);
  }
  return { settings: pageSettings(settings), inactive, etag: entry?.etag ?? null, repo, result };
}

/**
 * Parses and prunes a PR's file list for a content script. This is the bulk
 * of PRune's work on a big PR (a 700 KB response with 3000 files), and doing
 * it here keeps it off the GitHub page's main thread and out of its memory:
 * the page only gets the pruned files back. A stored result for the same
 * list and rules is reused as is. Replies null when asked for a stored
 * result that is gone by now or for other rules; the content script then
 * sends the list.
 */
export async function prune(msg: Extract<Message, { type: 'prune' }>, partition: string | null): Promise<PruneResult | null> {
  const key = partition === null ? null : partition + msg.key;
  if (partition !== null && msg.repoFetched) saveRepoConfig(partition + msg.repoKey, msg.repo).catch(() => {});
  const settings = await loadSettings();
  const remoteText = await remoteRules(settings);
  const rules = key === null ? '' : await rulesFingerprint(rulesKey(settings), msg.repo, remoteText);
  if (msg.fileTree === null) return key !== null && msg.etag ? loadResult(key, msg.etag, rules) : null;

  const compiled = compileRules(settings, { repoText: msg.repo.text, repoPath: msg.repo.path, remoteText });
  const files = parseFileTree(msg.fileTree);
  // Below the cap, the list's own sums are exact (see totals.ts).
  const capped = files.length >= LIST_CAP;
  const result = computePrune(files, (capped && msg.totals) || {}, compiled, settings);
  // A capped list's result is only kept with GitHub's totals, so that a stored
  // result needs nothing else from GitHub. The list's ETag covers them: the
  // response names the PR's commits and base, which decide the totals.
  if (key !== null && msg.etag && (!capped || hasAllTotals(msg.totals))) {
    saveResult(key, msg.etag, rules, result).catch(() => {});
  }
  return result;
}
