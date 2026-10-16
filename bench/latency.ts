/**
 * How long after GitHub's responses arrive the pruned numbers show up, in
 * Chromium with the extension loaded. Each run uses a fresh browser, so the
 * extension's service worker starts cold, as on a first PR visit. With
 * --revisit, the PR is opened once first and the second visit is measured
 * (the background script then has the file list, and GitHub answers 304; the
 * page has PRune's pre-render of the PR).
 *
 *   node bench/latency.ts [--runs=5] [--extension=dist/chrome] [--pr=<url>]
 *     [--from=<url>] [--revisit]
 *
 * "after data" is from the last of PRune's GitHub requests (file_tree,
 * diffstat, tab_counts) finishing to the ✂ pill switching on; "after
 * navigation" is from the start of the navigation. With --from, the PR is
 * opened from that page by GitHub's soft navigation (a link click) instead of
 * a page load.
 *
 * What the page shows is followed frame by frame (in the page, right before
 * each frame is drawn): "numbers" is when the header's
 * diffstat first showed the pruned numbers, "flash" how many frames showed
 * GitHub's numbers before that. With --revisit, "diffs" counts the frames in
 * which a pruned file's diff (or file tree row) was rendered and displayed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const root = join(import.meta.dirname, '..');
const extensionPath = resolve(root, arg('extension', 'dist/chrome'));
const runs = Number(arg('runs', '5'));
const pr = arg('pr', 'https://github.com/nodejs/node/pull/65161');
const from = arg('from', '');
const revisit = process.argv.includes('--revisit');

interface Probe {
  /** Distinct header diffstats shown, in order, with the time they first showed (ms since the navigation). */
  shown: [string, number][];
  /** Frames per value shown. */
  frames: Record<string, number>;
  /** Frames in which a pruned diff or tree row was displayed. */
  diffFrames: number;
  start: number;
}

/** Runs in the page (main world) from document start: what each frame shows. */
function probe(digests: string[]): void {
  const rec: Probe = { shown: [], frames: {}, diffFrames: 0, start: 0 };
  (window as unknown as { __probe: Probe }).__probe = rec;
  const text = (el: Element) => (el.getAttribute('data-prune-kept') ?? el.textContent ?? '').trim();
  // Sampled from a ResizeObserver, whose callbacks run after every requestAnimationFrame
  // callback (PRune's included) and layout, right before the frame is drawn: an element
  // of the probe's own changes size every frame.
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:0;left:0;height:1px;width:1px;visibility:hidden;pointer-events:none';
  let wide = false;
  const resize = () => {
    if (!box.isConnected) document.documentElement.append(box);
    wide = !wide;
    box.style.width = wide ? '2px' : '1px';
    requestAnimationFrame(resize);
  };
  requestAnimationFrame(resize);
  const sample = () => {
    const del = [...document.querySelectorAll('#diffstat > .color-fg-danger, [data-component="PH_Navigation"] .fgColor-danger')][0];
    const add = del?.previousElementSibling;
    if (del && add) {
      const value = `${text(add)} ${text(del)}`;
      if (rec.shown.at(-1)?.[0] !== value) rec.shown.push([value, performance.now() - rec.start]);
      rec.frames[value] = (rec.frames[value] ?? 0) + 1;
    }
    for (const d of digests) {
      const el = document.getElementById(`diff-${d}`) ?? document.getElementById(`file-tree-item-diff-${d}`);
      if (el && getComputedStyle(el).display !== 'none') {
        rec.diffFrames++;
        break;
      }
    }
  };
  new ResizeObserver(sample).observe(box);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const afterData: number[] = [];
const afterNav: number[] = [];
const numbersAt: number[] = [];
const flashes: number[] = [];
const diffFlashes: number[] = [];

for (let run = 0; run < runs; run++) {
  const profile = await mkdtemp(join(tmpdir(), 'prune-latency-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    let dataAt = 0;
    page.on('requestfinished', (req) => {
      if (/\/page_data\/(file_tree|diffstat|tab_counts)$/.test(req.url())) dataAt = Date.now();
    });
    const shown = () =>
      page.waitForFunction(
        () =>
          document
            .querySelector('[data-prune-ui="indicator"]')
            ?.shadowRoot?.querySelector('.pill.active')
            ?.textContent?.includes('pruned'),
        undefined,
        { polling: 'raf', timeout: 30_000 },
      );
    let digests: string[] = [];
    if (revisit) {
      await page.goto(pr, { waitUntil: 'commit' });
      await shown();
      await page.waitForTimeout(1500);
      digests = await page.evaluate(() =>
        [...(document.getElementById('prune-style')?.textContent ?? '').matchAll(/#diff-([0-9a-f]{64})/g)].map((m) => m[1]!),
      );
      await page.goto('about:blank');
    }
    await page.addInitScript(probe, digests);
    if (from) await page.goto(from, { waitUntil: 'load' });
    const start = Date.now();
    if (from) {
      await page.evaluate((href) => {
        (window as unknown as { __probe: Probe }).__probe.start = performance.now();
        const link = document.createElement('a');
        link.href = href;
        document.body.append(link);
        link.click();
      }, new URL(pr).pathname);
    } else {
      await page.goto(pr, { waitUntil: 'commit' });
    }
    await shown();
    const shownAt = Date.now();
    await page.waitForTimeout(1000);
    const rec = await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
    // The pruned numbers are what the header ends up showing.
    const final = rec.shown.at(-1);
    const firstPruned = rec.shown.find(([v]) => v === final?.[0]);
    const flash = rec.shown.filter(([v]) => v !== final?.[0]).reduce((n, [v]) => n + (rec.frames[v] ?? 0), 0);
    afterData.push(shownAt - dataAt);
    afterNav.push(shownAt - start);
    numbersAt.push(firstPruned?.[1] ?? NaN);
    flashes.push(flash);
    diffFlashes.push(rec.diffFrames);
    console.log(
      `run ${run + 1}: ${shownAt - dataAt} ms after data, ${shownAt - start} ms after navigation; ` +
        `numbers at ${firstPruned?.[1].toFixed(0)} ms, ${flash} frame(s) of GitHub's numbers ${JSON.stringify(rec.shown.map(([v]) => v))}` +
        (revisit ? `; ${rec.diffFrames} frame(s) with pruned diffs shown (${digests.length} pruned)` : ''),
    );
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

console.log(
  `\nmedian: ${median(afterData)} ms after data, ${median(afterNav)} ms after navigation; ` +
    `numbers at ${median(numbersAt).toFixed(0)} ms, ${median(flashes)} flash frame(s)` +
    (revisit ? `, ${median(diffFlashes)} frame(s) with pruned diffs` : ''),
);
