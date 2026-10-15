/**
 * Live performance + memory benchmark of the content script on real GitHub
 * PRs, in Chromium with the extension loaded. Nothing in the extension is
 * instrumented: CPU comes from the V8 sampling profiler (every sample whose
 * stack contains a content script frame, at 50µs resolution), memory from the
 * V8 sampling heap profiler (live objects allocated under content script
 * frames). "Content script" is any script of the extension running in the page
 * (content.js, loader.js and the chunks content.js imports).
 *
 *   bun run build:chrome && node bench/live.ts [--runs=5] [--json=out.json]
 *     [--only=<scenario regex>] [--breakdown] [--extension=dist/chrome]
 *
 * --breakdown prints where the time went (per content script function, self time
 * including native/GC work it triggered, averaged over runs) and where the
 * live heap was allocated.
 */
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright';

const root = join(import.meta.dirname, '..');
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
// --extension=<dir> benchmarks another build (e.g. a saved copy) instead of dist/chrome.
const extensionPath = resolve(root, arg('extension', 'dist/chrome'));
const RUNS = Number(arg('runs', '5'));
const JSON_OUT = arg('json', '');
const ONLY = new RegExp(arg('only', ''), 'i');
const BREAKDOWN = process.argv.includes('--breakdown');

interface Scenario {
  name: string;
  url: string;
  idle?: boolean;
  /** Path to soft-navigate to once `url` has loaded, as if following a link. */
  softNav?: string;
}

const SCENARIOS: Scenario[] = [
  { name: 'huge PR · conversation', url: 'https://github.com/nodejs/node/pull/65161' },
  { name: 'huge PR · files', url: 'https://github.com/nodejs/node/pull/65161/files' },
  { name: 'small PR · conversation', url: 'https://github.com/vitejs/vite/pull/23648' },
  { name: 'small PR · files', url: 'https://github.com/vitejs/vite/pull/23648/files' },
  // Not a PR: a content script still runs on every github.com page, so this is its idle cost.
  { name: 'non-PR page (repo home)', url: 'https://github.com/vitejs/vite', idle: true },
  // Opening a PR from another GitHub page without a page load (GitHub's soft navigation).
  { name: 'repo → small PR (soft nav)', url: 'https://github.com/vitejs/vite', softNav: '/vitejs/vite/pull/23648' },
];

interface Sample {
  totalMs: number;
  maxTaskMs: number;
  tasks: number;
  heapKb: number;
  /** Self time per content script function (`file:name:line`), with native callees folded in. */
  functions: Map<string, number>;
  /** Time per non-content-script leaf frame called from a content script (e.g. querySelectorAll, GC). */
  natives: Map<string, number>;
  /** Self time per function within the longest task. */
  longest: Map<string, number>;
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

const OUR_SCRIPT = /^chrome-extension:\/\/[^/]+\/[\w-]+\.js$/;
/** `loader:`, `popover:`… for frames outside content.js, so functions of all scripts can be told apart. */
const prefix = (url: string) => (url.endsWith('/content.js') ? '' : `${url.slice(url.lastIndexOf('/') + 1, -3)}:`);
const SAMPLE_US = 50;

/**
 * Splits the CPU profile into contiguous runs of samples whose stack contains
 * a content script frame. Each run is one stretch of main-thread time spent in
 * PRune (task, microtask or observer callback).
 */
function contentScriptTasks(
  profile: CpuProfile,
  functions = new Map<string, number>(),
  natives = new Map<string, number>(),
  longest = new Map<string, number>(),
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
  /** Nearest content script frame at or above the node. */
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
  let runFunctions = new Map<string, number>();
  const endRun = () => {
    const ms = (runEnd - runStart) / 1000;
    if (ms > Math.max(0, ...tasks)) {
      longest.clear();
      for (const [k, v] of runFunctions) longest.set(k, v);
    }
    tasks.push(ms);
  };
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i]!;
    if (!isOurs(profile.samples[i]!)) continue;
    const dt = Math.min(profile.timeDeltas[i + 1] ?? SAMPLE_US, SAMPLE_US * 4);
    const own = ownFrame(profile.samples[i]!).callFrame;
    const key = `${prefix(own.url)}${own.functionName || '(top level)'}:${own.lineNumber + 1}`;
    add(functions, key, dt / 1000);
    const leaf = byId.get(profile.samples[i]!)!.callFrame;
    if (!OUR_SCRIPT.test(leaf.url)) add(natives, `${leaf.functionName || '(anonymous)'} ← ${own.functionName || '(top level)'}`, dt / 1000);
    if (runStart >= 0 && t - runEnd <= SAMPLE_US * 4) {
      runEnd = t + dt;
    } else {
      if (runStart >= 0) endRun();
      runStart = t;
      runEnd = t + dt;
      runFunctions = new Map();
    }
    add(runFunctions, key, dt / 1000);
  }
  if (runStart >= 0) endRun();
  return tasks;
}

