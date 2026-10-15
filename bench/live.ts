/**
 * Live performance + memory benchmark of the content script on real GitHub
 * PRs, in Chromium with the extension loaded. Nothing in the extension is
 * instrumented: CPU comes from the V8 sampling profiler (every sample whose
 * stack contains a content script frame, at 50µs resolution), memory from the
 * V8 sampling heap profiler (live objects allocated under content script
 * frames). "Content script" is any script of the extension running in the page
 * (content.js and loader.js).
 *
 * Style recalculation and layout don't run in our script's stack (the browser
 * does them before painting, for all changes at once), so they are measured
 * in a second, traced page load per run: each recalc's and layout's time is
 * split by the share of the elements it restyled because of PRune. Those are
 * the invalidations recorded with a content script stack (attribute and DOM
 * changes; invalidation sets scheduled from it), and every element restyled
 * because a stylesheet changed when PRune had changed its own just before
 * (and the page had not: then that restyle would have happened anyway).
 * In Chromium any stylesheet change restyles the whole document. Tracing invalidations slows the page down, so these numbers are inflated
 * (roughly 1.5×); compare them between builds, not with the CPU numbers.
 *
 * Interactions (revealing a diff from the "Pruned files" section, switching
 * PRune off and on) are measured on a loaded page that has settled, so all
 * style and layout work in the second after the click counts.
 *
 *   bun run build:chrome && node bench/live.ts [--runs=5] [--json=out.json]
 *     [--only=<scenario regex>] [--breakdown] [--extension=dist/chrome] [--no-style] [--explain]
 *
 * --breakdown prints where the time went (per content script function, self time
 * including native/GC work it triggered, averaged over runs) and where the
 * live heap was allocated. --no-style skips the traced loads; --explain
 * lists every recalc PRune had a part in, and what PRune invalidated.
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
const STYLE = !process.argv.includes('--no-style');
const EXPLAIN = process.argv.includes('--explain');

interface Scenario {
  name: string;
  url: string;
  idle?: boolean;
  /** Path to soft-navigate to once `url` has loaded, as if following a link. */
  softNav?: string;
  /** Measures clicks in the "Pruned files" section and the popover instead of the page load. */
  interactions?: boolean;
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
  // Switching tabs of a big PR: the diffs' rules start or stop applying.
  { name: 'huge PR · conv. → files (soft)', url: 'https://github.com/nodejs/node/pull/65161', softNav: '/nodejs/node/pull/65161/files' },
  { name: 'huge PR · files → conv. (soft)', url: 'https://github.com/nodejs/node/pull/65161/files', softNav: '/nodejs/node/pull/65161' },
  // Clicks on a big, fully loaded diff page (each is a sample of its own).
  { name: 'huge PR · files ·', url: 'https://github.com/nodejs/node/pull/65161/files', interactions: true },
];

