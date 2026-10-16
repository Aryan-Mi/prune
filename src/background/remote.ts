import { ext } from '../shared/browser.ts';
import { parseRules } from '../shared/matcher.ts';
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

export function refreshOnce(force = false): Promise<RemoteCache | null> {
  inflight ??= refreshRemote(force).finally(() => {
    inflight = null;
  });
  return inflight;
}
