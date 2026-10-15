import { ext } from '../shared/browser.ts';
import type { Message } from '../shared/messages.ts';
import { parseRules } from '../shared/matcher.ts';
import { prunePr, type PruneResult } from '../shared/prune.ts';
import { loadRemoteCache, loadSettings, REMOTE_KEY, REMOTE_TTL_MS, type RemoteCache } from '../shared/settings.ts';

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
 * Parses and prunes a PR's file list for a content script. This is the bulk
 * of PRune's work on a big PR (a 700 KB response with 3000 files), and doing
 * it here keeps it off the GitHub page's main thread and out of its memory:
 * the page only gets the pruned files back.
 */
async function prune(msg: Extract<Message, { type: 'prune' }>): Promise<PruneResult> {
  const [settings, remote] = await Promise.all([loadSettings(), loadRemoteCache()]);
  if (settings.remoteUrl && (remote?.url !== settings.remoteUrl || Date.now() - remote.fetchedAt > REMOTE_TTL_MS)) {
    // Content scripts reload when the new copy lands in storage.
    refreshOnce().catch(() => {});
  }
  return prunePr(msg.fileTree, msg.totals, settings, {
    repoText: msg.repoText,
    repoPath: msg.repoPath,
    remoteText: remote?.url === settings.remoteUrl ? remote.text : null,
  });
}

// Respond via sendResponse + `return true`: works in Firefox and in every
// Chromium version (returning a Promise is not supported everywhere).
ext.runtime.onMessage.addListener((msg: Message, _sender, sendResponse: (value: unknown) => void) => {
  let task: Promise<unknown> | undefined;
  if (msg.type === 'open-options') task = ext.runtime.openOptionsPage();
  else if (msg.type === 'refresh-remote') task = refreshOnce(msg.force);
  else if (msg.type === 'prune') task = prune(msg);
  else if (msg.type === 'warm') task = Promise.resolve(null);
  if (!task) return undefined;
  task.then(
    (value) => sendResponse(value ?? null),
    (err: unknown) => sendResponse({ error: String(err) }),
  );
  return true;
});

ext.runtime.onStartup.addListener(() => {
  refreshOnce().catch(() => {});
});

ext.runtime.onInstalled.addListener(() => {
  refreshOnce().catch(() => {});
});
