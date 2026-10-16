import { expect, test } from 'bun:test';
import {
  clearSnapshots,
  decode,
  encode,
  fingerprint,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_TOTAL_CHARS,
  readSnapshot,
  sameTotals,
  saveSnapshot,
  storedFingerprint,
} from '../src/content/dom/prerender.ts';
import type { PrunedFile, PruneResult } from '../src/shared/prune.ts';

/** localStorage's interface over a Map, in insertion order like browsers'. */
class MemoryStorage implements Storage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const digest = (i: number) => i.toString(16).padStart(64, '0');

function result(files: number, dirs: string[] = []): PruneResult {
  const pruned: PrunedFile[] = Array.from({ length: files }, (_, i) => ({
    path: `vendor/file-${i}.js`,
    digest: digest(i),
    additions: 10,
    deletions: 2,
    generated: false,
    rule: 'vendor/',
    source: 'Built-in',
  }));
  return {
    listed: 40,
    pruned,
    prunedDirs: dirs,
    original: { additions: 751, deletions: 1136, files: 38 },
    kept: { additions: 751 - 10 * files, deletions: 1136 - 2 * files, files: 38 - files },
    removed: { additions: 10 * files, deletions: 2 * files, files },
    sources: ['Built-in'],
    probes: [],
    firstPath: null,
  };
}

const keys = (s: MemoryStorage) => [...s.map.keys()].filter((k) => k.startsWith('prune:') && k !== 'prune:index').sort();

test('a stored pre-render reads back as the files and totals it was made from', () => {
  const r = result(2, ['vendor']);
  const raw = encode(r, 'hide', 'dim');
  const back = decode(raw)!;
  expect(back.diffMode).toBe('hide');
  expect(back.treeMode).toBe('dim');
  expect(fingerprint(raw)).not.toBe(fingerprint(encode(r, 'hide', 'hide')));
  const s = new MemoryStorage();
  expect(storedFingerprint(s, 'a/b#1')).toBeNull();
  saveSnapshot(s, 'a/b#1', raw);
  expect(storedFingerprint(s, 'a/b#1')).toBe(fingerprint(raw));
  expect(back.result.pruned.map((f) => [f.digest, f.path])).toEqual(r.pruned.map((f) => [f.digest, f.path]));
  expect(back.result.prunedDirs).toEqual(['vendor']);
  expect(back.result.original).toEqual(r.original);
  expect(back.result.kept).toEqual(r.kept);
  expect(sameTotals(back, r)).toBe(true);
  // Only what the page shows is kept: no rules, sources or per-file numbers.
  expect(raw).not.toContain('Built-in');
});

test('anything malformed is rejected (the page can write there too)', () => {
  const good = JSON.parse(encode(result(1), 'hide', 'hide')) as unknown[];
  const variant = (i: number, value: unknown) => JSON.stringify(good.map((v, j) => (j === i ? value : v)));
  expect(decode(JSON.stringify(good))).not.toBeNull();
  expect(decode('not json')).toBeNull();
  expect(decode('{}')).toBeNull();
  expect(decode(variant(0, 2))).toBeNull(); // another format version
  expect(decode(variant(1, 'explode'))).toBeNull();
  expect(decode(variant(2, 'hide; color: red'))).toBeNull();
  expect(decode(variant(3, -1))).toBeNull();
  expect(decode(variant(5, 1.5))).toBeNull();
  expect(decode(variant(9, 'g'.repeat(64)))).toBeNull(); // not hex
  expect(decode(variant(9, `${digest(1)}} body { display: none`))).toBeNull();
  expect(decode(variant(9, digest(1) + digest(2)))).toBeNull(); // more digests than paths
  expect(decode(variant(10, [1]))).toBeNull();
  expect(decode(variant(11, 'vendor'))).toBeNull();
});

test('sameTotals tells a PR that changed since', () => {
  const stored = decode(encode(result(1), 'hide', 'hide'))!;
  const pushed = result(1);
  pushed.original = { ...pushed.original, additions: 800 };
  expect(sameTotals(stored, pushed)).toBe(false);
  const ruled = result(1);
  ruled.kept = { ...ruled.kept, files: 30 };
  expect(sameTotals(stored, ruled)).toBe(false);
});

