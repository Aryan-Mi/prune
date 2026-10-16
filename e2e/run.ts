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

/**
 * Plays a React re-render of the header diffstat in the page, with GitHub's
 * own numbers (`additions`, `deletions`): `write` writes them into the
 * existing text nodes, `text` replaces those nodes, `element` replaces the
 * whole diffstat. Resolves with the additions shown one microtask later
 * (`write`: patching must happen before the page paints).
 */
async function rerenderHeader(page: Page, how: 'write' | 'text' | 'element', additions: number, deletions: number): Promise<string> {
  return page.evaluate(
    async ({ how, additions, deletions }) => {
      const add = [...document.querySelectorAll('.fgColor-success, .color-fg-success')].find(
        (e) =>
          /^\s*\+[\d.,]+\s*$/.test(e.textContent ?? '') &&
          /danger/.test(e.nextElementSibling?.className ?? '') &&
          !e.closest('[id^="diff-"]:not(#diff-comparison-viewer-container)'),
      )!;
      const del = add.nextElementSibling!;
      const numberText = (el: Element) => [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.nodeValue ?? '')) as Text;
      const github = (node: Text, value: number) => (node.nodeValue ?? '').replace(/[\d.,]+/, value.toLocaleString('en-US'));
      if (how === 'element') {
        const box = add.parentElement!;
        const copy = box.cloneNode(true) as Element;
        copy.querySelectorAll('[data-prune-ui]').forEach((e) => e.remove());
        const [a, d] = [copy.children[[...box.children].indexOf(add)]!, copy.children[[...box.children].indexOf(del)]!];
        numberText(a).nodeValue = github(numberText(a), additions);
        numberText(d).nodeValue = github(numberText(d), deletions);
        box.replaceWith(copy);
        return '';
      }
      for (const [el, value] of [[add, additions], [del, deletions]] as const) {
        const node = numberText(el);
        if (how === 'write') node.nodeValue = github(node, value);
        else node.replaceWith(document.createTextNode(github(node, value)));
      }
      await Promise.resolve();
      return add.textContent ?? '';
    },
    { how, additions, deletions },
  );
}

