/**
 * Offline micro-benchmark of the content script's data path on a real huge PR
 * (nodejs/node#65161, GitHub's 3000-file cap): parsing the file_tree response,
 * compiling rules, computing the prune result and building the stylesheet.
 * The response is cached in .cache/ on first run.
 *
 *   node bench/compute.ts [--iterations=50]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCss } from '../src/content/dom/styles.ts';
import { parseFileTree } from '../src/content/github.ts';
import { computePrune } from '../src/content/prune.ts';
import { compileRules } from '../src/shared/rules.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';

const PR = 'https://github.com/nodejs/node/pull/65161';
const cacheDir = join(import.meta.dirname, '../.cache');
const fixture = join(cacheDir, 'node-65161-file_tree.json');
const ITERATIONS = Number(process.argv.find((a) => a.startsWith('--iterations='))?.split('=')[1] ?? '50');

async function loadFixture(): Promise<string> {
  try {
    return await readFile(fixture, 'utf8');
  } catch {
    const res = await fetch(`${PR}/page_data/file_tree`, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(`file_tree request failed: HTTP ${res.status}`);
    const text = await res.text();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(fixture, text);
    return text;
  }
}

const text = await loadFixture();
const settings = { ...DEFAULT_SETTINGS };

/** Times `fn`: the first (cold) call, then the median of `ITERATIONS` warm calls. */
function time<T>(name: string, fn: () => T): T {
  let t = performance.now();
  let value = fn();
  const cold = performance.now() - t;
  const warm: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    t = performance.now();
    value = fn();
    warm.push(performance.now() - t);
  }
  warm.sort((a, b) => a - b);
  console.log(`${name.padEnd(28)} cold ${cold.toFixed(2).padStart(7)} ms   warm ${warm[warm.length >> 1]!.toFixed(2).padStart(7)} ms`);
  return value;
}

console.log(`file_tree: ${(text.length / 1024).toFixed(0)} KB\n`);
const files = time('parseFileTree', () => parseFileTree(text));
const compiled = time('compileRules', () => compileRules(settings));
const result = time('computePrune', () => computePrune(files, {}, compiled, settings));
const css = time('buildCss', () =>
  buildCss(result, { diffMode: 'hide', treeMode: 'hide', revealed: new Set() }),
);
console.log(`\n${files.length} files, ${result.pruned.length} pruned, css ${(css.length / 1024).toFixed(0)} KB`);
