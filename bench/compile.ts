/**
 * What PRune's scripts cost the page just by being loaded, in Chromium with
 * the extension loaded: compiling them, and the memory their code takes. The
 * CPU profile in live.ts charges top-level compilation to "(program)", and its
 * heap profile only sees objects the scripts allocate, so neither shows this.
 *
 *   bun run build:chrome && node bench/compile.ts [--runs=5] [--json=out.json]
 *     [--only=<scenario regex>] [--extension=dist/chrome] [--no-heap] [--breakdown]
 *
 * Every run starts a fresh browser, so V8 has nothing cached: this is the
 * first PR page a tab's renderer process shows. (Later pages in the same
 * process find the compiled script in V8's in-memory compilation cache.)
 *
 * From a trace (`v8.compile`/`v8.compileModule`, `EvaluateScript`/
 * `v8.evaluateModule`, `FunctionCall`, and V8's lazy compilation events):
 *   compile   top-level compile of each of our scripts (parse + preparse)
 *   lazy      functions compiled on first call, inside our script's tasks
 *   run       our top-level code plus our callbacks (timers, events, observers),
 *             compilation included; promise continuations are not in the trace,
 *             live.ts has those
 * From a heap snapshot (after the page settled, before the popover was opened):
 *   code KB   what V8 keeps for our scripts' functions: SharedFunctionInfos,
 *             bytecode, scope infos, constant pools (incl. the CSS strings),
 *             feedback; only objects nothing outside our scripts' code holds.
 *             "JIT" is the part that is optimized machine code: it depends on
 *             how hot functions got by then, so it varies from run to run
 *   source KB our scripts' source text (held outside the JS heap)
 * And, after that:
 *   popover   ms from moving the pointer onto the ✂ pill until the popover is
 *             open, the first time (includes the 120 ms hover delay)
 */
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright';

const root = join(import.meta.dirname, '..');
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const extensionPath = resolve(root, arg('extension', 'dist/chrome'));
const RUNS = Number(arg('runs', '5'));
const JSON_OUT = arg('json', '');
const ONLY = new RegExp(arg('only', ''), 'i');
const HEAP = !process.argv.includes('--no-heap');
const BREAKDOWN = process.argv.includes('--breakdown');

interface Scenario {
  name: string;
  url: string;
  /** Path to soft-navigate to once `url` has loaded, as if following a link. */
  softNav?: string;
  /** No PR: nothing to hover. */
  idle?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'huge PR · conversation', url: 'https://github.com/nodejs/node/pull/65161' },
  { name: 'huge PR · files', url: 'https://github.com/nodejs/node/pull/65161/files' },
  { name: 'small PR · conversation', url: 'https://github.com/vitejs/vite/pull/23648' },
  { name: 'small PR · files', url: 'https://github.com/vitejs/vite/pull/23648/files' },
  { name: 'non-PR page (repo home)', url: 'https://github.com/vitejs/vite', idle: true },
  { name: 'repo → small PR (soft nav)', url: 'https://github.com/vitejs/vite', softNav: '/vitejs/vite/pull/23648' },
];

/** Any script of the extension running in the page (content.js, loader.js, lazily imported chunks). */
const OUR_SCRIPT = /^chrome-extension:\/\/[^/]+\/[\w.-]+\.js$/;
const scriptName = (url: string) => url.slice(url.lastIndexOf('/') + 1);

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  tid: number;
  args?: { data?: { url?: string }; fileName?: string };
}

interface Sample {
  compileMs: number;
  lazyMs: number;
  runMs: number;
  codeKb: number;
  /** Of codeKb, machine code from V8's optimizing tiers: depends on how hot functions got by snapshot time. */
  jitKb: number;
  sourceKb: number;
  popoverMs: number;
  /** Per script: compile ms, code KB. */
  scripts: Record<string, { compileMs: number; codeKb: number; sourceKb: number }>;
}

const eventUrl = (e: TraceEvent) => e.args?.data?.url ?? e.args?.fileName ?? '';

