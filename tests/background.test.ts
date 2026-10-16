import { describe, expect, test } from 'bun:test';
import { PrFileList, type PrTotals } from '../src/shared/filetree.ts';
import type { RepoConfig } from '../src/shared/messages.ts';

// Stand-ins for storage.session and storage.local that, like the real ones,
// store copies, and for tabs.sendMessage to tabs 1 and 2 (others are gone).
const area = new Map<string, unknown>();
const local = new Map<string, unknown>();
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
    local: {
      async get(key: string) {
        return local.has(key) ? { [key]: copy(local.get(key)) } : {};
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) local.set(k, copy(v));
      },
      async remove(key: string) {
        local.delete(key);
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
const { cachePartition, loadResult, rulesFingerprint, saveResult, stored } = await import('../src/background/cache.ts');
const { notifyTabs, openTab, setInactive } = await import('../src/background/tabs.ts');
const { lookup, prune } = await import('../src/background/pr.ts');
const { computePrune, summarize } = await import('../src/shared/prune.ts');
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
  expect(await stored('|a/b#1')).toEqual({ etag: 'W/"one"', rules: 'rules' });
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

describe('a PR page', () => {
  const sender = { tab: { id: 1, incognito: false } as browser.tabs.Tab };
  const noRepo: RepoConfig = { path: null, text: null };
  const fileTree = (n: number, offset = 0) =>
    JSON.stringify({
      diffs: Array.from({ length: n }, (_, i) => ({
        path: i % 2 ? `src/${i + offset}.ts` : `${i + offset}/yarn.lock`,
        pathDigest: Bun.CryptoHasher.hash('sha256', `${i + offset}`, 'hex'),
        linesAdded: 2,
        linesDeleted: 1,
      })),
    });
  const ask = (key: string, files = true) => lookup({ type: 'lookup', key, repoKey: 'o/r', files }, sender);
  const send = (key: string, body: string | null, etag: string, totals: Partial<PrTotals> | null = null, repo = noRepo, files = true) =>
    prune({ type: 'prune', key, repoKey: 'o/r', fileTree: body, etag, repo, repoFetched: true, totals, files }, '|');

  test('gets its stored result with the reply to lookup, for the current rules only', async () => {
    expect(await ask('o/r#1')).toMatchObject({ etag: null, result: null, repo: null });
    const result = await send('o/r#1', fileTree(10), 'W/"a"');
    expect(result?.pruned).toHaveLength(5);
    await Bun.sleep(0);
    // The repository's rules were just fetched, so they are known now too.
    expect(await ask('o/r#1')).toMatchObject({ etag: 'W/"a"', result, repo: noRepo });

    local.set('settings', { userPatterns: 'src/' });
    expect(await ask('o/r#1')).toMatchObject({ etag: 'W/"a"', result: null });
    // Asked for the stored result anyway: it's for other rules.
    expect(await send('o/r#1', null, 'W/"a"')).toBeNull();
    local.delete('settings');
    expect((await send('o/r#1', null, 'W/"a"'))?.pruned).toHaveLength(5);
  });

  test('without diffs, it gets a summary', async () => {
    const result = await send('o/r#6', fileTree(10), 'W/"f"', null, noRepo, false);
    expect(result).toMatchObject({ pruned: [], prunedDirs: [], probes: [], partial: true, removed: { files: 5 } });
    await Bun.sleep(0);
    expect((await ask('o/r#6', false)).result).toEqual(result);
    // Then the files, for the popover: they were stored all along.
    const full = (await ask('o/r#6')).result;
    expect(full?.pruned).toHaveLength(5);
    expect(summarize(full!)).toEqual(result!);
  });

  test("without the repository's rules, lookup only says what is stored", async () => {
    await send('o/r#2', fileTree(4), 'W/"b"', null, { path: '.pruneignore', text: 'src/' });
    await Bun.sleep(0);
    area.delete('repoConfigs');
    expect(await ask('o/r#2')).toMatchObject({ etag: 'W/"b"', result: null, repo: null });
  });

  test("a capped list is stored with GitHub's totals only", async () => {
    const totals = { additions: 9000, deletions: 4000, files: 3500 };
    const result = await send('o/r#3', fileTree(3000), 'W/"c"', totals);
    expect(result?.original).toEqual(totals);
    expect(result?.kept).toEqual({ additions: 9000 - 3000, deletions: 4000 - 1500, files: 2000 });
    await Bun.sleep(0);
    expect((await ask('o/r#3')).result?.original).toEqual(totals);

    // Without all of them, the list's sums fill in for now, but the result isn't kept.
    expect((await send('o/r#4', fileTree(3000), 'W/"d"', { additions: 1 }))?.original).toEqual({
      additions: 1,
      deletions: 3000,
      files: 3000,
    });
    await Bun.sleep(0);
    expect((await ask('o/r#4')).etag).toBeNull();

    // Below the cap, the list's sums are exact.
    expect((await send('o/r#5', fileTree(10), 'W/"e"', totals))?.original.files).toBe(10);
  });
});
