/**
 * What a GitHub tab costs in memory with each build loaded, all JS worlds
 * included: the renderer's whole V8 heap after forced GCs (the page's main
 * world, and any content script's isolated world with its own copies of the
 * DOM wrappers and builtins), as a difference from the same page without the
 * extension. bench/live.ts only sees what the content script allocates; this
 * sees the fixed cost of the world it runs in too.
 *
 * GitHub's pages differ from load to load (timestamps, experiments, what
 * loads when), so each page is recorded once into a HAR file and replayed
 * from it for every build and run; requests it doesn't have go to the
 * network. Builds take turns run by run, each in a fresh browser.
 *
 *   node bench/worlds.ts [--runs=6] [--only=<page regex>] [--rerecord]
 *     [--build=<name>=<dir> ...]   (default: current=dist/chrome)
 *
 * Reports the median per page and build, and the spread over runs.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

const root = join(import.meta.dirname, '..');
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const RUNS = Number(arg('runs', '6'));
const ONLY = new RegExp(arg('only', ''), 'i');
const RERECORD = process.argv.includes('--rerecord');
const harDir = join(root, '.cache/worlds-har');

const builds: [string, string | null][] = [['none', null]];
for (const a of process.argv.filter((a) => a.startsWith('--build='))) {
  const [name, dir] = a.slice(8).split('=') as [string, string];
  builds.push([name, resolve(root, dir)]);
}
if (builds.length === 1) builds.push(['current', join(root, 'dist/chrome')]);

interface PageSpec {
  name: string;
  url: string;
  /** Path to soft-navigate to once `url` has loaded, as if following a link. */
  softNav?: string;
}

const PAGES: PageSpec[] = [
  { name: 'PR · conversation', url: 'https://github.com/vitejs/vite/pull/23648' },
  { name: 'PR · files', url: 'https://github.com/vitejs/vite/pull/23648/files' },
  { name: 'non-PR (repo home)', url: 'https://github.com/vitejs/vite' },
  { name: 'repo → PR (soft nav)', url: 'https://github.com/vitejs/vite', softNav: '/vitejs/vite/pull/23648' },
].filter((p) => ONLY.test(p.name));

const harFile = (page: PageSpec) => join(harDir, `${page.name.replace(/\W+/g, '-')}.har`);

async function launch(extension: string | null): Promise<BrowserContext> {
  return chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1400, height: 1000 },
    args: extension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : [],
  });
}

async function open(page: Page, spec: PageSpec): Promise<void> {
  await page.goto(spec.url, { waitUntil: 'load', timeout: 60_000 });
  if (spec.softNav) {
    await page.waitForTimeout(1500);
    await page.evaluate((href) => {
      const link = document.createElement('a');
      link.href = href;
      document.body.append(link);
      link.click();
      link.remove();
    }, spec.softNav);
    await page.waitForURL((u) => u.pathname === spec.softNav, { timeout: 30_000 });
  }
}

/** Records every page once (with the first build, so the content script's own requests are in it too). */
async function record(): Promise<void> {
  await mkdir(harDir, { recursive: true });
  const extension = builds.find(([, dir]) => dir)?.[1] ?? null;
  for (const spec of PAGES) {
    if (existsSync(harFile(spec)) && !RERECORD) continue;
    const ctx = await launch(extension);
    await ctx.routeFromHAR(harFile(spec), { update: true, updateContent: 'embed' });
    const page = await ctx.newPage();
    await open(page, spec);
    await page.waitForTimeout(4000);
    await ctx.close();
    console.log(`recorded ${spec.name}`);
  }
}

interface Sample {
  heapKb: number;
  contexts: number;
  nodes: number;
  listeners: number;
}

async function measure(ctx: BrowserContext, spec: PageSpec): Promise<Sample> {
  await ctx.routeFromHAR(harFile(spec), { notFound: 'fallback' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const mainFrame = frameTree.frame.id;
  // Execution contexts of the top document: the main world, plus one per isolated world.
  const contexts = new Set<number>();
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if ((context.auxData as { frameId?: string } | undefined)?.frameId === mainFrame) contexts.add(context.id);
  });
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable');
  await open(page, spec);
  // Let the page and the content script settle (lazy chunks, timers, observers).
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  await page.close();
  return { heapKb: usedSize / 1024, contexts: contexts.size, nodes: dom.nodes, listeners: dom.jsEventListeners };
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

await record();
const samples = new Map<string, Sample[]>();
for (let run = 0; run < RUNS; run++) {
  for (const [name, dir] of run % 2 ? [...builds].reverse() : builds) {
    const ctx = await launch(dir);
    try {
      for (const spec of PAGES) {
        const key = `${spec.name}|${name}`;
        const sample = await measure(ctx, spec).catch((err: unknown) => {
          console.error(`${key}: ${String(err)}`);
          return null;
        });
        if (sample) samples.set(key, [...(samples.get(key) ?? []), sample]);
      }
    } finally {
      await ctx.close();
    }
  }
  process.stdout.write(`run ${run + 1}/${RUNS}\r`);
}

console.log(`\n${RUNS} runs; renderer V8 heap after GC, median (min…max); Δ vs. no extension`);
for (const spec of PAGES) {
  console.log(`\n${spec.name}`);
  const base = median((samples.get(`${spec.name}|none`) ?? []).map((s) => s.heapKb));
  for (const [name] of builds) {
    const list = samples.get(`${spec.name}|${name}`) ?? [];
    if (!list.length) continue;
    const heaps = list.map((s) => s.heapKb);
    const delta = median(heaps) - base;
    console.log(
      `  ${name.padEnd(10)} ${median(heaps).toFixed(0).padStart(6)} KB  Δ ${delta.toFixed(0).padStart(5)} KB` +
        `  (${(Math.min(...heaps) - base).toFixed(0)}…${(Math.max(...heaps) - base).toFixed(0)})` +
        `  contexts ${median(list.map((s) => s.contexts))}  nodes ${median(list.map((s) => s.nodes))}` +
        `  listeners ${median(list.map((s) => s.listeners))}`,
    );
  }
}
