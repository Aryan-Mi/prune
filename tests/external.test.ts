import { expect, test } from 'bun:test';
import { isPageSender, pageMessage } from '../src/background/external.ts';

const tab = { id: 7, index: 0, incognito: false } as browser.tabs.Tab;
const page = { origin: 'https://github.com', url: 'https://github.com/a/b/pull/1', tab, frameId: 0 };
const prune = {
  type: 'prune',
  key: 'a/b#1',
  repoKey: 'a/b',
  fileTree: '{"diffs":[]}',
  etag: 'W/"1"',
  repo: { path: '.pruneignore', text: 'dist/' },
  repoFetched: true,
  totals: { additions: 9000, deletions: 10, files: 3500 },
  files: true,
};

test('only a tab’s top-level github.com document is a page', () => {
  expect(isPageSender(page)).toBe(true);
  expect(isPageSender({ ...page, origin: undefined })).toBe(true);
  expect(isPageSender({ ...page, origin: 'https://gist.github.com' })).toBe(false);
  expect(isPageSender({ ...page, origin: 'https://github.com.evil.example' })).toBe(false);
  expect(isPageSender({ ...page, origin: undefined, url: 'https://evil.example/https://github.com/' })).toBe(false);
  expect(isPageSender({ ...page, origin: undefined, url: undefined })).toBe(false);
  expect(isPageSender({ ...page, frameId: 3 })).toBe(false);
  expect(isPageSender({ ...page, tab: undefined })).toBe(false);
  // Another extension.
  expect(isPageSender({ ...page, id: 'abcdefghijklmnopabcdefghijklmnop' })).toBe(false);
});

test('pages get the messages a PR page sends, rebuilt from their checked fields', () => {
  expect(pageMessage({ type: 'lookup', key: 'a/b#1', repoKey: 'a/b', files: false, extra: 1 })).toEqual({
    type: 'lookup',
    key: 'a/b#1',
    repoKey: 'a/b',
    files: false,
  });
  expect(pageMessage({ ...prune, extra: 1 })).toEqual(prune as never);
  expect(pageMessage({ ...prune, fileTree: null, etag: null, repo: { path: null, text: null }, totals: null })).not.toBeNull();
  expect(pageMessage({ ...prune, totals: { files: 3500, extra: 'x' } })).toMatchObject({ totals: { files: 3500 } });
  expect(pageMessage({ type: 'set-inactive', keys: ['a/b#1', 'c/d#2'] })).toEqual({
    type: 'set-inactive',
    keys: ['a/b#1', 'c/d#2'],
  });
  expect(pageMessage({ type: 'open-options', url: 'https://evil.example' })).toEqual({ type: 'open-options' });
});

test('nothing that reads or changes settings, or reaches other tabs', () => {
  for (const type of ['refresh-remote', 'get-status', 'set-active', 'config-changed', 'save-settings', undefined]) {
    expect(pageMessage({ type, force: true, active: false })).toBeNull();
  }
  expect(pageMessage(null)).toBeNull();
  expect(pageMessage('lookup')).toBeNull();
});

test('malformed or oversized messages are refused', () => {
  const bad: unknown[] = [
    { type: 'lookup', key: 'a/b#1', files: true },
    { type: 'lookup', key: 'a/b#1', repoKey: 'a/b' },
    { type: 'lookup', key: 'a/b#1', repoKey: 'c/d', files: true },
    { type: 'lookup', key: '__proto__', repoKey: '__proto__' },
    { type: 'lookup', key: 'a/b/c#1', repoKey: 'a/b/c' },
    { type: 'lookup', key: `${'a'.repeat(400)}/b#1`, repoKey: `${'a'.repeat(400)}/b` },
    { type: 'set-inactive', keys: 'a/b#1' },
    { type: 'set-inactive', keys: ['a/b'] },
    { type: 'set-inactive', keys: Array.from({ length: 2000 }, (_, i) => `a/b#${i}`) },
    { ...prune, fileTree: 1 },
    { ...prune, fileTree: 'x'.repeat(17 * 1024 * 1024) },
    { ...prune, etag: {} },
    { ...prune, repo: null },
    { ...prune, repo: { path: 1, text: null } },
    { ...prune, repo: { path: null, text: 'x'.repeat(600 * 1024) } },
    { ...prune, repoFetched: 'yes' },
    { ...prune, files: undefined },
    { ...prune, totals: undefined },
    { ...prune, totals: 'many' },
    { ...prune, totals: { additions: -1 } },
    { ...prune, totals: { files: 1.5 } },
    { ...prune, totals: { deletions: '1' } },
  ];
  for (const msg of bad) expect(pageMessage(msg)).toBeNull();
});
