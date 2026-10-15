import { ext } from '../shared/browser.ts';
import { applyTotals, isCapped } from '../shared/endpoints.ts';
import { parseFileTree, type PrFileList } from '../shared/filetree.ts';
import type { Lookup, Message } from '../shared/messages.ts';
import { parseRules } from '../shared/matcher.ts';
import { computePrune, type PruneResult } from '../shared/prune.ts';
import { compileRules } from '../shared/rules.ts';
import {
  loadRemoteCache,
  loadSettings,
  onConfigChanged,
  pageSettings,
  REMOTE_KEY,
  REMOTE_TTL_MS,
  rulesKey,
  type RemoteCache,
} from '../shared/settings.ts';
import {
  cachePartition,
  loadResult,
  rulesFingerprint,
  saveRepoConfig,
  saveResult,
  stored,
  storedRepoConfig,
} from './cache.ts';
import { fetchesFor, fetchFileList, fetchTotals, prefetch, takePrefetched } from './fetch.ts';
import { notifyTabs, openTab, setInactive } from './tabs.ts';

/** Rules files larger than this are rejected; real ones are a few KB. */
const MAX_REMOTE_BYTES = 512 * 1024;

let inflight: Promise<RemoteCache | null> | null = null;

/**
 * Downloads the user's remote rules file (e.g. a .pruneignore kept in a
 * dotfiles repo or gist) and caches it in storage, where content scripts pick
 * it up. Runs in the background so it can use the extension's host permissions.
 */
