import { describe, expect, test } from 'bun:test';
import { DEFAULT_GROUPS } from '../src/shared/defaults.ts';
import { Matcher, parseRules } from '../src/shared/matcher.ts';

function matcher(text: string): Matcher {
  return new Matcher(parseRules(text, 'test').rules);
}

const pruned = (rules: string, path: string) => matcher(rules).match(path) !== null;

describe('gitignore semantics', () => {
  test('basename patterns match at any depth', () => {
    expect(pruned('pnpm-lock.yaml', 'pnpm-lock.yaml')).toBe(true);
    expect(pruned('pnpm-lock.yaml', 'apps/web/pnpm-lock.yaml')).toBe(true);
    expect(pruned('pnpm-lock.yaml', 'apps/web/pnpm-lock.yaml.bak')).toBe(false);
  });

  test('wildcards do not cross directories', () => {
    expect(pruned('*.min.js', 'public/vendor/jquery.min.js')).toBe(true);
    expect(pruned('src/*.ts', 'src/index.ts')).toBe(true);
    expect(pruned('src/*.ts', 'src/deep/index.ts')).toBe(false);
    expect(pruned('file?.txt', 'file1.txt')).toBe(true);
    expect(pruned('file?.txt', 'file10.txt')).toBe(false);
  });

  test('a slash in the middle anchors to the root', () => {
    expect(pruned('docs/api', 'docs/api/index.md')).toBe(true);
    expect(pruned('docs/api', 'packages/docs/api/index.md')).toBe(false);
    expect(pruned('/build', 'build/out.js')).toBe(true);
    expect(pruned('/build', 'pkg/build/out.js')).toBe(false);
  });

  test('trailing slash matches directories only, at any depth', () => {
    expect(pruned('dist/', 'dist/index.js')).toBe(true);
    expect(pruned('dist/', 'packages/a/dist/index.js')).toBe(true);
    expect(pruned('dist/', 'dist')).toBe(false);
    expect(pruned('__snapshots__/', 'src/__snapshots__/a.test.ts.snap')).toBe(true);
  });

  test('a pattern matching a directory matches its contents', () => {
    expect(pruned('node_modules', 'a/node_modules/x/index.js')).toBe(true);
  });

  test('double star', () => {
    expect(pruned('**/generated/*.ts', 'a/b/generated/x.ts')).toBe(true);
    expect(pruned('**/generated/*.ts', 'generated/x.ts')).toBe(true);
    expect(pruned('src/**/*.gen.ts', 'src/a/b/c.gen.ts')).toBe(true);
    expect(pruned('src/**/*.gen.ts', 'src/c.gen.ts')).toBe(true);
    expect(pruned('src/**/*.gen.ts', 'lib/src/c.gen.ts')).toBe(false);
    expect(pruned('fixtures/**', 'fixtures/a/b.json')).toBe(true);
  });

  test('character classes', () => {
    expect(pruned('*.[ch]', 'x/y.c')).toBe(true);
    expect(pruned('*.[ch]', 'x/y.h')).toBe(true);
    expect(pruned('*.[!ch]', 'x/y.c')).toBe(false);
    expect(pruned('*.[!ch]', 'x/y.o')).toBe(true);
  });

  test('regex special characters are literal', () => {
    expect(pruned('a+b(c).txt', 'a+b(c).txt')).toBe(true);
    expect(pruned('a+b(c).txt', 'aab(c)xtxt')).toBe(false);
    expect(pruned('$weird{1}.js', 'x/$weird{1}.js')).toBe(true);
  });

  test('comments, blank lines and escapes', () => {
    const { rules } = parseRules('# comment\n\n  \n\\#notacomment\n\\!bang\nkeep   \n', 't');
    expect(rules.map((r) => r.pattern)).toEqual(['#notacomment', '!bang', 'keep']);
  });

  test('last matching rule wins, negation re-includes', () => {
    const m = matcher('*.lock\n!yarn.lock');
    expect(m.match('Cargo.lock')).not.toBeNull();
    expect(m.match('yarn.lock')).toBeNull();
    expect(m.isExplicitlyKept('yarn.lock')).toBe(true);
    const m2 = matcher('!yarn.lock\n*.lock');
    expect(m2.match('yarn.lock')).not.toBeNull();
  });

  test('negation can re-include a file inside a pruned directory', () => {
    const m = matcher('dist/\n!dist/keep.js');
    expect(m.match('dist/a.js')).not.toBeNull();
    expect(m.match('dist/keep.js')).toBeNull();
  });

  test('reports the rule that matched', () => {
    const m = matcher('*.snap\n*.lock\n*.min.js');
    expect(m.match('x.lock')?.pattern).toBe('*.lock');
  });

  test('reports the right rule for every kind of pattern', () => {
    const m = matcher('dist/\n*.lock\nsrc/gen/**\n*.g.[ch]s\nvendor\nfoo?.txt\n/root.txt');
    expect(m.match('a/dist/x.js')?.pattern).toBe('dist/');
    expect(m.match('dist/yarn.lock')?.pattern).toBe('*.lock');
    expect(m.match('src/gen/a/b.ts')?.pattern).toBe('src/gen/**');
    expect(m.match('lib/model.g.cs')?.pattern).toBe('*.g.[ch]s');
    expect(m.match('vendor/dist/x.js')?.pattern).toBe('vendor');
    expect(m.match('a/foo1.txt')?.pattern).toBe('foo?.txt');
    expect(m.match('root.txt')?.pattern).toBe('/root.txt');
    expect(m.match('a/root.txt')).toBeNull();
    // A directory pattern does not match a file of the same name.
    expect(m.match('a/dist')).toBeNull();
  });

  test('invalid patterns are reported, not thrown', () => {
    const { rules, errors } = parseRules('ok.txt\n[z-a].txt', 't');
    expect(rules.map((r) => r.pattern)).toEqual(['ok.txt']);
    expect(errors.map((e) => e.line)).toEqual([2]);
  });
});

describe('built-in defaults', () => {
  const m = new Matcher(
    DEFAULT_GROUPS.flatMap((g) => parseRules(g.patterns.join('\n'), g.label).rules),
  );
  test.each([
    'package-lock.json',
    'apps/web/pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'Cargo.lock',
    'go.sum',
    'public/app.min.js',
    'dist/index.js',
    'src/__snapshots__/Button.test.tsx.snap',
    'api/v1/service.pb.go',
    'proto/foo_pb2.py',
    'src/routeTree.gen.ts',
    'lib/models/user.g.dart',
    'src/__generated__/schema.graphql.ts',
    'app.js.map',
  ])('prunes %s', (path) => {
    expect(m.match(path)).not.toBeNull();
  });
  test.each(['package.json', 'src/index.ts', 'README.md', 'Cargo.toml', 'go.mod', 'src/distance.ts', 'docs/lock.md'])(
    'keeps %s',
    (path) => {
      expect(m.match(path)).toBeNull();
    },
  );
  test('every built-in pattern compiles', () => {
    for (const g of DEFAULT_GROUPS) {
      expect(parseRules(g.patterns.join('\n'), g.label).errors).toEqual([]);
    }
  });
});

test('matching 3000 paths against all defaults is fast', () => {
  const m = new Matcher(DEFAULT_GROUPS.flatMap((g) => parseRules(g.patterns.join('\n'), g.label).rules));
  const paths = Array.from({ length: 3000 }, (_, i) => `packages/pkg-${i % 50}/src/module-${i}/file-${i}.ts`);
  const start = performance.now();
  for (const p of paths) m.match(p);
  expect(performance.now() - start).toBeLessThan(50);
});