interface HeapNode {
  callFrame: { url: string; functionName: string; lineNumber: number };
  selfSize: number;
  children: HeapNode[];
}

/**
 * Live bytes allocated under content script frames. `sites` collects them by the
 * allocating frame: a content script function, or a builtin plus its content script caller.
 */
function heapBytes(node: HeapNode, sites: Map<string, number>, caller = ''): number {
  const { url, functionName, lineNumber } = node.callFrame;
  const isOurs = OUR_SCRIPT.test(url);
  const name = isOurs ? `${prefix(url)}${functionName || '(anonymous)'}:${lineNumber + 1}` : functionName || '(anonymous)';
  const inside = isOurs || caller !== '';
  let total = 0;
  if (inside && node.selfSize) {
    total += node.selfSize;
    const site = isOurs ? name : `${name} < ${caller}`;
    sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
  }
  for (const child of node.children) total += heapBytes(child, sites, isOurs ? name : caller);
  return total;
}

async function measure(page: Page, cdp: CDPSession, scenario: Scenario, sites: Map<string, number>): Promise<Sample> {
  const { url, idle, softNav } = scenario;
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512 });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLE_US });
  await cdp.send('Profiler.start');
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  if (softNav) {
    await page.waitForTimeout(1500);
    await page.evaluate((href) => {
      const link = document.createElement('a');
      link.href = href;
      document.body.append(link);
      link.click();
    }, softNav);
    await page.waitForURL((u) => u.pathname === softNav, { timeout: 60_000 });
  }
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
  const longest = new Map<string, number>();
  const tasks = contentScriptTasks(cpu, functions, natives, longest);
  const pill = await page.evaluate(
    () => document.querySelector('[data-prune-ui="indicator"]')?.shadowRoot?.querySelector('.label')?.textContent ?? '',
  );
  if (idle ? pill !== '' : !/pruned|off/.test(pill)) throw new Error(`Unexpected PRune pill on ${url}: "${pill}"`);
  return {
    totalMs: tasks.reduce((a, b) => a + b, 0),
    maxTaskMs: Math.max(0, ...tasks),
    tasks: tasks.length,
    heapKb: heapBytes(profile.head, sites) / 1024,
    functions,
    natives,
    longest,
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
const allocationSites: Record<string, Map<string, number>> = {};
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  // Warm the HTTP cache so network jitter doesn't dominate.
  for (const s of scenarios) await page.goto(s.url, { waitUntil: 'load', timeout: 120_000 });
  for (let r = 0; r < RUNS; r++) {
    for (const s of scenarios) {
      const sites = (allocationSites[s.name] ??= new Map());
      (results[s.name] ??= []).push(await measure(page, cdp, s, sites));
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
    const worstRun = samples.reduce((a, b) => (b.maxTaskMs > a.maxTaskMs ? b : a));
    console.log(`    longest task of the worst run (${worstRun.maxTaskMs.toFixed(1)} ms):`);
    for (const [k, v] of [...worstRun.longest].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`      ${v.toFixed(2).padStart(7)}  ${k}`);
    }
  }
  summary[name] = { samples: samples.map(({ functions, natives, longest, ...rest }) => rest), median: { totalMs: med('totalMs'), maxTaskMs: med('maxTaskMs'), heapKb: med('heapKb') }, worst: { totalMs: worst('totalMs'), maxTaskMs: worst('maxTaskMs'), heapKb: worst('heapKb') } };
}
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(summary, null, 2));

if (BREAKDOWN) {
  for (const [name, sites] of Object.entries(allocationSites)) {
    console.log(`\n${name}: live heap by allocation site (KB, mean over runs)`);
    for (const [site, bytes] of [...sites].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${(bytes / 1024 / RUNS).toFixed(1).padStart(7)}  ${site}`);
    }
  }
}