async function refreshRemote(force = false): Promise<RemoteCache | null> {
  const { remoteUrl } = await loadSettings();
  if (!remoteUrl) {
    await ext.storage.local.remove(REMOTE_KEY);
    return null;
  }
  const cached = await loadRemoteCache();
  if (!force && cached?.url === remoteUrl && !cached.error && Date.now() - cached.fetchedAt < REMOTE_TTL_MS) {
    return cached;
  }
  let next: RemoteCache;
  try {
    const res = await fetch(remoteUrl, { cache: 'no-cache', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_REMOTE_BYTES) throw new Error('File is larger than 512 KB');
    if (/^\s*<(?:!doctype|html)/i.test(text)) throw new Error('URL returned an HTML page, not a plain-text rules file');
    const { errors } = parseRules(text, 'Remote rules file');
    next = {
      url: remoteUrl,
      text,
      fetchedAt: Date.now(),
      ...(errors.length ? { error: `${errors.length} invalid line(s)` } : {}),
    };
  } catch (err) {
    // Keep serving the last good copy of the same URL if the refresh failed.
    next = {
      url: remoteUrl,
      text: cached?.url === remoteUrl ? cached.text : '',
      fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  await ext.storage.local.set({ [REMOTE_KEY]: next });
  return next;
}

function refreshOnce(force = false): Promise<RemoteCache | null> {
  inflight ??= refreshRemote(force).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Everything a PR page needs before GitHub has answered: settings, the tab's
 * switched-off PRs, and what's stored for this PR so the content script can
 * skip fetching or sending it. In Chromium, starts fetching the PR's file list
 * here for the `prune` message that follows (see fetch.ts).
 */
async function lookup(msg: Extract<Message, { type: 'lookup' }>, sender: browser.runtime.MessageSender): Promise<Lookup> {
  const partition = cachePartition(sender);
  const entry = partition === null ? null : await stored(partition + msg.key);
  const fetches = fetchesFor(sender);
  if (fetches) prefetch(fetchId(sender, msg.key), msg.basePath, entry?.etag ?? null, entry?.capped ?? false);
  const [inactive, settings, repo] = await Promise.all([
    openTab(sender.tab?.id),
    loadSettings(),
    partition === null ? null : storedRepoConfig(partition + msg.repoKey),
  ]);
  return {
    settings: pageSettings(settings),
    inactive,
    etag: fetches ? null : (entry?.etag ?? null),
    capped: !fetches && !!entry?.capped,
    repo: settings.useRepoConfig ? repo : { path: null, text: null },
    fetches,
  };
}

const fetchId = (sender: browser.runtime.MessageSender, key: string) => `${sender.tab?.id}|${key}`;

/**
 * Prunes a PR's file list for a content script. This is the bulk of PRune's
 * work on a big PR (a 700 KB response with 3000 files), and doing it here
 * keeps it off the GitHub page's main thread and out of its memory: the page
 * only gets the pruned files back. A stored result for the same list and
 * rules is reused as is. Replies null when the list isn't here after all (a
 * stored result is gone or for other rules, or fetching it failed); the
 * content script then sends it.
 */
async function prune(msg: Extract<Message, { type: 'prune' }>, sender: browser.runtime.MessageSender): Promise<PruneResult | null> {
  const partition = cachePartition(sender);
  const key = partition === null ? null : partition + msg.key;
  const fetches = msg.fileTree === null && msg.etag === null;
  if (fetches && !fetchesFor(sender)) return null;
  const prefetched = fetches ? takePrefetched(fetchId(sender, msg.key)) : null;
  if (partition !== null && msg.repoFetched) saveRepoConfig(partition + msg.repoKey, msg.repo).catch(() => {});
  const [settings, remote] = await Promise.all([loadSettings(), loadRemoteCache()]);
  if (settings.remoteUrl && (remote?.url !== settings.remoteUrl || Date.now() - remote.fetchedAt > REMOTE_TTL_MS)) {
    // Content scripts reload when the new copy lands in storage.
    refreshOnce().catch(() => {});
  }
  const remoteText = remote?.url === settings.remoteUrl ? remote.text : null;
  const rules = key === null ? '' : await rulesFingerprint(rulesKey(settings), msg.repo, remoteText);

  let result: PruneResult | null = null;
  let files: PrFileList | null = null;
  let etag = msg.etag;
  if (msg.fileTree !== null) {
    files = parseFileTree(msg.fileTree);
  } else if (!fetches) {
    if (key === null || etag === null) return null;
    result = await loadResult(key, etag, rules);
    if (!result) return null;
  } else {
    let list = await (prefetched?.list ?? fetchFileList(msg.basePath, key === null ? null : ((await stored(key))?.etag ?? null)));
    if (list && !list.files) {
      // Not modified: the stored result, unless the rules changed since. Then the list after all.
      result = key === null ? null : await loadResult(key, list.etag ?? '', rules);
      if (!result) list = await fetchFileList(msg.basePath, null);
    }
    etag = list?.etag ?? null;
    files = list?.files ?? null;
  }
  if (!result) {
    if (!files) return null;
    const compiled = compileRules(settings, { repoText: msg.repo.text, repoPath: msg.repo.path, remoteText });
    result = computePrune(files, {}, compiled, settings);
    if (key !== null && etag) saveResult(key, etag, rules, result).catch(() => {});
  }
  // In the page this is up to the content script.
  if (fetches && isCapped(result)) {
    result = applyTotals(result, await (prefetched?.totals ?? fetchTotals(msg.basePath)));
  }
  return result;
}

// Respond via sendResponse + `return true`: works in Firefox and in every
// Chromium version (returning a Promise is not supported everywhere).
ext.runtime.onMessage.addListener((msg: Message, sender, sendResponse: (value: unknown) => void) => {
  let task: Promise<unknown> | undefined;
  if (msg.type === 'open-options') task = ext.runtime.openOptionsPage();
  else if (msg.type === 'refresh-remote') task = refreshOnce(msg.force);
  else if (msg.type === 'lookup') task = lookup(msg, sender);
  else if (msg.type === 'prune') task = prune(msg, sender);
  else if (msg.type === 'set-inactive') task = setInactive(sender.tab?.id, msg.keys);
  if (!task) return undefined;
  task.then(
    (value) => sendResponse(value ?? null),
    (err: unknown) => sendResponse({ error: String(err) }),
  );
  return true;
});

// Content scripts don't read settings themselves (see tabs.ts).
onConfigChanged((rulesChanged) => {
  loadSettings()
    .then((settings) => notifyTabs({ type: 'config-changed', settings: pageSettings(settings), rulesChanged }))
    .catch(() => {});
});

ext.runtime.onStartup.addListener(() => {
  refreshOnce().catch(() => {});
});

ext.runtime.onInstalled.addListener(() => {
  refreshOnce().catch(() => {});
});