function analyzeTrace(events: TraceEvent[], sample: Sample): void {
  const complete = events.filter((e) => e.ph === 'X' && e.dur !== undefined);
  const script = (e: TraceEvent) => (sample.scripts[scriptName(eventUrl(e))] ??= { compileMs: 0, codeKb: 0, sourceKb: 0 });
  // Our stretches of main-thread time, outermost only.
  const ours: TraceEvent[] = [];
  for (const e of complete) {
    if (!OUR_SCRIPT.test(eventUrl(e))) continue;
    if (e.name === 'v8.compile' || e.name === 'v8.compileModule') {
      sample.compileMs += e.dur! / 1000;
      script(e).compileMs += e.dur! / 1000;
      ours.push(e);
    } else if (e.name === 'EvaluateScript' || e.name === 'v8.evaluateModule' || e.name === 'FunctionCall') {
      ours.push(e);
    }
  }
  ours.sort((a, b) => a.ts - b.ts);
  const spans: { tid: number; start: number; end: number }[] = [];
  for (const e of ours) {
    const last = spans.findLast((s) => s.tid === e.tid);
    if (last && e.ts < last.end) last.end = Math.max(last.end, e.ts + e.dur!);
    else spans.push({ tid: e.tid, start: e.ts, end: e.ts + e.dur! });
  }
  sample.runMs = spans.reduce((t, s) => t + (s.end - s.start) / 1000, 0);
  // Lazy compilation: outermost V8 compile events inside our spans, except
  // those within a top-level compile (already counted).
  const topLevel = ours.filter((e) => e.name === 'v8.compile' || e.name === 'v8.compileModule');
  const within = (e: TraceEvent, outer: { tid: number; start: number; end: number }) =>
    e.tid === outer.tid && outer.start <= e.ts && e.ts + e.dur! <= outer.end;
  const compiles = complete
    .filter((e) => e.cat === 'disabled-by-default-v8.compile' && /^V8\.(CompileCode|ParseFunction|CompileIgnition|CompileLazy)$/.test(e.name))
    .sort((a, b) => a.ts - b.ts);
  const coveredUntil = new Map<number, number>();
  for (const e of compiles) {
    if ((coveredUntil.get(e.tid) ?? 0) > e.ts) continue;
    if (!spans.some((s) => within(e, s))) continue;
    coveredUntil.set(e.tid, e.ts + e.dur!);
    if (topLevel.some((t) => within(e, { tid: t.tid, start: t.ts, end: t.ts + t.dur! }))) continue;
    sample.lazyMs += e.dur! / 1000;
  }
}

/**
 * Memory V8 keeps for our scripts' code: everything reachable from their
 * Script objects' function infos (and from our functions' feedback cells)
 * that nothing else retains.
 */
