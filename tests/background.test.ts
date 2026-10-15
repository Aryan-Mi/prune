import { expect, test } from 'bun:test';
import { PrFileList } from '../src/shared/filetree.ts';

// A stand-in for storage.session that, like the real one, stores copies,
// and for tabs.sendMessage to tabs 1 and 2 (others are gone).
const area = new Map<string, unknown>();
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sent: [number, unknown][] = [];
let onChanged: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void = () => {};
(globalThis as { browser?: unknown }).browser = {
  runtime: { getManifest: () => ({ version: '1.0.0' }) },
  tabs: {
    async sendMessage(id: number, msg: unknown) {
      if (id > 2) throw new Error('Could not establish connection. Receiving end does not exist.');
      sent.push([id, msg]);
    },
  },
  storage: {
    onChanged: {
      addListener(listener: typeof onChanged) {
        onChanged = listener;
      },
    },
    session: {
      async get(key: string) {
        return area.has(key) ? { [key]: copy(area.get(key)) } : {};
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) area.set(k, copy(v));
      },
      async remove(keys: string[]) {
        for (const k of keys) area.delete(k);
      },
      async clear() {
        area.clear();
      },
    },
  },
};
// As in the Chromium build (see shared/target.ts).
(globalThis as { __CHROMIUM__?: boolean }).__CHROMIUM__ = true;
const { cachePartition, loadResult, rulesFingerprint, saveResult, stored } = await import('../src/background/cache.ts');
const { fetchesFor, fetchFileList } = await import('../src/background/fetch.ts');
const { notifyTabs, openTab, setInactive } = await import('../src/background/tabs.ts');
const { computePrune } = await import('../src/shared/prune.ts');
const { compileRules } = await import('../src/shared/rules.ts');
const { DEFAULT_SETTINGS, onConfigChanged } = await import('../src/shared/settings.ts');

const list = (n: number) =>
  PrFileList.of(
    Array.from({ length: n }, (_, i) => ({
      path: i % 2 ? `dir/file-${i}.ts` : `dir/${i}/yarn.lock`,
      digest: Bun.CryptoHasher.hash('sha256', `dir/file-${i}.ts`, 'hex'),
      additions: i,
      deletions: 1,
      generated: i % 5 === 0,
    })),
  );
const result = (n: number) => computePrune(list(n), {}, compileRules(DEFAULT_SETTINGS), DEFAULT_SETTINGS);

test('a stored result is only handed out for its ETag and rules', async () => {
  await saveResult('|a/b#1', 'W/"one"', 'rules', result(3));
  expect(await stored('|a/b#1')).toEqual({ etag: 'W/"one"', rules: 'rules', capped: false });
  expect(await stored('|a/b#2')).toBeNull();
  expect(await loadResult('|a/b#1', 'W/"two"', 'rules')).toBeNull();
  expect(await loadResult('|a/b#1', 'W/"one"', 'other rules')).toBeNull();
  expect(await loadResult('|a/b#1', 'W/"one"', 'rules')).toEqual(result(3));

  await saveResult('|a/b#1', 'W/"two"', 'rules', result(4));
  expect(await loadResult('|a/b#1', 'W/"one"', 'rules')).toBeNull();
  expect((await loadResult('|a/b#1', 'W/"two"', 'rules'))?.listed).toBe(4);
});

test('the least recently used results are dropped first', async () => {
  for (let i = 0; i < 40; i++) await saveResult(`|x/y#${i}`, `e${i}`, 'rules', result(2));
  expect(await stored('|x/y#0')).toBeNull();
  expect((await stored('|x/y#39'))?.etag).toBe('e39');
  expect(area.has('result:|x/y#0')).toBe(false);
  expect(area.has('result:|x/y#39')).toBe(true);
});

test('the rules fingerprint changes with every input', async () => {
  const repo = { path: '.pruneignore', text: 'a/' };
  const base = await rulesFingerprint('key', repo, null);
  expect(await rulesFingerprint('key', { ...repo }, null)).toBe(base);
  expect(await rulesFingerprint('other key', repo, null)).not.toBe(base);
  expect(await rulesFingerprint('key', { ...repo, text: 'b/' }, null)).not.toBe(base);
  expect(await rulesFingerprint('key', { ...repo, path: '.github/pruneignore' }, null)).not.toBe(base);
  expect(await rulesFingerprint('key', repo, '')).not.toBe(base);
});