/** Re-renders the header in each way and checks PRune patches it again (and keeps the pill next to it). */
async function rerenderHeaderChecks(page: Page, where: string, total: Diffstat, expected: Diffstat): Promise<void> {
  const until = async (want: number | null) => {
    let h = await readHeader(page);
    for (let i = 0; i < 20 && h.additions !== want; i++) {
      await page.waitForTimeout(100);
      h = await readHeader(page);
    }
    return h;
  };
  const written = await rerenderHeader(page, 'write', total.additions!, total.deletions!);
  check(
    `${where}: GitHub's number written back is re-patched before the next paint`,
    written.trim() === `+${expected.additions!.toLocaleString('en-US')}`,
    `got ${written.trim()}`,
  );
  const counter = await page.evaluate(async (files) => {
    const el = [...document.querySelectorAll('a[href$="/files"], a[href$="/changes"]')]
      .map((a) => a.querySelector('.Counter, [data-component="CounterLabel"]'))
      .find(Boolean)!;
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.nodeValue ?? ''))!;
    node.nodeValue = String(files);
    await Promise.resolve();
    return el.textContent;
  }, total.files);
  check(`${where}: same for the files counter`, Number(counter?.replace(/\D/g, '')) === expected.files, `got ${counter}`);
  await rerenderHeader(page, 'text', total.additions!, total.deletions!);
  const text = await until(expected.additions);
  check(
    `${where}: replaced text nodes are patched again`,
    text.additions === expected.additions && text.deletions === expected.deletions,
    `got +${text.additions} −${text.deletions}`,
  );
  await rerenderHeader(page, 'element', total.additions!, total.deletions!);
  const element = await until(expected.additions);
  const pill = await page.evaluate(() => {
    const host = document.querySelector('[data-prune-ui="indicator"]');
    return !!host?.isConnected && !host.classList.contains('floating') && !!host.parentElement?.querySelector('.fgColor-success, .color-fg-success');
  });
  check(
    `${where}: a replaced diffstat is patched again, pill next to it`,
    element.additions === expected.additions && element.deletions === expected.deletions && pill,
    `got +${element.additions} −${element.deletions}, pill ${pill ? 'next to it' : 'elsewhere'}`,
  );
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

  // The popover is a chunk of its own: the focus event waits for it to be imported.
  const popover = page.locator('[data-prune-ui="indicator"] >> .popover');
  await pill.focus();
  const focused = await popover.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
  check('focusing the pill opens the popover', focused);
  await page.keyboard.press('Escape');
  check('Escape closes it', await popover.waitFor({ state: 'hidden', timeout: 5_000 }).then(() => true, () => false));

  await pill.hover();
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

  // ---- React re-rendering the header ----------------------------------------------
  // Once the page has settled, PRune only watches the header and its own nodes.
  await page.waitForTimeout(1000);
  const github = { ...total, files: tree.diffs.length };
  await rerenderHeaderChecks(page, 'conversation tab', github, expected);

  // ---- Files tab (soft navigation via the tab link) -------------------------
  await page.locator(`a[href$="/pull/23648/files"]`).first().click();
  await page.waitForURL(/\/files/);
  const lockDiff = page.locator(`#diff-${lock.pathDigest}`);
  await lockDiff.waitFor({ state: 'attached', timeout: 30_000 });
  const section = page.locator('[data-prune-ui="section"]');
  // Attached right away, but empty until it comes near the viewport.
  await section.waitFor({ state: 'attached', timeout: 20_000 });
  check('pruned diff is hidden', !(await lockDiff.isVisible()));
  check(
    'pruned file hidden in file tree',
    !(await page.locator(`#file-tree-item-diff-${lock.pathDigest}`).isVisible()),
  );
  // Its rows are built once it comes near the viewport.
  await section.scrollIntoViewIfNeeded();
  await section.locator('.item').first().waitFor({ timeout: 5_000 }).catch(() => {});
  check('"Pruned files" section lists it', (await section.locator('.box').textContent())?.includes('pnpm-lock.yaml') ?? false);
  const diffsAfter = await page.evaluate(() => {
    const host = document.querySelector('[data-prune-ui="section"]')!;
    return [...document.querySelectorAll('[id^="diff-"]')].filter(
      (d) => /^diff-[0-9a-f]{64}$/.test(d.id) && host.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).length;
  });
  check('section comes after all diffs', diffsAfter === 0, `${diffsAfter} diffs after it`);
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
  check(
    'its file tree row is back too',
    await page.locator(`#file-tree-item-diff-${lock.pathDigest}`).isVisible(),
  );
  await page.screenshot({ path: join(outDir, 'files-revealed.png') });
  // GitHub re-rendering the diff (a new element, without PRune's mark) keeps it revealed.
  await page.evaluate((id) => {
    const diff = document.getElementById(id)!;
    const copy = diff.cloneNode(true) as Element;
    copy.removeAttribute('data-prune-show');
    diff.replaceWith(copy);
  }, `diff-${lock.pathDigest}`);
  await page.waitForTimeout(500);
  check('a re-rendered revealed diff stays revealed', await lockDiff.isVisible());
  await section.locator('.item .btn').first().click();
  await page.waitForTimeout(300);
  check('"Hide diff" hides it again', !(await lockDiff.isVisible()));
  // The per-PR switch on this tab.
  await pill.hover();
  const lazyBody = () =>
    page.evaluate((id) => {
      const diff = document.getElementById(id)!;
      return getComputedStyle(diff.querySelector('.js-file-content') ?? diff).contentVisibility;
    }, `diff-${lock.pathDigest}`);
  check('pruned diffs are set to render lazily when shown', (await lazyBody()) === 'auto');
  await page.locator('[data-prune-ui="indicator"] >> .switch').click();
  await page.waitForTimeout(300);
  check('switching off on the files tab shows the diff', await lockDiff.isVisible());
  check('…and has it render fully right after', (await lazyBody()) === 'visible');
  await page.locator('[data-prune-ui="indicator"] >> .switch').click();
  await page.waitForTimeout(300);
  check('switching on hides it again', !(await lockDiff.isVisible()));
  await page.mouse.move(10, 900);

  // More content after the diffs (GitHub rendering more of them) → the section moves back to the end, before the next paint.
  const sectionLast = await page.evaluate(async () => {
    const host = document.querySelector('[data-prune-ui="section"]')!;
    const more = document.createElement('div');
    host.parentElement!.append(more);
    await Promise.resolve();
    const last = !host.nextElementSibling;
    more.remove();
    return last;
  });
  check('section moves back right away after diffs added after it', sectionLast);
  await rerenderHeaderChecks(page, 'files tab', github, expected);

  // ---- Back to conversation (soft navigation) ---------------------------------
  await page.goBack();
  await page.waitForURL((u) => !u.pathname.endsWith('/files'));
  await page.waitForTimeout(1500);
  const back = await readHeader(page);
  check('header stays pruned after navigating back', back.additions === expected.additions, `got +${back.additions}`);

  // ---- Reloads: the background script's stored results ----------------------------
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const storedKey = '|vitejs/vite#23648';
  type Ext = { chrome: typeof browser };
  const index = await worker.evaluate(async () => {
    const stored = await (globalThis as unknown as Ext).chrome.storage.session.get('results');
    return stored.results as Record<string, unknown> | undefined;
  });
  check('background script stored the result', !!index?.[storedKey], Object.keys(index ?? {}).join(', '));
  // Below 3000 files the list adds up to GitHub's totals: the page requests only the list.
  // (GitHub's own UI requests diffstat and tab_counts too, with headers of its own.)
  const pageRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/page_data/') && !req.headers()['github-verified-fetch']) {
      pageRequests.push(new URL(req.url()).pathname);
    }
  });
  const reloadedHeader = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('[data-prune-ui="indicator"]')?.shadowRoot?.querySelector('.pill.active'),
      undefined,
      { timeout: 20_000 },
    );
    let h = await readHeader(page);
    for (let i = 0; i < 50 && h.additions !== expected.additions; i++) {
      await page.waitForTimeout(100);
      h = await readHeader(page);
    }
    return h;
  };
  const reloaded = await reloadedHeader();
  check('pruned on reload (stored result)', reloaded.additions === expected.additions, `got +${reloaded.additions}`);
  const ours = pageRequests.filter((p) => /\/page_data\/(file_tree|diffstat|tab_counts)$/.test(p));
  check('the page requests the file list only', ours.join() === '/vitejs/vite/pull/23648/page_data/file_tree', ours.join(', '));
  // The result is gone but its ETag is still indexed: the content script must send the list after all.
  await worker.evaluate(
    (key) => (globalThis as unknown as Ext).chrome.storage.session.remove(`result:${key}`),
    storedKey,
  );
  const refetched = await reloadedHeader();
  check(
    'pruned on reload when the stored result is gone',
    refetched.additions === expected.additions,
    `got +${refetched.additions}`,
  );

  // ---- Revisits are pre-rendered: pruned from the first frame -----------------------
  // In a tab of its own, which follows what each frame shows (right before it is drawn).
  const framesOf = async (url: string) => {
    const tab = await context.newPage();
    await tab.addInitScript((digest) => {
      const rec = { shown: [] as string[], diffFrames: 0 };
      (window as unknown as { __frames: typeof rec }).__frames = rec;
      const text = (el: Element) => (el.getAttribute('data-prune-kept') ?? el.textContent ?? '').replace(/\D/g, '');
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;top:0;width:1px;height:1px;visibility:hidden';
      const resize = () => {
        if (!box.isConnected) document.documentElement.append(box);
        box.style.width = box.style.width === '1px' ? '2px' : '1px';
        requestAnimationFrame(resize);
      };
      requestAnimationFrame(resize);
      new ResizeObserver(() => {
        const del = document.querySelector('#diffstat > .color-fg-danger, [data-component="PH_Navigation"] .fgColor-danger');
        const add = del?.previousElementSibling;
        if (add && del) rec.shown.push(`${text(add)} ${text(del)}`);
        const diff = document.getElementById(`diff-${digest}`);
        if (diff && getComputedStyle(diff).display !== 'none') rec.diffFrames++;
      }).observe(box);
    }, lock.pathDigest);
    await tab.goto(url, { waitUntil: 'load' });
    await tab.waitForFunction(
      () => document.querySelector('[data-prune-ui="indicator"]')?.shadowRoot?.querySelector('.pill.active'),
      undefined,
      { timeout: 20_000 },
    );
    await tab.waitForTimeout(500);
    const frames = await tab.evaluate(() => (window as unknown as { __frames: { shown: string[]; diffFrames: number } }).__frames);
    await tab.close();
    return frames;
  };
  const pruned = `${expected.additions} ${expected.deletions}`;
  const convFrames = await framesOf(PR);
  check(
    'revisit: the header shows the pruned numbers from its first frame',
    convFrames.shown.length > 0 && convFrames.shown.every((s) => s === pruned),
    `${convFrames.shown.filter((s) => s !== pruned).length} of ${convFrames.shown.length} frames showed others (${[...new Set(convFrames.shown)].join(', ')})`,
  );
  const filesFrames = await framesOf(`${PR}/files`);
  check(
    'revisit: the files tab too, and never shows the pruned diff',
    filesFrames.shown.length > 0 && filesFrames.shown.every((s) => s === pruned) && filesFrames.diffFrames === 0,
    `numbers ${[...new Set(filesFrames.shown)].join(', ')}; pruned diff shown in ${filesFrames.diffFrames} frame(s)`,
  );
  const storedKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('prune:')).sort());
  check('the pre-render is stored under the PR', storedKeys.join() === 'prune:index,prune:vitejs/vite#23648', storedKeys.join(', '));

  // ---- Per-tab toggle and settings changes (kept and pushed by the background script) ----
  const readUntil = async (want: number | null) => {
    let h = await readHeader(page);
    for (let i = 0; i < 50 && h.additions !== want; i++) {
      await page.waitForTimeout(100);
      h = await readHeader(page);
    }
    return h;
  };
  await pill.hover();
  await page.locator('[data-prune-ui="indicator"] >> .switch').click();
  await page.mouse.move(10, 900);
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pill.waitFor({ timeout: 20_000 });
  const stillOff = await readUntil(total.additions);
  check('switched off stays off on reload', stillOff.additions === total.additions, `got +${stillOff.additions}`);
  const offStored = await page.evaluate(() => localStorage.getItem('prune:vitejs/vite#23648'));
  check('…and is not pre-rendered', offStored === null, offStored ?? '');
  await pill.hover();
  await page.locator('[data-prune-ui="indicator"] >> .switch').click();
  await page.mouse.move(10, 900);
  const backOn = await readUntil(expected.additions);
  check('switched back on', backOn.additions === expected.additions, `got +${backOn.additions}`);
  const setSettings = (settings: object) =>
    worker.evaluate((s) => (globalThis as unknown as Ext).chrome.storage.local.set({ settings: s }), settings);
  await setSettings({ disabledGroups: ['lockfiles'] });
  const unpruned = await readUntil(total.additions);
  check('settings changes reach the page', unpruned.additions === total.additions, `got +${unpruned.additions}`);
  await setSettings({});
  const repruned = await readUntil(expected.additions);
  check('…and back', repruned.additions === expected.additions, `got +${repruned.additions}`);

  // ---- Collapse mode (a chunk of its own, imported when the setting is on) ------
  await setSettings({ diffMode: 'collapse' });
  await page.goto(`${PR}/files`, { waitUntil: 'domcontentloaded' });
  await lockDiff.waitFor({ state: 'attached', timeout: 30_000 });
  const collapsed = await page
    .waitForFunction(
      (id) =>
        !!document
          .getElementById(id)
          ?.querySelector('button[aria-label="Expand file"], .file-header .js-details-target[aria-expanded="false"]'),
      `diff-${lock.pathDigest}`,
      { timeout: 20_000 },
    )
    .then(() => true, () => false);
  check('collapse mode collapses the pruned diff', collapsed && (await lockDiff.isVisible()));
  check('…and lists no "Pruned files" section', (await page.locator('[data-prune-ui="section"]').count()) === 0);
  await setSettings({});

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

  // ---- And back and forth (history traversal) -----------------------------------
  // Off PR pages the full script only follows navigations, without observing the page.
  await page.goBack();
  await page.waitForURL((u) => u.pathname === '/vitejs/vite');
  await page.waitForTimeout(1000);
  check('indicator leaves with the PR', !(await page.locator('[data-prune-ui="indicator"]').isVisible()));
  await page.goForward();
  await page.waitForURL(/\/pull\/23648$/);
  let forward = await readHeader(page);
  for (let i = 0; i < 50 && forward.additions !== expected.additions; i++) {
    await page.waitForTimeout(100);
    forward = await readHeader(page);
  }
  check('PR is pruned again after going forward', forward.additions === expected.additions, `got +${forward.additions}`);

  check('no PRune errors in console', errors.length === 0, errors.join('; '));
} finally {
  await context.close();
}

console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