interface Sample {
  totalMs: number;
  maxTaskMs: number;
  tasks: number;
  heapKb: number;
  /** Style recalculation and layout caused by PRune (NaN if not measured). */
  styleMs: number;
  layoutMs: number;
  /** Most style + layout caused by PRune in one frame. */
  maxFrameMs: number;
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

const OUR_SCRIPT = /^chrome-extension:\/\/[^/]+\/(content|loader)\.js$/;
/** `loader:` for frames in loader.js, so functions of both scripts can be told apart. */
const prefix = (url: string) => (url.endsWith('/loader.js') ? 'loader:' : '');
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

// ---- Style and layout ------------------------------------------------------

interface TraceEvent {
  name: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args: {
    elementCount?: number;
    message?: string;
    data?: {
      message?: string;
      reason?: string;
      invalidationSet?: string;
      invalidationList?: { id: string }[];
      stackTrace?: { url: string }[];
    };
  };
}

const TIMELINE = ['devtools.timeline', 'disabled-by-default-devtools.timeline'];
const INVALIDATIONS = 'disabled-by-default-devtools.timeline.invalidationTracking';
/** Reasons for restyling elements after a stylesheet was added, removed or changed. */
const SHEET_REASONS = new Set(['Style rule change', 'ActiveStylesheetsUpdate', '@keyframes rule change', 'PropertyRegistration']);
/**
 * Main-world timestamps in the trace: PRune added, removed or rewrote a
 * stylesheet of its own (`#prune-*`), or the page did one of its own (then the
 * restyle would have happened anyway).
 */
const SHEET_MARK = 'prune-sheet';
const PAGE_SHEET_MARK = 'page-sheet';

/** Runs in the page (main world) during traced loads: marks stylesheet changes in the trace. */
function markSheetChanges(): void {
  const sheet = (n: Node) => n.nodeName === 'STYLE' || (n.nodeName === 'LINK' && (n as HTMLLinkElement).rel === 'stylesheet');
  const ours = (n: Node) => sheet(n) && (n as Element).id.startsWith('prune');
  /** Linked sheets still loading: they apply in the first frame after they have. */
  const loading = new Set<HTMLLinkElement>();
  const watch = () =>
    requestAnimationFrame(() => {
      for (const link of loading) {
        if (!link.sheet && link.isConnected) continue;
        loading.delete(link);
        console.timeStamp('page-sheet');
      }
      if (loading.size > 0) watch();
    });
  new MutationObserver((records) => {
    let mark = '';
    for (const r of records) {
      for (const n of [r.target, ...r.addedNodes, ...r.removedNodes]) {
        if (ours(n)) mark ||= 'prune-sheet';
        else if (n.nodeName === 'LINK' && n !== r.target && n.isConnected && !(n as HTMLLinkElement).sheet && sheet(n)) {
          if (loading.size === 0) watch();
          loading.add(n as HTMLLinkElement);
        }
        // A style element's text, or a sheet added or removed (one in a <head> GitHub swapped included).
        else if (sheet(n) && (n !== r.target || n.nodeName === 'STYLE')) mark = 'page-sheet';
      }
    }
    if (mark) console.timeStamp(mark);
  }).observe(document, { childList: true, subtree: true });
}

async function startTracing(cdp: CDPSession, categories: string[]): Promise<() => Promise<TraceEvent[]>> {
  const events: TraceEvent[] = [];
  const onData = (e: { value: object[] }) => events.push(...(e.value as TraceEvent[]));
  cdp.on('Tracing.dataCollected', onData);
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: categories } });
  return async () => {
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    return events.sort((a, b) => a.ts - b.ts);
  };
}

const fromUs = (e: TraceEvent) => e.args.data?.stackTrace?.some((f) => OUR_SCRIPT.test(f.url)) ?? false;

/**
 * Style recalc and layout time caused by PRune, per renderer thread: each
 * recalc's time is split by the share of the invalidations since the last
 * one (and during it) that were PRune's, and the layout that follows it by
 * the same share. Layout without a recalc before it counts if PRune
 * invalidated layout (e.g. changed text) and nothing else did.
 */
