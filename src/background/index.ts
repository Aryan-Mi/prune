import { ext } from '../shared/browser.ts';
import { parseFileTree, type PrFileList } from '../shared/filetree.ts';
import type { Lookup, Message } from '../shared/messages.ts';
import { parseRules } from '../shared/matcher.ts';
import { computePrune, type PruneResult } from '../shared/prune.ts';
import { compileRules } from '../shared/rules.ts';
import {
  loadRemoteCache,
  loadSettings,
  onConfigChanged,
  REMOTE_KEY,
  REMOTE_TTL_MS,
  type RemoteCache,
} from '../shared/settings.ts';
import {
  cachePartition,
  loadFileList,
  saveFileList,
  saveRepoConfig,
  storedEtag,
  storedRepoConfig,
} from './cache.ts';
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
 * skip fetching or sending it.
 */
async function lookup(msg: Extract<Message, { type: 'lookup' }>, sender: browser.runtime.MessageSender): Promise<Lookup> {
  const partition = cachePartition(sender);
  const [inactive, settings, etag, repo] = await Promise.all([
    openTab(sender.tab?.id),
    loadSettings(),
    partition === null ? null : storedEtag(partition + msg.key),
    partition === null ? null : storedRepoConfig(partition + msg.repoKey),
  ]);
  return { settings, inactive, etag, repo: settings.useRepoConfig ? repo : { path: null, text: null } };
}

/**
 * Parses and prunes a PR's file list for a content script. This is the bulk
 * of PRune's work on a big PR (a 700 KB response with 3000 files), and doing
 * it here keeps it off the GitHub page's main thread and out of its memory:
 * the page only gets the pruned files back. Replies null when asked to use a
 * stored list that is gone by now; the content script then sends it.
 */
async function prune(msg: Extract<Message, { type: 'prune' }>, partition: string | null): Promise<PruneResult | null> {
  const key = partition === null ? null : partition + msg.key;
  let files: PrFileList | null;
  if (msg.fileTree === null) {
    files = key !== null && msg.etag ? await loadFileList(key, msg.etag) : null;
    if (!files) return null;
  } else {
    files = parseFileTree(msg.fileTree);
    if (key !== null && msg.etag) saveFileList(key, msg.etag, files).catch(() => {});
  }
  if (partition !== null && msg.repoFetched) saveRepoConfig(partition + msg.repoKey, msg.repo).catch(() => {});
  const [settings, remote] = await Promise.all([loadSettings(), loadRemoteCache()]);
  if (settings.remoteUrl && (remote?.url !== settings.remoteUrl || Date.now() - remote.fetchedAt > REMOTE_TTL_MS)) {
    // Content scripts reload when the new copy lands in storage.
    refreshOnce().catch(() => {});
  }
  const rules = compileRules(settings, {
    repoText: msg.repo.text,
    repoPath: msg.repo.path,
    remoteText: remote?.url === settings.remoteUrl ? remote.text : null,
  });
  return computePrune(files, msg.totals, rules, settings);
}

// Respond via sendResponse + `return true`: works in Firefox and in every
// Chromium version (returning a Promise is not supported everywhere).
ext.runtime.onMessage.addListener((msg: Message, sender, sendResponse: (value: unknown) => void) => {
  let task: Promise<unknown> | undefined;
  if (msg.type === 'open-options') task = ext.runtime.openOptionsPage();
  else if (msg.type === 'refresh-remote') task = refreshOnce(msg.force);
  else if (msg.type === 'lookup') task = lookup(msg, sender);
  else if (msg.type === 'prune') task = prune(msg, cachePartition(sender));
  else if (msg.type === 'set-inactive') task = setInactive(sender.tab?.id, msg.keys);
  if (!task) return undefined;
  task.then(
    (value) => sendResponse(value ?? null),
    (err: unknown) => sendResponse({ error: String(err) }),
  );
  return true;
});

// Content scripts don't read settings themselves (see tabs.ts).
onConfigChanged((remoteChanged) => {
  loadSettings()
    .then((settings) => notifyTabs({ type: 'config-changed', settings, remoteChanged }))
    .catch(() => {});
});

ext.runtime.onStartup.addListener(() => {
  refreshOnce().catch(() => {});
});

ext.runtime.onInstalled.addListener(() => {
  refreshOnce().catch(() => {});
});