test('cache keys are per container, and private windows get none', () => {
  const tab = { incognito: false } as browser.tabs.Tab;
  expect(cachePartition({ tab })).toBe('|');
  expect(cachePartition({ tab: { ...tab, cookieStoreId: 'firefox-container-1' } })).toBe('firefox-container-1|');
  expect(cachePartition({ tab: { ...tab, incognito: true } })).toBeNull();
  expect(cachePartition({})).toBeNull();
});

test('the background script only fetches for regular Chromium tabs', () => {
  const tab = { incognito: false } as browser.tabs.Tab;
  expect(fetchesFor({ tab })).toBe(true);
  expect(fetchesFor({ tab: { ...tab, incognito: true } })).toBe(false);
  // Firefox, in any container.
  expect(fetchesFor({ tab: { ...tab, cookieStoreId: 'firefox-default' } })).toBe(false);
  expect(fetchesFor({ tab: { ...tab, cookieStoreId: 'firefox-container-1' } })).toBe(false);
  expect(fetchesFor({})).toBe(false);
});

test('background fetches: only PR paths, 304 for the ETag, anything else fails', async () => {
  const requests: [string, RequestInit][] = [];
  const realFetch = globalThis.fetch;
  let reply = () => new Response(JSON.stringify({ diffs: [] }), { status: 200, headers: { ETag: 'W/"new"' } });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push([url, init]);
    return reply();
  }) as typeof fetch;
  try {
    expect(await fetchFileList('/a/b/pull/1/../../../settings', null)).toBeNull();
    expect(await fetchFileList('/a/b/pull/1?x', null)).toBeNull();
    expect(requests).toHaveLength(0);

    const fetched = await fetchFileList('/a/b/pull/1', null);
    expect(fetched?.etag).toBe('W/"new"');
    expect(fetched?.files?.length).toBe(0);
    expect(requests[0]![0]).toBe('https://github.com/a/b/pull/1/page_data/file_tree');
    expect(requests[0]![1]).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });

    reply = () => new Response(null, { status: 304 });
    expect(await fetchFileList('/a/b/pull/1', 'W/"old"')).toEqual({ etag: 'W/"old"', files: null });
    expect((requests[1]![1].headers as Record<string, string>)['If-None-Match']).toBe('W/"old"');
    // A 304 without having asked for one isn't an answer.
    expect(await fetchFileList('/a/b/pull/1', null)).toBeNull();

    reply = () => new Response('Not Found', { status: 404 });
    expect(await fetchFileList('/a/b/pull/1', null)).toBeNull();
    reply = () => new Response('<!DOCTYPE html>', { status: 200 });
    expect(await fetchFileList('/a/b/pull/1', null)).toBeNull();
  } finally {
    globalThis.fetch = realFetch;
  }
});
test('tabs keep their switched-off PRs and get settings changes', async () => {
  expect(await openTab(1)).toEqual([]);
  await setInactive(1, ['a/b#1']);
  expect(await openTab(1)).toEqual(['a/b#1']);
  expect(await openTab(2)).toEqual([]);
  expect(await openTab(3)).toEqual([]);
  expect(await openTab(undefined)).toEqual([]);
  await notifyTabs({ type: 'refresh-remote' });
  expect(sent.map(([id]) => id).sort()).toEqual([1, 2]);
  // Tab 3 didn't answer, so it's forgotten.
  sent.length = 0;
  await notifyTabs({ type: 'refresh-remote' });
  expect(sent.map(([id]) => id).sort()).toEqual([1, 2]);
  expect(Object.keys(area.get('tabs') as object).sort()).toEqual(['1', '2']);
});

test('settings changes tell whether files may be pruned differently', () => {
  const calls: boolean[] = [];
  onConfigChanged((rulesChanged) => calls.push(rulesChanged));
  onChanged({ settings: { oldValue: { diffMode: 'hide' }, newValue: { diffMode: 'collapse' } } }, 'local');
  onChanged({ settings: { newValue: { userPatterns: 'dist/' } } }, 'local');
  onChanged({ remoteCache: { newValue: { url: 'https://example.com', text: '' } } }, 'local');
  onChanged({ settings: { newValue: { userPatterns: 'dist/' } } }, 'session');
  expect(calls).toEqual([false, true, true]);
});