function attributeStyle(events: TraceEvent[]): { styleMs: number; layoutMs: number; maxFrameMs: number } {
  const threads = new Map<string, TraceEvent[]>();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    (threads.get(key) ?? threads.set(key, []).get(key)!).push(e);
  }
  let styleMs = 0;
  let layoutMs = 0;
  let maxFrameMs = 0;
  for (const thread of threads.values()) {
    let ours = 0;
    let all = 0;
    // Until a recalc applies them (a linked sheet may take a few frames to load).
    let sheetChanged = false;
    let pageSheetChanged = false;
    let sheetsApplied = false;
    let layoutOurs = 0;
    let layoutAll = 0;
    /** Invalidation sets scheduled since the last recalc: whether by PRune only. */
    let sets = new Map<string, boolean>();
    /** What PRune's invalidations since the last recalc were (for --explain). */
    let why = new Map<string, number>();
    const explain = (e: TraceEvent, what: string) => {
      if (!EXPLAIN) return;
      const frame = e.args.data?.stackTrace?.find((f) => OUR_SCRIPT.test(f.url)) as { functionName?: string } | undefined;
      const key = `${what}${frame ? ` < ${frame.functionName || '(anonymous)'}` : ''}`;
      why.set(key, (why.get(key) ?? 0) + 1);
    };
    let share = 0;
    let frameMs = 0;
    const recalcs = thread.filter((e) => e.name === 'UpdateLayoutTree' && e.dur !== undefined);
    let next = 0;
    const closeRecalcs = (until: number) => {
      // Invalidations recorded during a recalc (stylesheet changes, invalidation sets) belong to it.
      while (next < recalcs.length && until >= recalcs[next]!.ts + recalcs[next]!.dur!) {
        const recalc = recalcs[next++]!;
        share = all > 0 ? ours / all : 0;
        const ms = (share * recalc.dur!) / 1000;
        styleMs += ms;
        if (EXPLAIN && ours > 0) {
          console.log(`    recalc ${(recalc.dur! / 1000).toFixed(1)} ms × ${ours}/${all} = ${ms.toFixed(1)} ms (${recalc.args.elementCount} elements): ${[...why].map(([k, v]) => `${v}× ${k}`).join(', ')}`);
        }
        why = new Map();
        frameMs = ms;
        maxFrameMs = Math.max(maxFrameMs, frameMs);
        ours = all = 0;
        if (sheetsApplied) sheetChanged = pageSheetChanged = sheetsApplied = false;
        sets = new Map();
      }
    };
    for (const e of thread) {
      closeRecalcs(e.ts);
      switch (e.name) {
        case 'TimeStamp':
          if ((e.args.data?.message ?? e.args.message) === SHEET_MARK) sheetChanged = true;
          if ((e.args.data?.message ?? e.args.message) === PAGE_SHEET_MARK) pageSheetChanged = true;
          break;
        case 'ScheduleStyleInvalidationTracking': {
          const id = e.args.data?.invalidationSet;
          if (id) sets.set(id, (sets.get(id) ?? true) && fromUs(e));
          break;
        }
        case 'StyleInvalidatorInvalidationTracking': {
          all++;
          if (e.args.data?.invalidationList?.some((s) => sets.get(s.id))) {
            ours++;
            explain(e, e.args.data.reason ?? '?');
          }
          break;
        }
        case 'StyleRecalcInvalidationTracking':
          all++;
          if (SHEET_REASONS.has(e.args.data?.reason ?? '')) sheetsApplied = true;
          if (fromUs(e) || (sheetChanged && !pageSheetChanged && SHEET_REASONS.has(e.args.data?.reason ?? ''))) {
            ours++;
            explain(e, e.args.data?.reason ?? '?');
          }
          break;
        case 'LayoutInvalidationTracking':
          layoutAll++;
          if (fromUs(e)) layoutOurs++;
          break;
        case 'Layout': {
          if (e.dur === undefined) break;
          // Right after a recalc, the layout is mostly for what it restyled.
          const lastRecalc = recalcs[next - 1];
          const afterRecalc = lastRecalc && e.ts - (lastRecalc.ts + lastRecalc.dur!) < 1000;
          const s = afterRecalc ? share : layoutAll > 0 && layoutOurs === layoutAll ? 1 : 0;
          const ms = (s * e.dur) / 1000;
          layoutMs += ms;
          if (EXPLAIN && ms > 0.5) console.log(`    layout ${(e.dur / 1000).toFixed(1)} ms × ${s.toFixed(2)} = ${ms.toFixed(1)} ms`);
          if (afterRecalc) frameMs += ms;
          else frameMs = ms;
          maxFrameMs = Math.max(maxFrameMs, frameMs);
          layoutOurs = layoutAll = 0;
          break;
        }
      }
    }
    closeRecalcs(Infinity);
  }
  return { styleMs, layoutMs, maxFrameMs };
}

// ---- Scenarios ---------------------------------------------------------------

/** Loads the scenario's page as a user would: navigate, maybe follow a link, scroll through. */
async function visit(page: Page, { url, softNav }: Scenario): Promise<void> {
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
}

async function measure(page: Page, cdp: CDPSession, scenario: Scenario, sites: Map<string, number>): Promise<Sample> {
  const { url, idle } = scenario;
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512 });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLE_US });
  await cdp.send('Profiler.start');
  await visit(page, scenario);
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
  let style = { styleMs: NaN, layoutMs: NaN, maxFrameMs: NaN };
  if (STYLE) {
    // A second load, traced: tracing invalidations would distort the CPU profile.
    const stop = await startTracing(cdp, [...TIMELINE, INVALIDATIONS]);
    await visit(page, scenario);
    if (EXPLAIN) console.log(`  ${scenario.name}:`);
    style = attributeStyle(await stop());
  }
  return {
    totalMs: tasks.reduce((a, b) => a + b, 0),
    maxTaskMs: Math.max(0, ...tasks),
    tasks: tasks.length,
    heapKb: heapBytes(profile.head, sites) / 1024,
    ...style,
    functions,
    natives,
    longest,
  };
}