test('pre-renders are keyed by PR', () => {
  const s = new MemoryStorage();
  saveSnapshot(s, 'a/b#1', encode(result(1), 'hide', 'hide'));
  saveSnapshot(s, 'a/b#2', encode(result(2), 'hide', 'hide'));
  expect(readSnapshot(s, 'a/b#1')!.result.pruned).toHaveLength(1);
  expect(readSnapshot(s, 'a/b#2')!.result.pruned).toHaveLength(2);
  expect(readSnapshot(s, 'a/b#3')).toBeNull();
  // GitHub's own keys are left alone.
  s.setItem('github-thing', 'x');
  clearSnapshots(s);
  expect(keys(s)).toEqual([]);
  expect(s.getItem('github-thing')).toBe('x');
  expect(s.getItem('prune:index')).toBeNull();
});

test('at most MAX_ENTRIES are kept, the least recently used go first', () => {
  const s = new MemoryStorage();
  const raw = encode(result(1), 'hide', 'hide');
  for (let i = 0; i < MAX_ENTRIES; i++) saveSnapshot(s, `a/b#${i}`, raw);
  // Seen again (unchanged): it moves to the front without being rewritten.
  saveSnapshot(s, 'a/b#0', raw, true);
  saveSnapshot(s, 'a/b#new', raw);
  expect(keys(s)).toHaveLength(MAX_ENTRIES);
  expect(readSnapshot(s, 'a/b#0')).not.toBeNull();
  expect(readSnapshot(s, 'a/b#1')).toBeNull();
  expect(readSnapshot(s, 'a/b#new')).not.toBeNull();
});

test('their total size is bounded, and one too large is not kept', () => {
  const s = new MemoryStorage();
  const big = encode(result(400), 'hide', 'hide');
  expect(big.length).toBeLessThan(MAX_ENTRY_CHARS);
  const fit = Math.floor(MAX_TOTAL_CHARS / big.length);
  for (let i = 0; i <= fit; i++) saveSnapshot(s, `a/b#${i}`, big);
  expect(keys(s)).toHaveLength(fit);
  expect(readSnapshot(s, 'a/b#0')).toBeNull();
  const total = keys(s).reduce((n, k) => n + s.getItem(k)!.length, 0);
  expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS);

  saveSnapshot(s, 'a/b#1', encode(result(1000), 'hide', 'hide'));
  expect(readSnapshot(s, 'a/b#1')).toBeNull();
  expect(JSON.parse(s.getItem('prune:index')!).map(([k]: [string]) => k)).not.toContain('a/b#1');
});

test('entries the index lost track of are dropped', () => {
  const s = new MemoryStorage();
  // Another tab saved at the same time, and its index update was lost.
  s.setItem('prune:a/b#9', encode(result(1), 'hide', 'hide'));
  saveSnapshot(s, 'a/b#1', encode(result(1), 'hide', 'hide'));
  expect(keys(s)).toEqual(['prune:a/b#1']);
});

test('clearSnapshots can forget a single PR', () => {
  const s = new MemoryStorage();
  saveSnapshot(s, 'a/b#1', encode(result(1), 'hide', 'hide'));
  saveSnapshot(s, 'a/b#2', encode(result(1), 'hide', 'hide'));
  clearSnapshots(s, (k) => k === 'a/b#1');
  expect(keys(s)).toEqual(['prune:a/b#2']);
  expect(JSON.parse(s.getItem('prune:index')!)).toEqual([['a/b#2', expect.any(Number)]]);
});

test('running out of quota keeps nothing rather than failing', () => {
  const s = new MemoryStorage();
  saveSnapshot(s, 'a/b#1', encode(result(1), 'hide', 'hide'));
  const full = Object.assign(s, {
    setItem(k: string, v: string) {
      if (k.startsWith('prune:a/b#2')) throw new DOMException('full', 'QuotaExceededError');
      s.map.set(k, v);
    },
  });
  saveSnapshot(full, 'a/b#2', encode(result(1), 'hide', 'hide'));
  expect(keys(s)).toEqual([]);
});
