/**
 * End-to-end smoke test against live github.com, with the Chromium build
 * loaded as a real extension. Logged out, GitHub serves the React PR header on
 * the conversation tab and the classic "Files changed" view.
 *
 *   bun run build:chrome && bun e2e/run.ts [--headed]
 *
 * Screenshots are written to test-results/.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const root = join(import.meta.dirname, '..');
const extensionPath = join(root, 'dist/chrome');
const outDir = join(root, 'test-results');
const profile = join(root, 'e2e/.profile');
const headed = process.argv.includes('--headed');

// A public Renovate PR that touches pnpm-lock.yaml alongside 37 other files.
const PR = 'https://github.com/vitejs/vite/pull/23648';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

interface Diffstat {
  additions: number | null;
  deletions: number | null;
  files: number | null;
}

async function readHeader(page: Page): Promise<Diffstat> {
  return page.evaluate(() => {
    const num = (t: string | null | undefined) => (t ? Number(t.replace(/\D/g, '')) : null);
    const add = [...document.querySelectorAll('.fgColor-success, .color-fg-success')].find(
      (e) => {
        if (!/^\s*\+[\d.,]+\s*$/.test(e.textContent ?? '')) return false;
        for (let c = e.closest('[id^="diff-"]'); c; c = c.parentElement?.closest('[id^="diff-"]') ?? null) {
          if (/^diff-[0-9a-f]{64}$/.test(c.id)) return false;
        }
        return true;
      },
    );
    const del = add?.nextElementSibling;
    const counter = [...document.querySelectorAll<HTMLAnchorElement>('a[href$="/files"], a[href$="/changes"]')]
      .map((a) => a.querySelector('.Counter, [data-component="CounterLabel"]'))
      .find(Boolean);
    return { additions: num(add?.textContent), deletions: num(del?.textContent), files: num(counter?.textContent) };
  });
}

await rm(profile, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !headed,
  viewport: { width: 1400, height: 1000 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('PRune')) errors.push(msg.text());
  });

  // Ground truth straight from GitHub.
  const tree = (await (
    await page.request.get(`${PR}/page_data/file_tree`, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } })
  ).json()) as { diffs: { path: string; pathDigest: string; linesAdded?: number; linesDeleted?: number }[] };
  const lock = tree.diffs.find((d) => d.path === 'pnpm-lock.yaml')!;
  const total = tree.diffs.reduce(
    (t, d) => ({ additions: t.additions + (d.linesAdded ?? 0), deletions: t.deletions + (d.linesDeleted ?? 0) }),
    { additions: 0, deletions: 0 },
  );
  const expected = {
    additions: total.additions - (lock.linesAdded ?? 0),
    deletions: total.deletions - (lock.linesDeleted ?? 0),
    files: tree.diffs.length - 1,
  };

  // ---- Conversation tab: header counts ------------------------------------
  const t0 = Date.now();
  await page.goto(PR, { waitUntil: 'domcontentloaded' });
  const pill = page.locator('[data-prune-ui="indicator"] >> .pill');
  await pill.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() =>
    document.querySelector('[data-prune-ui="indicator"]')?.shadowRoot?.querySelector('.pill.active'),
  );
  check('indicator appears on conversation tab', true, `${Date.now() - t0} ms after navigation`);
  check('indicator label', (await pill.textContent())?.trim() === '1 pruned', await pill.textContent() ?? '');

  // GitHub may still be hydrating; give the header a moment to settle.
  let header = await readHeader(page);
  for (let i = 0; i < 50 && (header.additions !== expected.additions || header.files === null); i++) {
    await page.waitForTimeout(100);
    header = await readHeader(page);
  }
  check(
    'header line counts exclude pnpm-lock.yaml',
    header.additions === expected.additions && header.deletions === expected.deletions,
    `got +${header.additions} −${header.deletions}, want +${expected.additions} −${expected.deletions}`,
  );
  check('files changed counter excludes it', header.files === expected.files, `got ${header.files}, want ${expected.files}`);

  await pill.hover();
  const popover = page.locator('[data-prune-ui="indicator"] >> .popover');
  await popover.waitFor({ state: 'visible' });
  check('popover lists the lockfile', (await popover.textContent())?.includes('pnpm-lock.yaml') ?? false);
  await page.screenshot({ path: join(outDir, 'conversation-popover.png') });

  // Toggle off from the popover → original numbers come back.
  await page.locator('[data-prune-ui="indicator"] >> .switch').click();
  await page.waitForTimeout(200);
  let off = await readHeader(page);
  for (let i = 0; i < 30 && off.files === null; i++) {
    await page.waitForTimeout(100);
    off = await readHeader(page);
  }
  check(
    'toggling off restores GitHub numbers',
    off.additions === total.additions && off.deletions === total.deletions && off.files === tree.diffs.length,
    `got +${off.additions} −${off.deletions} (${off.files} files)`,
  );
  await page.locator('[data-prune-ui="indicator"] >> .switch').click();
  await page.waitForTimeout(200);
  const on = await readHeader(page);
  check('toggling on again re-applies', on.additions === expected.additions, `got +${on.additions}`);
  await page.mouse.move(10, 900);

  // ---- Files tab (soft navigation via the tab link) -------------------------
  await page.locator(`a[href$="/pull/23648/files"]`).first().click();
  await page.waitForURL(/\/files/);
  const lockDiff = page.locator(`#diff-${lock.pathDigest}`);
  await lockDiff.waitFor({ state: 'attached', timeout: 30_000 });
  const section = page.locator('[data-prune-ui="section"]');
  await section.waitFor({ timeout: 20_000 });
  check('pruned diff is hidden', !(await lockDiff.isVisible()));
  check(
    'pruned file hidden in file tree',
    !(await page.locator(`#file-tree-item-diff-${lock.pathDigest}`).isVisible()),
  );
  // Its rows are built once it comes near the viewport.
  await section.scrollIntoViewIfNeeded();
  await section.locator('.item').first().waitFor({ timeout: 5_000 }).catch(() => {});
  check('"Pruned files" section lists it', (await section.locator('.box').textContent())?.includes('pnpm-lock.yaml') ?? false);
  const filesHeader = await readHeader(page);
  check(
    'files tab header counts are pruned too',
    filesHeader.additions === expected.additions && filesHeader.files === expected.files,
    `got +${filesHeader.additions} (${filesHeader.files} files)`,
  );
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: join(outDir, 'files-section.png') });

  await section.locator('.item .btn').first().click();
  await page.waitForTimeout(300);
  check('"Show diff" reveals the file in place', await lockDiff.isVisible());
  await page.screenshot({ path: join(outDir, 'files-revealed.png') });

  // ---- Back to conversation (soft navigation) ---------------------------------
  await page.goBack();
  await page.waitForURL((u) => !u.pathname.endsWith('/files'));
  await page.waitForTimeout(1500);
  const back = await readHeader(page);
  check('header stays pruned after navigating back', back.additions === expected.additions, `got +${back.additions}`);

  // ---- Repo page → PR (soft navigation) ----------------------------------------
  // PRune does nothing PR-specific on other pages (no settings, no UI) until a
  // PR is opened in the same document.
  await page.goto('https://github.com/vitejs/vite', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('no indicator on a non-PR page', (await page.locator('[data-prune-ui]').count()) === 0);
  await page.evaluate((href) => {
    (window as { pruneE2eMarker?: boolean }).pruneE2eMarker = true;
    const link = document.createElement('a');
    link.href = href;
    link.textContent = 'PR';
    document.body.append(link);
    link.click();
  }, new URL(PR).pathname);
  await page.waitForURL(/\/pull\/23648$/);
  const soft = await page.evaluate(() => (window as { pruneE2eMarker?: boolean }).pruneE2eMarker === true);
  await page.waitForFunction(
    () => document.querySelector('[data-prune-ui="indicator"]')?.shadowRoot?.querySelector('.pill.active'),
    undefined,
    { timeout: 20_000 },
  );
  let fromRepo = await readHeader(page);
  for (let i = 0; i < 50 && fromRepo.additions !== expected.additions; i++) {
    await page.waitForTimeout(100);
    fromRepo = await readHeader(page);
  }
  check(
    `PR opened from a repo page is pruned (${soft ? 'soft' : 'full'} navigation)`,
    fromRepo.additions === expected.additions,
    `got +${fromRepo.additions}`,
  );

  check('no PRune errors in console', errors.length === 0, errors.join('; '));
} finally {
  await context.close();
}

console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
