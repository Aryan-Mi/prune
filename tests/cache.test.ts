import { expect, test } from 'bun:test';
import { PrFileList } from '../src/shared/filetree.ts';

// A stand-in for storage.session that, like the real one, stores copies.
const area = new Map<string, unknown>();
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
(globalThis as { browser?: unknown }).browser = {
  storage: {
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
const { cachePartition, loadFileList, saveFileList, storedEtag } = await import('../src/background/cache.ts');

const list = (n: number) =>
  PrFileList.of(
    Array.from({ length: n }, (_, i) => ({
      path: `dir/file-${i}.ts`,
      digest: Bun.CryptoHasher.hash('sha256', `dir/file-${i}.ts`, 'hex'),
      additions: i,
      deletions: 1,
      generated: i % 5 === 0,
    })),
  );

test('a stored file list is only handed out for its ETag', async () => {
  await saveFileList('|a/b#1', 'W/"one"', list(3));
  expect(await storedEtag('|a/b#1')).toBe('W/"one"');
  expect(await storedEtag('|a/b#2')).toBeNull();
  expect(await loadFileList('|a/b#1', 'W/"two"')).toBeNull();
  const loaded = await loadFileList('|a/b#1', 'W/"one"');
  expect(loaded?.length).toBe(3);
  expect(loaded?.get(2)).toEqual(list(3).get(2));

  await saveFileList('|a/b#1', 'W/"two"', list(4));
  expect(await loadFileList('|a/b#1', 'W/"one"')).toBeNull();
  expect((await loadFileList('|a/b#1', 'W/"two"'))?.length).toBe(4);
});

test('the least recently used lists are dropped first', async () => {
  for (let i = 0; i < 20; i++) await saveFileList(`|x/y#${i}`, `e${i}`, list(2));
  expect(await storedEtag('|x/y#0')).toBeNull();
  expect(await storedEtag('|x/y#19')).toBe('e19');
  expect(area.has('fileList:|x/y#0')).toBe(false);
  expect(area.has('fileList:|x/y#19')).toBe(true);
});

test('cache keys are per container, and private windows get none', () => {
  const tab = { incognito: false } as browser.tabs.Tab;
  expect(cachePartition({ tab })).toBe('|');
  expect(cachePartition({ tab: { ...tab, cookieStoreId: 'firefox-container-1' } })).toBe('firefox-container-1|');
  expect(cachePartition({ tab: { ...tab, incognito: true } })).toBeNull();
  expect(cachePartition({})).toBeNull();
});
