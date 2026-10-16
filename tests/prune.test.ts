import { describe, expect, test } from 'bun:test';
import { PrFileList, type PrFile } from '../src/shared/filetree.ts';
import { buildCss, lazyCss } from '../src/content/dom/styles.ts';
import { applyTotals, isCapped } from '../src/shared/totals.ts';
import { computePrune, prunePr } from '../src/shared/prune.ts';
import { compileRules } from '../src/shared/rules.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../src/shared/settings.ts';

const file = (path: string, additions: number, deletions: number, generated = false): PrFile => ({
  path,
  digest: Bun.CryptoHasher.hash('sha256', path, 'hex'),
  additions,
  deletions,
  generated,
});

const files = PrFileList.of([
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

  test('GitHub totals can be applied afterwards, and are only needed for capped lists', () => {
    const r = computePrune(files, {}, compileRules(settings), settings);
    expect(isCapped(r)).toBe(false);
    expect(isCapped({ ...r, listed: 3000 })).toBe(true);
    const totals = { additions: 10_000, deletions: 5_000, files: 4000 };
    expect(applyTotals(r, totals)).toEqual(computePrune(files, totals, compileRules(settings), settings));
    expect(applyTotals(r, {})).toEqual(r);
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

describe('prunePr', () => {
  test('parses the file_tree response and returns a JSON-safe result', () => {
    const fileTree = JSON.stringify({
      diffs: [
        ...[0, 1, 2].map((i) => {
          const f = file(`src/f${i}.ts`, i, 0);
          return { path: f.path, pathDigest: f.digest, linesAdded: i, linesDeleted: 0, changeType: 'MODIFIED' };
        }),
        { path: 'yarn.lock', pathDigest: file('yarn.lock', 0, 0).digest, linesAdded: 9, linesDeleted: 1 },
        { path: 'bad.lock', pathDigest: 'not-a-digest', linesAdded: 1, linesDeleted: 1 },
      ],
    });
    const r = prunePr(fileTree, { files: 5 }, settings, {});
    expect(r.listed).toBe(4);
    expect(r.pruned.map((f) => f.path)).toEqual(['yarn.lock']);
    expect(r.kept).toEqual({ additions: 3, deletions: 0, files: 4 });
    expect(r.probes).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'yarn.lock'].map((p) => file(p, 0, 0).digest));
    expect(r.firstPath).toBe('src/f0.ts');
    expect(r.sources).toEqual(['Built-in defaults']);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  test('probes are the first and last 16 digests', () => {
    const many = PrFileList.of(Array.from({ length: 40 }, (_, i) => file(`f${i}`, 1, 1)));
    const r = computePrune(many, {}, compileRules(settings), settings);
    expect(r.probes).toEqual([...Array.from({ length: 16 }, (_, i) => i), ...Array.from({ length: 16 }, (_, i) => 24 + i)].map((i) => many.digest(i)));
  });
});

describe('buildCss', () => {
  const r = computePrune(files, {}, compileRules(settings), settings);
  const lock = r.pruned[0]!;

  test('hides diffs and tree rows by digest', () => {
    const css = buildCss(r, { diffMode: 'hide', treeMode: 'hide' });
    expect(css).toContain(`#diff-${lock.digest}:not([data-prune-show])`);
    expect(css).toContain(`#file-tree-item-diff-${lock.digest}:not([data-prune-show])`);
    expect(css).toContain('li#pnpm-lock\\.yaml[role="treeitem"]:not([data-prune-show])');
    // dist/ only contains pruned files, so the directory row goes too.
    expect(css).toContain('li#dist[role="treeitem"]');
    expect(css).not.toContain('li#src[');
    expect(css).toContain('display: none');
    // Firefox: every rule starts at the id, so the sheet stays cheap to add and remove.
    expect(css).not.toContain('html[');
  });

  test('gated rules start with the <html> attribute', () => {
    const css = buildCss(r, { diffMode: 'hide', treeMode: 'hide', gated: true });
    // One selector per line.
    const selectors = css.split('\n');
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.startsWith('html[data-prune-on] ')).toBe(true);
  });

  test('the classic UI only gets its own tree selectors', () => {
    const css = buildCss(r, { diffMode: 'hide', treeMode: 'hide', classic: true });
    expect(css).toContain(`#diff-${lock.digest}`);
    expect(css).toContain(`#file-tree-item-diff-${lock.digest}`);
    expect(css).not.toContain('[role="treeitem"]');
  });

  test('show mode leaves diffs alone and only dims the tree', () => {
    const css = buildCss(r, { diffMode: 'show', treeMode: 'hide' });
    expect(css).not.toContain(`#diff-${lock.digest}`);
    expect(css).toContain('opacity: 0.45');
    expect(css).not.toContain('display: none');
  });

  test('escapes paths into id selectors', () => {
    const odd = computePrune(
      PrFileList.of([file('weird"name.lock', 1, 1), file('1 a/-2.lock', 1, 1)]),
      {},
      compileRules(normalizeSettings({ userPatterns: '*.lock' })),
      settings,
    );
    const css = buildCss(odd, { diffMode: 'hide', treeMode: 'hide' });
    expect(css).toContain('li#weird\\"name\\.lock[role="treeitem"]');
    expect(css).toContain('li#\\31 \\ a\\/-2\\.lock[role="treeitem"]');
    expect(css).toContain('li#\\31 \\ a[role="treeitem"]');
  });
});

describe('lazyCss', () => {
  const many = PrFileList.of(Array.from({ length: 20 }, (_, i) => file(`vendor/${i}.js`, 1, 1)));
  const r = computePrune(many, {}, compileRules(normalizeSettings({ userPatterns: 'vendor/' })), settings);

  test('renders pruned diffs lazily: the classic body, or the whole new UI diff', () => {
    const [first] = lazyCss(r);
    const digest = r.pruned[0]!.digest;
    expect(first).toContain(`#diff-${digest} > .js-file-content`);
    expect(first).toContain(`#diff-${digest}:not(.js-file)`);
    expect(first).toContain('content-visibility: auto');
    expect(first).not.toContain('html[');
  });

  test('groups of eight settle one by one, each behind its token in Chromium', () => {
    const groups = lazyCss(r, true);
    expect(r.pruned).toHaveLength(20);
    expect(groups).toHaveLength(3);
    expect(groups[2]!.match(/#diff-/g)).toHaveLength(2 * 4);
    groups.forEach((css, i) => {
      for (const selector of css.split('\n')) expect(selector.startsWith(`html[data-prune-lazy~="${i}"] #diff-`)).toBe(true);
    });
  });
});
