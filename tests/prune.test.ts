import { describe, expect, test } from 'bun:test';
import { PrFileList, type PrFile } from '../src/content/github.ts';
import { buildCss } from '../src/content/dom/styles.ts';
import { computePrune } from '../src/content/prune.ts';
import { compileRules } from '../src/shared/rules.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../src/shared/settings.ts';

const file = (path: string, additions: number, deletions: number, generated = false): PrFile => ({
  path,
  digest: Bun.CryptoHasher.hash('sha256', path, 'hex'),
  additions,
  deletions,
  generated,
});

const files = new PrFileList([
  file('package.json', 2, 2),
  file('pnpm-lock.yaml', 600, 1100),
  file('src/index.ts', 20, 4),
  file('src/api/client.ts', 100, 0, true),
  file('dist/bundle.js', 50, 30),
]);
const settings: Settings = { ...DEFAULT_SETTINGS };

describe('computePrune', () => {
  test('prunes built-in matches and linguist-generated files', () => {
    const r = computePrune(files, {}, compileRules(settings), settings);
    expect(r.pruned.map((f) => f.path)).toEqual(['pnpm-lock.yaml', 'src/api/client.ts', 'dist/bundle.js']);
    expect(r.original).toEqual({ additions: 772, deletions: 1136, files: 5 });
    expect(r.removed).toEqual({ additions: 750, deletions: 1130, files: 3 });
    expect(r.kept).toEqual({ additions: 22, deletions: 6, files: 2 });
    expect(r.pruned.find((f) => f.path === 'src/api/client.ts')?.source).toBe('.gitattributes');
    expect(r.pruned[0]).toEqual({ ...file('pnpm-lock.yaml', 600, 1100), rule: 'pnpm-lock.yaml', source: 'Built-in · Lockfiles' });
    expect(r.prunedDirs).toEqual(['src/api', 'dist']);
  });

  test('uses GitHub totals when given (file list may be capped)', () => {
    const r = computePrune(files, { additions: 10_000, deletions: 5_000, files: 4000 }, compileRules(settings), settings);
    expect(r.kept).toEqual({ additions: 9250, deletions: 3870, files: 3997 });
  });

  test('repo rules, remote rules and personal rules layer in order', () => {
    const s = normalizeSettings({ userPatterns: '!dist/', remoteUrl: 'https://example.com/rules' });
    const compiled = compileRules(s, { repoText: 'src/index.ts', repoPath: '.pruneignore', remoteText: '!pnpm-lock.yaml' });
    const r = computePrune(files, {}, compiled, s);
    expect(r.pruned.map((f) => f.path)).toEqual(['src/index.ts', 'src/api/client.ts']);
    expect(compiled.sources).toEqual(['Built-in defaults', 'Repo .pruneignore', 'Remote rules file', 'Your rules']);
  });

  test('a negation also keeps linguist-generated files', () => {
    const s = normalizeSettings({ userPatterns: '!src/api/client.ts' });
    const r = computePrune(files, {}, compileRules(s), s);
    expect(r.pruned.map((f) => f.path)).not.toContain('src/api/client.ts');
  });

  test('disabled groups and options are respected', () => {
    const s = normalizeSettings({ disabledGroups: ['lockfiles'], respectLinguistGenerated: false });
    const r = computePrune(files, {}, compileRules(s), s);
    expect(r.pruned.map((f) => f.path)).toEqual(['dist/bundle.js']);
  });
});

describe('buildCss', () => {
  const r = computePrune(files, {}, compileRules(settings), settings);
  const lock = r.pruned[0]!;

  test('hides diffs and tree rows by digest', () => {
    const css = buildCss(r, { diffMode: 'hide', treeMode: 'hide', revealed: new Set() });
    expect(css).toContain(`#diff-${lock.digest}`);
    expect(css).toContain(`#file-tree-item-diff-${lock.digest}`);
    expect(css).toContain('li[role="treeitem"][id="pnpm-lock.yaml"]');
    // dist/ only contains pruned files, so the directory row goes too.
    expect(css).toContain('li[role="treeitem"][id="dist"]');
    expect(css).not.toContain('[id="src"]');
    expect(css).toContain('display: none');
  });

  test('revealed files are not hidden', () => {
    const css = buildCss(r, { diffMode: 'hide', treeMode: 'hide', revealed: new Set([lock.digest]) });
    expect(css).not.toContain(`#diff-${lock.digest}`);
  });

  test('show mode leaves diffs alone and only dims the tree', () => {
    const css = buildCss(r, { diffMode: 'show', treeMode: 'hide', revealed: new Set() });
    expect(css).not.toContain(`#diff-${lock.digest}`);
    expect(css).toContain('opacity: 0.45');
    expect(css).not.toContain('display: none');
  });

  test('escapes quotes in paths', () => {
    const odd = computePrune(new PrFileList([file('weird"name.lock', 1, 1)]), {}, compileRules(normalizeSettings({ userPatterns: '*.lock' })), settings);
    expect(buildCss(odd, { diffMode: 'hide', treeMode: 'hide', revealed: new Set() })).toContain('[id="weird\\"name.lock"]');
  });
});
