/**
 * Live performance + memory benchmark of the content script on real GitHub
 * PRs, in Chromium with the extension loaded. Nothing in the extension is
 * instrumented: CPU comes from the V8 sampling profiler (every sample whose
 * stack contains a content.js frame, at 50µs resolution), memory from the V8
 * sampling heap profiler (live objects allocated under content.js frames).
 *
 *   bun run build:chrome && node bench/live.ts [--runs=5] [--json=out.json]
 *     [--only=<scenario regex>] [--breakdown]
 *
 * --breakdown prints where the time went: per content.js function (self time,
 * including native/GC work it triggered), averaged over runs.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright';

const root = join(import.meta.dirname, '..');
const extensionPath = join(root, 'dist/chrome');
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const RUNS = Number(arg('runs', '5'));
const JSON_OUT = arg('json', '');
const ONLY = new RegExp(arg('only', ''), 'i');
const BREAKDOWN = process.argv.includes('--breakdown');

const SCENARIOS = [
  { name: 'huge PR · conversation', url: 'https://github.com/nodejs/node/pull/65161' },
  { name: 'huge PR · files', url: 'https://github.com/nodejs/node/pull/65161/files' },
  { name: 'small PR · conversation', url: 'https://github.com/vitejs/vite/pull/23648' },
  { name: 'small PR · files', url: 'https://github.com/vitejs/vite/pull/23648/files' },
];

interface Sample {
  totalMs: number;
  maxTaskMs: number;
  tasks: number;
  heapKb: number;
  /** Self time per content.js function (`name:line`), with native callees folded in. */
  functions: Map<string, number>;
  /** Time per non-content.js leaf frame called from content.js (e.g. querySelectorAll, GC). */
  natives: Map<string, number>;
}

interface ProfileNode {
  id: number;
  callFrame: { url: string; functionName: string; lineNumber: number };
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
}

const OUR_SCRIPT = /^chrome-extension:\/\/[^/]+\/content\.js$/;
const SAMPLE_US = 50;

/**
 * Splits the CPU profile into contiguous runs of samples whose stack contains
 * a content.js frame. Each run is one stretch of main-thread time spent in
 * PRune (task, microtask or observer callback).
 */
function contentScriptTasks(
  profile: CpuProfile,
  functions = new Map<string, number>(),
  natives = new Map<string, number>(),
): number[] {
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const ours = new Map<number, boolean>();
  const isOurs = (id: number): boolean => {
    const cached = ours.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id)!;
    const p = parent.get(id);
    const value = OUR_SCRIPT.test(node.callFrame.url) || (p !== undefined && isOurs(p));
    ours.set(id, value);
    return value;
  };
  /** Nearest content.js frame at or above the node. */
  const ownFrame = (id: number): ProfileNode => {
    let node = byId.get(id)!;
    while (!OUR_SCRIPT.test(node.callFrame.url)) node = byId.get(parent.get(node.id)!)!;
    return node;
  };
  const add = (map: Map<string, number>, key: string, ms: number) => map.set(key, (map.get(key) ?? 0) + ms);
  const tasks: number[] = [];
  let t = profile.startTime;
  let runStart = -1;
  let runEnd = -1;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i]!;
    if (!isOurs(profile.samples[i]!)) continue;
    const dt = Math.min(profile.timeDeltas[i + 1] ?? SAMPLE_US, SAMPLE_US * 4);
    const own = ownFrame(profile.samples[i]!).callFrame;
    add(functions, `${own.functionName || '(top level)'}:${own.lineNumber + 1}`, dt / 1000);
    const leaf = byId.get(profile.samples[i]!)!.callFrame;
    if (!OUR_SCRIPT.test(leaf.url)) add(natives, `${leaf.functionName || '(anonymous)'} ← ${own.functionName || '(top level)'}`, dt / 1000);
    if (runStart >= 0 && t - runEnd <= SAMPLE_US * 4) {
      runEnd = t + dt;
    } else {
      if (runStart >= 0) tasks.push((runEnd - runStart) / 1000);
      runStart = t;
      runEnd = t + dt;
    }
  }
  if (runStart >= 0) tasks.push((runEnd - runStart) / 1000);
  return tasks;
}

