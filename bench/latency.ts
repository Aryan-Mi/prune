/**
 * How long after GitHub's responses arrive the pruned numbers show up, in
 * Chromium with the extension loaded. Each run uses a fresh browser, so the
 * extension's service worker starts cold, as on a first PR visit.
 *
 *   node bench/latency.ts [--runs=5] [--extension=dist/chrome] [--pr=<url>]
 *
 * "after data" is from the last of PRune's GitHub requests (file_tree,
 * diffstat, tab_counts) finishing to the ✂ pill switching on; "after
 * navigation" is from the start of the navigation.
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

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const afterData: number[] = [];
const afterNav: number[] = [];

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
    const start = Date.now();
    await page.goto(pr, { waitUntil: 'commit' });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-prune-ui="indicator"]')
          ?.shadowRoot?.querySelector('.pill.active')
          ?.textContent?.includes('pruned'),
      undefined,
      { polling: 'raf', timeout: 30_000 },
    );
    const shownAt = Date.now();
    afterData.push(shownAt - dataAt);
    afterNav.push(shownAt - start);
    console.log(`run ${run + 1}: ${shownAt - dataAt} ms after data, ${shownAt - start} ms after navigation`);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

console.log(`\nmedian: ${median(afterData)} ms after data, ${median(afterNav)} ms after navigation`);
