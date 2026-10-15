import { ext } from '../shared/browser.ts';
import { PrFileList, type StoredFileList } from '../shared/filetree.ts';
import type { RepoConfig } from '../shared/messages.ts';

/**
 * PR file lists the background script has parsed before, kept in
 * storage.session (in memory, gone when the browser closes, and it outlives
 * the service worker / event page) along with the ETag GitHub sent.
 *
 * GitHub's ETag for the file_tree response is a hash of its body. When the
 * content script gets a response with the ETag of a stored list, the stored
 * list is exactly what GitHub sent, so a revisited PR's 700 KB response is
 * never read in the page or passed along (and the browser's HTTP cache has
 * usually saved downloading it again). A stored list is only ever used after
 * GitHub answered that same request for this tab, so access is still checked.
 */

/** Lists kept at most; the oldest are dropped first. */
const MAX_LISTS = 16;
/** Rough cap on what the lists take in storage.session (Chromium allows 10 MB in total). */
const MAX_BYTES = 4 * 1024 * 1024;
const INDEX_KEY = 'fileLists';

interface IndexEntry {
  etag: string;
  bytes: number;
  usedAt: number;
}

type Index = Record<string, IndexEntry>;

let index: Promise<Index> | null = null;
/** Index updates run one after another, so concurrent tabs don't lose each other's. */
let queue: Promise<unknown> = Promise.resolve();

function readIndex(): Promise<Index> {
  index ??= ext.storage.session
    .get(INDEX_KEY)
    .then((stored) => (stored[INDEX_KEY] as Index | undefined) ?? {})
    .catch(() => ({}));
  return index;
}

function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

const listKey = (key: string) => `fileList:${key}`;

/** The ETag of the stored list for `key`, if any. */
export async function storedEtag(key: string): Promise<string | null> {
  return (await readIndex())[key]?.etag ?? null;
}

/** The stored list for `key`, if it's the one GitHub sent with `etag`. */
export async function loadFileList(key: string, etag: string): Promise<PrFileList | null> {
  if ((await readIndex())[key]?.etag !== etag) return null;
  const stored = (await ext.storage.session.get(listKey(key)))[listKey(key)] as
    | (StoredFileList & { etag: string })
    | undefined;
  if (stored?.etag !== etag) return null;
  serially(async () => {
    const entry = (await readIndex())[key];
    if (entry) entry.usedAt = Date.now();
  }).catch(() => {});
  return PrFileList.fromStored(stored);
}

export function saveFileList(key: string, etag: string, files: PrFileList): Promise<void> {
  return serially(async () => {
    const idx = await readIndex();
    const stored = files.toStored();
    let bytes = 64 * files.length;
    for (const p of stored.paths) bytes += p.length;
    idx[key] = { etag, bytes, usedAt: Date.now() };
    const evicted: string[] = [];
    const byAge = Object.keys(idx).sort((a, b) => idx[a]!.usedAt - idx[b]!.usedAt);
    let total = byAge.reduce((sum, k) => sum + idx[k]!.bytes, 0);
    for (const k of byAge) {
      if (byAge.length - evicted.length <= MAX_LISTS && total <= MAX_BYTES) break;
      total -= idx[k]!.bytes;
      evicted.push(k);
      delete idx[k];
    }
    try {
      if (evicted.length) await ext.storage.session.remove(evicted.map(listKey));
      if (idx[key]) await ext.storage.session.set({ [listKey(key)]: { ...stored, etag }, [INDEX_KEY]: idx });
      else await ext.storage.session.set({ [INDEX_KEY]: idx });
    } catch {
      // Out of quota or storage.session unavailable: start over.
      index = Promise.resolve({});
      await ext.storage.session.clear().catch(() => {});
    }
  });
}

/** How long a repository's .pruneignore is reused before it's fetched again. */
export const REPO_CONFIG_TTL_MS = 10 * 60_000;
const REPO_CONFIGS_KEY = 'repoConfigs';

type RepoConfigs = Record<string, RepoConfig & { fetchedAt: number }>;

async function readRepoConfigs(): Promise<RepoConfigs> {
  const stored = await ext.storage.session.get(REPO_CONFIGS_KEY).catch(() => ({}) as Record<string, unknown>);
  return (stored[REPO_CONFIGS_KEY] as RepoConfigs | undefined) ?? {};
}

/** A recently fetched .pruneignore for the repository `key`, so tabs don't each fetch it. */
export async function storedRepoConfig(key: string): Promise<RepoConfig | null> {
  const entry = (await readRepoConfigs())[key];
  return entry && Date.now() - entry.fetchedAt < REPO_CONFIG_TTL_MS ? { path: entry.path, text: entry.text } : null;
}

export function saveRepoConfig(key: string, config: RepoConfig): Promise<void> {
  return serially(async () => {
    const configs = await readRepoConfigs();
    const now = Date.now();
    for (const k of Object.keys(configs)) if (now - configs[k]!.fetchedAt >= REPO_CONFIG_TTL_MS) delete configs[k];
    configs[key] = { path: config.path, text: config.text, fetchedAt: now };
    await ext.storage.session.set({ [REPO_CONFIGS_KEY]: configs }).catch(() => {});
  });
}

/**
 * Prefix for cache keys. Cached responses are only shared by tabs with the
 * same cookies: Firefox containers each get their own, private windows none.
 */
export function cachePartition(sender: browser.runtime.MessageSender): string | null {
  const tab = sender.tab;
  if (!tab || tab.incognito) return null;
  return `${tab.cookieStoreId ?? ''}|`;
}