function analyzeHeap(json: string, sample: Sample): void {
  const snap = JSON.parse(json) as {
    snapshot: { meta: { node_fields: string[]; edge_fields: string[]; node_types: [string[]]; edge_types: [string[]] } };
    nodes: number[];
    edges: number[];
    strings: string[];
  };
  const { meta } = snap.snapshot;
  const nf = meta.node_fields.length;
  const ef = meta.edge_fields.length;
  const nodeTypes = meta.node_types[0];
  const edgeTypes = meta.edge_types[0];
  const { nodes, edges, strings } = snap;
  const count = nodes.length / nf;
  const first = new Int32Array(count + 1);
  for (let i = 0, e = 0; i < count; i++) {
    first[i] = e;
    e += nodes[i * nf + 4]! * ef;
  }
  first[count] = edges.length;
  const type = (i: number) => nodeTypes[nodes[i * nf]!]!;
  const name = (i: number) => strings[nodes[i * nf + 1]!]!;
  const size = (i: number) => nodes[i * nf + 3]!;
  const edgeName = (e: number) => {
    const t = edgeTypes[edges[e]!];
    return t === 'element' || t === 'hidden' ? '' : strings[edges[e + 1]!]!;
  };
  const isWeak = (e: number) => edgeTypes[edges[e]!] === 'weak';
  const target = (e: number) => edges[e + 2]! / nf;

  // Retainer counts (strong edges), to tell what only our code holds.
  const retainers = new Uint32Array(count);
  for (let e = 0; e < edges.length; e += ef) if (!isWeak(e)) retainers[target(e)]!++;

  for (let i = 0; i < count; i++) {
    if (type(i) !== 'code' || !name(i).startsWith('system / Script')) continue;
    let url = '';
    let infos = -1;
    for (let e = first[i]!; e < first[i + 1]!; e += ef) {
      if (edgeName(e) === 'name') url = name(target(e));
      if (edgeName(e) === 'infos') infos = target(e);
    }
    if (!OUR_SCRIPT.test(url) || infos < 0) continue;
    const sfis = new Set<number>();
    for (let e = first[infos]!; e < first[infos + 1]!; e += ef) {
      const t = target(e);
      if (name(t).startsWith('system / SharedFunctionInfo')) sfis.add(t);
    }
    // Our closures' feedback (allocated by V8, not under our frames), and the
    // strings in their scopes: literals like the CSS consts, created when compiling.
    const roots = new Set(sfis);
    const contexts = new Set<number>();
    for (let j = 0; j < count; j++) {
      if (type(j) !== 'closure') continue;
      let shared = -1;
      let cell = -1;
      let context = -1;
      for (let e = first[j]!; e < first[j + 1]!; e += ef) {
        const n = edgeName(e);
        if (n === 'shared') shared = target(e);
        else if (n === 'feedback_cell') cell = target(e);
        else if (n === 'context') context = target(e);
      }
      if (!sfis.has(shared)) continue;
      if (cell >= 0) roots.add(cell);
      for (let c = context; c >= 0 && !contexts.has(c) && name(c).startsWith('system / Context'); ) {
        contexts.add(c);
        let previous = -1;
        for (let e = first[c]!; e < first[c + 1]!; e += ef) if (edgeName(e) === 'previous') previous = target(e);
        c = previous;
      }
    }
    const seen = new Set<number>(roots);
    for (const c of contexts) {
      for (let e = first[c]!; e < first[c + 1]!; e += ef) {
        if (edgeTypes[edges[e]!] === 'context' && type(target(e)) === 'string') seen.add(target(e));
      }
    }
    // Everything code-like reachable from there.
    const stack = [...seen];
    while (stack.length) {
      const n = stack.pop()!;
      for (let e = first[n]!; e < first[n + 1]!; e += ef) {
        if (isWeak(e)) continue;
        const t = target(e);
        const tt = type(t);
        if (seen.has(t) || tt === 'native' || tt === 'object' || tt === 'closure' || tt === 'synthetic') continue;
        if (name(t).startsWith('system / Script') || name(t).startsWith('system / Map')) continue;
        if (name(t).startsWith('system / SharedFunctionInfo') && !sfis.has(t)) continue;
        if (name(t).startsWith('system / NativeContext') || name(t).startsWith('system / Context')) continue;
        seen.add(t);
        stack.push(t);
      }
    }
    // Only what is not also held from elsewhere (e.g. shared internalized strings).
    const inSet = new Map<number, number>();
    for (const n of [...seen, ...contexts]) {
      for (let e = first[n]!; e < first[n + 1]!; e += ef) {
        if (!isWeak(e) && seen.has(target(e))) inSet.set(target(e), (inSet.get(target(e)) ?? 0) + 1);
      }
    }
    let bytes = 0;
    const kinds = new Map<string, number>();
    const counted = new Set<number>();
    for (const n of seen) {
      if (!roots.has(n) && (inSet.get(n) ?? 0) < retainers[n]!) continue;
      counted.add(n);
      bytes += size(n);
      if (/^system \/ (InstructionStream|Code|Deoptimization)/.test(name(n))) sample.jitKb += size(n) / 1024;
      const kind = `${type(n)} ${name(n).replace(/^system \/ (\w+).*/, '$1').slice(0, 40)}`;
      kinds.set(kind, (kinds.get(kind) ?? 0) + size(n));
    }
    if (BREAKDOWN) {
      // Per function: its compiled code (bytecode, baseline code, tables), each
      // object charged to the first function that reaches it. Scope infos are shared.
      const functions = new Map<string, number>();
      const claimed = new Set<number>();
      for (const sfi of sfis) {
        let own = size(sfi);
        const todo = [sfi];
        while (todo.length) {
          const n = todo.pop()!;
          for (let e = first[n]!; e < first[n + 1]!; e += ef) {
            const t = target(e);
            if (isWeak(e) || claimed.has(t) || !counted.has(t) || sfis.has(t) || roots.has(t)) continue;
            if (type(t) === 'string' || name(t).startsWith('system / ScopeInfo')) continue;
            claimed.add(t);
            own += size(t);
            todo.push(t);
          }
        }
        const fn = name(sfi).replace(/^system \/ SharedFunctionInfo( \/ )?/, '') || '(anonymous)';
        functions.set(fn, (functions.get(fn) ?? 0) + own);
      }
      console.log(`  ${scriptName(url)}: code memory by kind, then by function (KB)`);
      for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${(v / 1024).toFixed(1).padStart(6)}  ${k}`);
      for (const [k, v] of [...functions].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`    ${(v / 1024).toFixed(1).padStart(6)}  ${k}`);
    }
    const s = (sample.scripts[scriptName(url)] ??= { compileMs: 0, codeKb: 0, sourceKb: 0 });
    s.codeKb += bytes / 1024;
    sample.codeKb += bytes / 1024;
  }
}

async function trace<T>(cdp: CDPSession, body: () => Promise<T>): Promise<[T, TraceEvent[]]> {
  const events: TraceEvent[] = [];
  const onData = (e: { value: object[] }) => events.push(...(e.value as TraceEvent[]));
  cdp.on('Tracing.dataCollected', onData);
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.compile'] },
  });
  const result = await body();
  const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
  await cdp.send('Tracing.end');
  await done;
  cdp.off('Tracing.dataCollected', onData);
  return [result, events];
}

async function openPopover(page: Page): Promise<number> {
  const pill = page.locator('[data-prune-ui="indicator"] >> .pill');
  await page.mouse.move(5, 5);
  await pill.scrollIntoViewIfNeeded();
  const box = (await pill.boundingBox())!;
  const start = Date.now();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(
    () => document.querySelector('[data-prune-ui="indicator"]')?.shadowRoot?.querySelector('.popover:popover-open'),
    undefined,
    { polling: 'raf', timeout: 10_000 },
  );
  const ms = Date.now() - start;
  await page.mouse.move(5, 5);
  return ms;
}

async function measure(scenario: Scenario): Promise<Sample> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const sample: Sample = { compileMs: 0, lazyMs: 0, runMs: 0, codeKb: 0, jitKb: 0, sourceKb: 0, popoverMs: 0, scripts: {} };
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    const sources = new Map<string, number>();
    cdp.on('Debugger.scriptParsed', (e) => {
      if (OUR_SCRIPT.test(e.url)) sources.set(scriptName(e.url), e.length ?? 0);
    });
    await cdp.send('Debugger.enable');
    const [, events] = await trace(cdp, async () => {
      await page.goto(scenario.url, { waitUntil: 'load', timeout: 120_000 });
      if (scenario.softNav) {
        await page.waitForTimeout(1500);
        await page.evaluate((href) => {
          const link = document.createElement('a');
          link.href = href;
          document.body.append(link);
          link.click();
        }, scenario.softNav);
        await page.waitForURL((u) => u.pathname === scenario.softNav, { timeout: 60_000 });
      }
      await page.waitForTimeout(3000);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(1500);
    });
    await cdp.send('Debugger.disable');
    analyzeTrace(events, sample);
    for (const [name, length] of sources) {
      const s = (sample.scripts[name] ??= { compileMs: 0, codeKb: 0, sourceKb: 0 });
      s.sourceKb = length / 1024;
      sample.sourceKb += length / 1024;
    }
    if (HEAP) {
      let json = '';
      const onChunk = (e: { chunk: string }) => (json += e.chunk);
      cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      analyzeHeap(json, sample);
    }
    if (!scenario.idle) sample.popoverMs = await openPopover(page);
  } finally {
    await context.close();
  }
  return sample;
}

const scenarios = SCENARIOS.filter((s) => ONLY.test(s.name));
const results: Record<string, Sample[]> = {};
for (let r = 0; r < RUNS; r++) {
  for (const s of scenarios) (results[s.name] ??= []).push(await measure(s));
}

const fmt = (n: number) => n.toFixed(2).padStart(6);
type Metric = 'compileMs' | 'lazyMs' | 'runMs' | 'codeKb' | 'jitKb' | 'sourceKb' | 'popoverMs';
const metrics: Metric[] = ['compileMs', 'lazyMs', 'runMs', 'codeKb', 'jitKb', 'sourceKb', 'popoverMs'];
console.log(`\n${RUNS} cold runs per scenario (median)\n`);
console.log('scenario                    compile ms   lazy ms   run ms   code KB  (of it JIT)   source KB   popover ms');
const summary: Record<string, unknown> = {};
for (const [name, samples] of Object.entries(results)) {
  const med = (pick: (s: Sample) => number) => samples.map(pick).sort((a, b) => a - b)[samples.length >> 1]!;
  const m = Object.fromEntries(metrics.map((k) => [k, med((s) => s[k])])) as Record<Metric, number>;
  console.log(
    `${name.padEnd(26)}  ${fmt(m.compileMs)}      ${fmt(m.lazyMs)}   ${fmt(m.runMs)}   ${fmt(m.codeKb)}    ${fmt(m.jitKb)}      ${fmt(m.sourceKb)}      ${String(Math.round(m.popoverMs)).padStart(6)}`,
  );
  const names = [...new Set(samples.flatMap((s) => Object.keys(s.scripts)))];
  for (const script of names) {
    const per = (k: 'compileMs' | 'codeKb' | 'sourceKb') => med((s) => s.scripts[script]?.[k] ?? 0);
    console.log(`    ${script.padEnd(22)}  ${fmt(per('compileMs'))}                         ${fmt(per('codeKb'))}                 ${fmt(per('sourceKb'))}`);
  }
  summary[name] = { median: m, samples };
}
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(summary, null, 2));