interface HeapNode {
  callFrame: { url: string };
  selfSize: number;
  children: HeapNode[];
}

function heapBytes(node: HeapNode, insideOurs = false): number {
  const ours = insideOurs || /chrome-extension:\/\/[^/]+\/content\.js$/.test(node.callFrame.url);
  let total = ours ? node.selfSize : 0;
  for (const child of node.children) total += heapBytes(child, ours);
  return total;
}

async function measure(page: Page, cdp: CDPSession, url: string): Promise<Sample> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512 });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLE_US });
  await cdp.send('Profiler.start');
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  // Let the page settle, then scroll through to trigger lazy/progressive loading.
  await page.waitForTimeout(3000);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);
  const { profile: cpu } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile };
  await cdp.send('HeapProfiler.collectGarbage');
  const { profile } = (await cdp.send('HeapProfiler.getSamplingProfile')) as { profile: { head: HeapNode } };
  await cdp.send('HeapProfiler.stopSampling');
  const functions = new Map<string, number>();
  const natives = new Map<string, number>();
  const tasks = contentScriptTasks(cpu, functions, natives);
  const pill = await page.evaluate(
    () => document.querySelector('[data-prune-ui="indicator"]')?.shadowRoot?.querySelector('.label')?.textContent ?? '',
  );
  if (!/pruned|off/.test(pill)) throw new Error(`PRune did not run on ${url} (pill: "${pill}")`);
  return {
    totalMs: tasks.reduce((a, b) => a + b, 0),
    maxTaskMs: Math.max(0, ...tasks),
    tasks: tasks.length,
    heapKb: heapBytes(profile.head) / 1024,
    functions,
    natives,
  };
}

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1400, height: 1000 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

const scenarios = SCENARIOS.filter((s) => ONLY.test(s.name));
const results: Record<string, Sample[]> = {};
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  // Warm the HTTP cache so network jitter doesn't dominate.
  for (const s of scenarios) await page.goto(s.url, { waitUntil: 'load', timeout: 120_000 });
  for (let r = 0; r < RUNS; r++) {
    for (const s of scenarios) {
      (results[s.name] ??= []).push(await measure(page, cdp, s.url));
    }
  }
} finally {
  await context.close();
}

const fmt = (n: number) => n.toFixed(1).padStart(6);
console.log(`\n${RUNS} runs per scenario (worst = max over runs)\n`);
console.log('scenario                    total ms (median / worst)   longest task ms (median / worst)   tasks   heap KB (median / worst)');
const summary: Record<string, unknown> = {};
for (const [name, samples] of Object.entries(results)) {
  type Metric = 'totalMs' | 'maxTaskMs' | 'tasks' | 'heapKb';
  const pick = (k: Metric) => samples.map((s) => s[k]).sort((a, b) => a - b);
  const med = (k: Metric) => pick(k)[Math.floor(samples.length / 2)]!;
  const worst = (k: Metric) => pick(k).at(-1)!;
  console.log(
    `${name.padEnd(26)}  ${fmt(med('totalMs'))} / ${fmt(worst('totalMs'))}              ${fmt(med('maxTaskMs'))} / ${fmt(worst('maxTaskMs'))}            ${String(med('tasks')).padStart(4)}   ${fmt(med('heapKb'))} / ${fmt(worst('heapKb'))}`,
  );
  if (BREAKDOWN) {
    for (const key of ['functions', 'natives'] as const) {
      const sum = new Map<string, number>();
      for (const sample of samples) for (const [k, v] of sample[key]) sum.set(k, (sum.get(k) ?? 0) + v / samples.length);
      const top = [...sum].sort((a, b) => b[1] - a[1]).slice(0, 25);
      console.log(`    ${key} (mean ms per run):`);
      for (const [k, v] of top) console.log(`      ${v.toFixed(2).padStart(7)}  ${k}`);
    }
  }
  summary[name] = { samples: samples.map(({ functions, natives, ...rest }) => rest), median: { totalMs: med('totalMs'), maxTaskMs: med('maxTaskMs'), heapKb: med('heapKb') }, worst: { totalMs: worst('totalMs'), maxTaskMs: worst('maxTaskMs'), heapKb: worst('heapKb') } };
}
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(summary, null, 2));
