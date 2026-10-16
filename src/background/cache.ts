import { ext } from '../shared/browser.ts';
import type { RepoConfig } from '../shared/messages.ts';
import type { PruneResult } from '../shared/prune.ts';

/**
 * Results the background script has computed before, kept in storage.session
 * (in memory, gone when the browser closes, and it outlives the service
 * worker / event page) along with the ETag GitHub sent for the file list and
 * a fingerprint of the rules they were computed with.
 *
 * GitHub's ETag for the file_tree response is a hash of its body. When a
 * response has the ETag of a stored result and the rules are unchanged, the
 * stored result is exactly what pruning the response would give, so a
 * revisited PR's 700 KB response is never read in the page, passed along or
 * parsed (and the browser's HTTP cache has usually saved downloading it
 * again). A stored result is only ever used after GitHub answered a request
 * for it with the tab's cookies, so access is still checked; before that it
 * only hides diffs in the page GitHub served for the PR (see Lookup.result).
 *
 * Only results are kept, not file lists: they hold just the pruned files, so
 * they're a fraction of the size. When the rules change, the list is sent or
 * fetched once more instead. A capped list's result includes GitHub's totals
 * for the whole PR (see background/pr.ts), so a stored result is all a page
 * needs.
 */

/** Results kept at most; the oldest are dropped first. */
const MAX_RESULTS = 32;
/**
 * Rough cap on what results take in storage.session, which lives in the
 * browser's memory for the whole session. A typical result is a few KB; one
 * pruning hundreds of vendored files is ~50 KB.
 */
const MAX_BYTES = 512 * 1024;
const INDEX_KEY = 'results';

export interface Stored {
  etag: string;
  /** Fingerprint of the rules (see rulesFingerprint()). */
  rules: string;
}

interface IndexEntry extends Stored {
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

const resultKey = (key: string) => `result:${key}`;

/** What's stored for `key`, if anything. */
export async function stored(key: string): Promise<Stored | null> {
  const entry = (await readIndex())[key];
  return entry ? { etag: entry.etag, rules: entry.rules } : null;
}

/** The stored result for `key`, if it was computed from the list GitHub sent with `etag`, with `rules`. */
export async function loadResult(key: string, etag: string, rules: string): Promise<PruneResult | null> {
  const entry = (await readIndex())[key];
  if (entry?.etag !== etag || entry.rules !== rules) return null;
  const value = (await ext.storage.session.get(resultKey(key)))[resultKey(key)] as
    | { etag: string; rules: string; result: PruneResult }
    | undefined;
  if (value?.etag !== etag || value.rules !== rules) return null;
  serially(async () => {
    const current = (await readIndex())[key];
    if (current) current.usedAt = Date.now();
  }).catch(() => {});
  return value.result;
}

export function saveResult(key: string, etag: string, rules: string, result: PruneResult): Promise<void> {
  return serially(async () => {
    const idx = await readIndex();
    idx[key] = { etag, rules, bytes: resultBytes(result), usedAt: Date.now() };
    const evicted: string[] = [];
    const byAge = Object.keys(idx).sort((a, b) => idx[a]!.usedAt - idx[b]!.usedAt);
    let total = byAge.reduce((sum, k) => sum + idx[k]!.bytes, 0);
    for (const k of byAge) {
      if (byAge.length - evicted.length <= MAX_RESULTS && total <= MAX_BYTES) break;
      total -= idx[k]!.bytes;
      evicted.push(k);
      delete idx[k];
    }
    try {
      if (evicted.length) await ext.storage.session.remove(evicted.map(resultKey));
      if (idx[key]) await ext.storage.session.set({ [resultKey(key)]: { etag, rules, result }, [INDEX_KEY]: idx });
      else await ext.storage.session.set({ [INDEX_KEY]: idx });
    } catch {
      // Out of quota or storage.session unavailable: start over.
      index = Promise.resolve({});
      const all = await ext.storage.session.get(null).catch(() => ({}));
      const keys = Object.keys(all).filter((k) => k === INDEX_KEY || k.startsWith('result:'));
      await ext.storage.session.remove(keys).catch(() => {});
    }
  });
}

/** Roughly what `result` takes in storage. */
function resultBytes(result: PruneResult): number {
  let bytes = 256 + 80 * result.probes.length;
  for (const f of result.pruned) bytes += 160 + f.path.length + f.rule.length + f.source.length;
  for (const dir of result.prunedDirs) bytes += 16 + dir.length;
  return bytes;
}

/**
 * Identifies everything besides the file list that decides a result: the
 * settings that pick rules, the repository's and the remote rules file, and
 * the built-in rules (by extension version).
 */
export async function rulesFingerprint(rulesKey: string, repo: RepoConfig, remoteText: string | null): Promise<string> {
  const text = JSON.stringify([ext.runtime.getManifest().version, rulesKey, repo.path, repo.text, remoteText]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest));
}

/** How long a repository's .pruneignore is reused before it's fetched again. */
export const REPO_CONFIG_TTL_MS = 10 * 60_000;
const REPO_CONFIGS_KEY = 'repoConfigs';
/** Rules files kept at most, the most recently fetched; real ones are a few KB. */
const MAX_REPO_CONFIGS = 32;

type RepoConfigs = Record<string, RepoConfig & { fetchedAt: number }>;

async function readRepoConfigs(): Promise<RepoConfigs> {
  const stored = await ext.storage.session.get(REPO_CONFIGS_KEY).catch(() => ({}) as Record<string, unknown>);
  return (stored[REPO_CONFIGS_KEY] as RepoConfigs | undefined) ?? {};
}

/**
 * The .pruneignore last fetched for the repository `key`. A `fresh` one is
 * reused, so tabs don't each fetch it.
 */
export async function storedRepoConfig(key: string): Promise<(RepoConfig & { fresh: boolean }) | null> {
  const entry = (await readRepoConfigs())[key];
  return entry ? { path: entry.path, text: entry.text, fresh: Date.now() - entry.fetchedAt < REPO_CONFIG_TTL_MS } : null;
}

export function saveRepoConfig(key: string, config: RepoConfig): Promise<void> {
  return serially(async () => {
    const configs = await readRepoConfigs();
    const now = Date.now();
    configs[key] = { path: config.path, text: config.text, fetchedAt: now };
    // Kept past their reuse, to tell whether stored results are for them (see background/pr.ts lookup()).
    const byAge = Object.keys(configs).sort((a, b) => configs[b]!.fetchedAt - configs[a]!.fetchedAt);
    for (const k of byAge.slice(MAX_REPO_CONFIGS)) delete configs[k];
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
