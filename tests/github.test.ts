import { expect, test } from 'bun:test';
import { parsePrUrl } from '../src/content/github.ts';
import { PR_MATCH } from '../src/content/route.ts';
import { PrFileList } from '../src/shared/filetree.ts';

test('parses PR URLs on every tab', () => {
  expect(parsePrUrl('/vitejs/vite/pull/23648')).toMatchObject({
    owner: 'vitejs',
    repo: 'vite',
    number: 23648,
    key: 'vitejs/vite#23648',
    basePath: '/vitejs/vite/pull/23648',
    isDiffView: false,
  });
  expect(parsePrUrl('/a/b/pull/1/files')?.isDiffView).toBe(true);
  expect(parsePrUrl('/a/b/pull/1/changes')?.isDiffView).toBe(true);
  expect(parsePrUrl('/a/b/pull/1/files/abc..def')?.isDiffView).toBe(true);
  expect(parsePrUrl('/a/b/pull/1/commits')?.isDiffView).toBe(false);
  expect(parsePrUrl('/a/b/pull/1/commits/abc123')?.isDiffView).toBe(true);
  expect(parsePrUrl('/Org/Repo/pull/1')?.repoKey).toBe('org/repo');
});

test('ignores non-PR pages', () => {
  expect(parsePrUrl('/a/b')).toBeNull();
  expect(parsePrUrl('/a/b/pulls')).toBeNull();
  expect(parsePrUrl('/a/b/issues/1')).toBeNull();
});

test("the manifest's PR match pattern covers every PR URL", () => {
  // Match pattern → regex: `*` matches anything, including slashes.
  const pattern = new RegExp(`^${PR_MATCH.replace(/[.?+^$()[\]{}|\\/]/g, '\\$&').replaceAll('*', '.*')}$`);
  const paths = ['/a/b/pull/1', '/a/b/pull/1/files', '/a/b/pull/1/changes', '/a/b/pull/1/commits/abc', '/a.b/c-d/pull/9'];
  for (const path of paths) {
    expect(parsePrUrl(path)).not.toBeNull();
    expect(pattern.test(`https://github.com${path}`)).toBe(true);
  }
  // The loader handles everything else, and must not be skipped there.
  expect(pattern.test('https://github.com/a/b/pulls')).toBe(false);
  expect(pattern.test('https://github.com/a/b')).toBe(false);
});

test('PrFileList stores files column-wise and gives them back', () => {
  const files = ['a.ts', 'dir/b.lock'].map((path, i) => ({
    path,
    digest: Bun.CryptoHasher.hash('sha256', path, 'hex'),
    additions: i + 1,
    deletions: i * 10,
    generated: i === 1,
  }));
  const list = PrFileList.of(files);
  expect(list.length).toBe(2);
  expect(list.path(1)).toBe('dir/b.lock');
  expect(list.digest(1)).toBe(files[1]!.digest);
  expect([list.get(0), list.get(1)]).toEqual(files);
});