/** Waits for `n` frames to be produced, plus a little for work they set off. */
const frames = (page: Page, n = 3) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const tick = () => (++i >= n ? setTimeout(resolve, 300) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

/**
 * Clicks "Show diff" on the first pruned file, then switches PRune off and on
 * in the popover, on a page that has finished loading. Each click is profiled
 * on its own; everything the page restyles and lays out in the second after
 * it counts (the page is otherwise idle).
 */
async function measureInteractions(page: Page, cdp: CDPSession, scenario: Scenario): Promise<Record<string, Sample>> {
  await visit(page, scenario);
  const section = page.locator('[data-prune-ui="section"]');
  await section.scrollIntoViewIfNeeded();
  const showDiff = section.locator('.item .btn').first();
  await showDiff.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  const pill = page.locator('[data-prune-ui="indicator"] >> .pill');
  const toggle = page.locator('[data-prune-ui="indicator"] >> .switch');
  const samples: Record<string, Sample> = {};
  const click = async (name: string, target: typeof showDiff) => {
    await frames(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLE_US });
    await cdp.send('Profiler.start');
    const stop = await startTracing(cdp, TIMELINE);
    await target.click();
    await frames(page);
    await page.waitForTimeout(700);
    const events = await stop();
    const { profile: cpu } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile };
    const functions = new Map<string, number>();
    const natives = new Map<string, number>();
    const longest = new Map<string, number>();
    const tasks = contentScriptTasks(cpu, functions, natives, longest);
    const sum = (n: string) => events.filter((e) => e.name === n).reduce((s, e) => s + (e.dur ?? 0), 0) / 1000;
    const longestFrame = Math.max(0, ...events.filter((e) => e.name === 'UpdateLayoutTree' || e.name === 'Layout').map((e) => e.dur ?? 0)) / 1000;
    samples[`${scenario.name} ${name}`] = {
      totalMs: tasks.reduce((a, b) => a + b, 0),
      maxTaskMs: Math.max(0, ...tasks),
      tasks: tasks.length,
      heapKb: NaN,
      styleMs: sum('UpdateLayoutTree'),
      layoutMs: sum('Layout'),
      maxFrameMs: longestFrame,
      functions,
      natives,
      longest,
    };
  };
  await click('show diff', showDiff);
  // Back where the section is, then into the popover.
  await section.scrollIntoViewIfNeeded();
  await pill.hover();
  await page.locator('[data-prune-ui="indicator"] >> .popover').waitFor({ state: 'visible' });
  await click('toggle off', toggle);
  await click('toggle on', toggle);
  await page.mouse.move(5, 900);
  return samples;
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
  if (STYLE) await page.addInitScript(markSheetChanges);
  // Warm the HTTP cache so network jitter doesn't dominate.
  for (const s of scenarios) await page.goto(s.url, { waitUntil: 'load', timeout: 120_000 });
  for (let r = 0; r < RUNS; r++) {
    for (const s of scenarios) {
      if (s.interactions) {
        for (const [name, sample] of Object.entries(await measureInteractions(page, cdp, s))) {
          (results[name] ??= []).push(sample);
        }
        continue;
      }
      const sites = (allocationSites[s.name] ??= new Map());
      (results[s.name] ??= []).push(await measure(page, cdp, s, sites));
    }
  }
} finally {
  await context.close();
}

const fmt = (n: number, width = 6) => (Number.isNaN(n) ? '-' : n.toFixed(1)).padStart(width);
console.log(`\n${RUNS} runs per scenario (median / worst = max over runs)\n`);
console.log(
  'scenario                          JS ms             longest task ms   tasks   heap KB             style ms            layout ms           worst frame ms',
);
const summary: Record<string, unknown> = {};
type Metric = 'totalMs' | 'maxTaskMs' | 'tasks' | 'heapKb' | 'styleMs' | 'layoutMs' | 'maxFrameMs';
const METRICS: Metric[] = ['totalMs', 'maxTaskMs', 'heapKb', 'styleMs', 'layoutMs', 'maxFrameMs'];
for (const [name, samples] of Object.entries(results)) {
  const pick = (k: Metric) => samples.map((s) => s[k]).sort((a, b) => a - b);
  const med = (k: Metric) => pick(k)[Math.floor(samples.length / 2)]!;
  const worst = (k: Metric) => pick(k).at(-1)!;
  const both = (k: Metric) => `${fmt(med(k))} / ${fmt(worst(k))}`;
  console.log(
    `${name.padEnd(32)}  ${both('totalMs')}   ${both('maxTaskMs')}   ${String(med('tasks')).padStart(4)}   ${both('heapKb')}   ${both('styleMs')}   ${both('layoutMs')}   ${both('maxFrameMs')}`,
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
  summary[name] = {
    samples: samples.map(({ functions, natives, longest, ...rest }) => rest),
    median: Object.fromEntries(METRICS.map((k) => [k, med(k)])),
    worst: Object.fromEntries(METRICS.map((k) => [k, worst(k)])),
  };
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
