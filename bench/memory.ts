/**
 * Offline, deterministic memory benchmark of what the content script keeps
 * for a PR: the file list, compiled rules, prune result and stylesheet. Uses
 * a cached copy of nodejs/node#65161's `page_data/file_tree` (3000 files), so
 * it needs the network only once. Measures memory retained after GC (JS heap
 * plus typed-array backing stores, which live outside it), plus where
 * it was allocated (V8 sampling heap profiler, like bench/live.ts).
 *
 *   node --expose-gc bench/memory.ts
 *
 * Node runs without pointer compression, so absolute numbers are ~1.5× what
 * Chrome shows; use it to compare changes.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { buildCss } from '../src/content/dom/styles.ts';
import { fetchPrFiles, parsePrUrl } from '../src/content/github.ts';
import { computePrune } from '../src/content/prune.ts';
import { compileRules } from '../src/shared/rules.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';

const PR_URL = 'https://github.com/nodejs/node/pull/65161';
const cacheFile = join(import.meta.dirname, '../.cache/node-65161-file_tree.json');

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('Run with node --expose-gc');

async function fixture(): Promise<string> {
  try {
    return await readFile(cacheFile, 'utf8');
  } catch {
    const res = await fetch(`${PR_URL}/page_data/file_tree`, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(`Fetching the fixture failed: HTTP ${res.status}`);
    const text = await res.text();
    await mkdir(join(cacheFile, '..'), { recursive: true });
    await writeFile(cacheFile, text);
    return text;
  }
}

const text = await fixture();
globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => text })) as unknown as typeof fetch;

function usage(): { heap: number; buffers: number } {
  gc!();
  gc!();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return { heap: heapUsed, buffers: arrayBuffers };
}

interface HeapNode {
  callFrame: { url: string; functionName: string };
  selfSize: number;
  children: HeapNode[];
}

/** Live bytes by allocating site: a src/ function, or a builtin plus its src/ caller. */
function sites(node: HeapNode, out: Map<string, number>, caller = ''): Map<string, number> {
  const ours = node.callFrame.url.includes('/src/');
  const name = node.callFrame.functionName || '(anonymous)';
  if (node.selfSize && (ours || caller)) {
    const site = ours ? name : `${name} < ${caller}`;
    out.set(site, (out.get(site) ?? 0) + node.selfSize);
  }
  for (const child of node.children) sites(child, out, ours ? name : caller);
  return out;
}

const settings = { ...DEFAULT_SETTINGS };

/** What the controller holds on to while the PR is open. */
async function load() {
  const files = await fetchPrFiles(parsePrUrl('/nodejs/node/pull/65161')!);
  const compiled = compileRules(settings);
  const result = computePrune(files, {}, compiled, settings);
  // The stylesheet is built but, like in the content script, not kept.
  const cssLength = buildCss(result, { diffMode: 'hide', treeMode: 'hide', revealed: new Set() }).length;
  return { files, compiled, result, cssLength };
}

// Warm up first so code compilation and the rules cache aren't counted as data.
await load();
const session = new Session();
session.connect();
await session.post('HeapProfiler.enable');
const before = usage();
await session.post('HeapProfiler.startSampling', { samplingInterval: 512 });
const { files, result, cssLength, ...retained } = await load();
const after = usage();
const { profile } = (await session.post('HeapProfiler.getSamplingProfile')) as { profile: { head: HeapNode } };
await session.post('HeapProfiler.stopSampling');

console.log(`${files.length} files, ${result.pruned.length} pruned, stylesheet ${(cssLength / 1024).toFixed(1)} KB`);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const heap = after.heap - before.heap;
const buffers = after.buffers - before.buffers;
console.log(`retained: ${kb(heap + buffers)} (JS heap ${kb(heap)} + array buffers ${kb(buffers)})\n`);
console.log('live heap by allocation site (KB):');
for (const [site, bytes] of [...sites(profile.head, new Map())].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${(bytes / 1024).toFixed(1).padStart(7)}  ${site}`);
}
void retained;
