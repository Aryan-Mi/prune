import { ext } from '../shared/browser.ts';
import type { Lookup, Message, RepoConfig, TabStatus } from '../shared/messages.ts';
import type { PrFile, PrTotals } from '../shared/filetree.ts';
import type { PruneResult } from '../shared/prune.ts';
import { isRepoDisabled, loadSettings, onConfigChanged, rulesKey, type Settings } from '../shared/settings.ts';
import { Collapser } from './dom/collapse.ts';
import { CountPatcher } from './dom/counts.ts';
import { BulkRegions } from './dom/regions.ts';
import { PruneStyles } from './dom/styles.ts';
import { fetchFileTree, fetchPrTotals, fetchRepoConfig, parsePrUrl, type PrRef } from './github.ts';
import { Indicator } from './ui/indicator.ts';
import { PrunedSection } from './ui/section.ts';
import type { UiActions, ViewState, ViewStatus } from './ui/types.ts';

/** A PR's result is reused across tab switches for this long before refetching. */
const PR_DATA_TTL_MS = 60_000;
/** Minimum gap between DOM checks while the page is mutating. */
const CHECK_INTERVAL_MS = 100;
/** Minimum gap between full rescans for new header counters (e.g. sticky headers). */
const RESCAN_INTERVAL_MS = 1000;
/** Rescan gap while some header counter has not been found yet (page still rendering). */
const INCOMPLETE_RESCAN_MS = 250;
const INACTIVE_KEY = 'prune:inactive';

interface PrData {
  /** The PR this data belongs to. */
  key: string;
  result: PruneResult;
  repoConfigPath: string | null;
}

/** GitHub's responses for a PR, on their way to the background script. */
interface PrResponses {
  /** The file_tree response, body unread. */
  fileTree: Response;
  /** ETag of the file list the background script has stored for this PR. */
  storedEtag: string | null;
  totals: Partial<PrTotals>;
  repo: RepoConfig;
  repoFetched: boolean;
}

interface CacheEntry<T> {
  promise: Promise<T>;
  at: number;
}

class Controller implements UiActions {
  /** Loaded on the first PR page, so the rest of GitHub doesn't pay for it. */
  private settings!: Settings;
  private configured = false;
  private configuring = false;
  private pr: PrRef | null = null;
  private href = '';

  private status: ViewStatus = 'loading';
  private error: string | undefined;
  private data: PrData | null = null;

  private readonly prCache = new Map<string, CacheEntry<PrData>>();
  /** Responses fetched while settings were still loading. */
  private prefetched: { key: string; promise: Promise<PrResponses> } | null = null;
  private readonly revealed = new Map<string, Set<string>>();
  /** PRs switched off in this tab; read from sessionStorage on first use (it costs ~1 ms). */
  private inactiveKeys: Set<string> | null = null;
  private loadToken = 0;

  private readonly styles = new PruneStyles();
  private readonly counts = new CountPatcher();
  private readonly regions = new BulkRegions();
  private readonly collapser = new Collapser();
  // Created on the first PR page, dropped when leaving PR pages.
  private indicator: Indicator | null = null;
  private section: PrunedSection | null = null;
  private sectionContainer: Element | null = null;

  private readonly observer = new MutationObserver(() => this.onMutation());
  private checkTimer = 0;
  private retryTimer = 0;
  private lastCheck = 0;
  private lastRescan = 0;
  private lastLocate = 0;

  start(): void {
    ext.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
      if (msg.type === 'get-status') {
        sendResponse(this.tabStatus());
      } else if (msg.type === 'set-active') {
        this.setActive(msg.active);
        sendResponse(this.tabStatus());
      }
      return undefined;
    });

    // One observer for the whole page; the callback only schedules a check (and
    // pauses itself until then), so its cost is constant no matter how many
    // nodes GitHub adds.
    this.observe();
    window.addEventListener('popstate', () => this.scheduleCheck());
    // Back/forward-cache restores bring back a frozen DOM without mutations.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) this.href = '';
      this.scheduleCheck();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scheduleCheck();
    });
    document.addEventListener('turbo:load', () => this.scheduleCheck());
    window.addEventListener('load', () => this.scheduleCheck());
    (globalThis as { navigation?: EventTarget }).navigation?.addEventListener('navigatesuccess', () =>
      this.scheduleCheck(),
    );
    this.check();
  }

  /** Loads settings once, then handles the current page again. */
  private configure(): void {
    if (this.configuring) return;
    this.configuring = true;
    loadSettings()
      .then((settings) => {
        this.settings = settings;
        this.configured = true;
        onConfigChanged(async (remoteChanged) => {
          const rules = rulesKey(this.settings);
          this.settings = await loadSettings();
          if (remoteChanged || rulesKey(this.settings) !== rules) {
            // Results are only kept for the pruned files, so prune again from scratch.
            this.prCache.clear();
            if (this.pr) this.load(this.pr);
            return;
          }
          this.render();
        });
        this.href = '';
        this.check();
      })
      .catch((err: unknown) => console.error('[PRune]', err));
  }

  // ---- Scheduling -------------------------------------------------------

  private observe(): void {
    // The document itself: at document_start <html> may not exist yet.
    this.observer.observe(document, { childList: true, subtree: true });
  }

  private onMutation(): void {
    // A navigation: handle it right away, before the new page is painted.
    if (location.href !== this.href) this.check();
    else this.scheduleCheck();
  }

  private scheduleCheck(): void {
    if (this.checkTimer) return;
    // Until the check runs, further mutations would change nothing, so don't
    // have the browser record them (a big PR page makes thousands).
    this.observer.disconnect();
    const wait = Math.max(0, CHECK_INTERVAL_MS - (performance.now() - this.lastCheck));
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = 0;
      this.check();
    }, wait);
  }

  /**
   * Runs after DOM mutations. Must stay cheap: it does no work when nothing
   * changed. While the header is still incomplete (GitHub renders it in
   * pieces), one trailing retry is queued so the last mutation is never missed.
   */
  private check(fromMutation = true): void {
    this.lastCheck = performance.now();
    this.observe();
    if (location.href !== this.href) {
      this.href = location.href;
      this.onLocationChange();
      return;
    }
    if (!this.pr || !this.isEnabledHere()) return;
    this.styles.ensure();
    if (this.isPruning()) {
      const now = performance.now();
      const intact = this.counts.isIntact();
      const complete = intact && this.counts.isComplete();
      const interval = complete ? RESCAN_INTERVAL_MS : INCOMPLETE_RESCAN_MS;
      const since = now - this.lastRescan;
      if (!intact || since >= interval) {
        this.lastRescan = now;
        this.applyCounts();
      } else if (!complete && fromMutation) {
        this.scheduleRetry(interval - since);
      }
      if (this.settings.diffMode === 'collapse') this.collapser.run();
    }
    this.mountUi(fromMutation);
  }

  private scheduleRetry(delay: number): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.check(false), delay + 10);
  }

  private onLocationChange(): void {
    const pr = parsePrUrl(location.pathname);
    if (pr && !this.configured) {
      // GitHub's responses don't depend on settings: fetch them while they load.
      this.prefetched = { key: pr.key, promise: this.fetchPr(pr) };
      this.prefetched.promise.catch(() => {});
      this.configure();
      return;
    }
    const prev = this.pr;
    this.pr = pr;
    if (!pr) {
      this.teardown();
      this.release();
      return;
    }
    if (prev?.key !== pr.key) {
      this.teardown();
      this.sectionContainer = null;
      this.regions.reset();
      this.load(pr);
    } else {
      // Same PR, different tab: refresh if the data is getting old.
      const cached = this.prCache.get(pr.key);
      if (!cached || Date.now() - cached.at > PR_DATA_TTL_MS) this.load(pr);
      this.sectionContainer = null;
      this.regions.reset();
      this.revealFromHash();
      this.render();
    }
  }

  // ---- Data -------------------------------------------------------------

  private load(pr: PrRef): void {
    const token = ++this.loadToken;
    // Keep showing this PR's current result while it refreshes, but never another PR's.
    if (this.data?.key !== pr.key) {
      this.status = 'loading';
      this.data = null;
    }
    this.render();

    this.prData(pr)
      .then((data) => {
        if (token !== this.loadToken) return;
        this.data = data;
        this.status = 'ready';
        this.error = undefined;
        this.revealFromHash();
        this.render();
      })
      .catch((err: unknown) => {
        if (token !== this.loadToken) return;
        this.status = 'error';
        this.error = err instanceof Error ? err.message : String(err);
        this.render();
      });
  }

  /**
   * Fetches the PR's file list here (same-origin, so private repos work) and
   * has the background script parse and prune it. On a 3000-file PR that is a
   * 700 KB JSON response; the page never parses it or keeps any of it, and
   * gets back only the pruned files. If the background script already has
   * this exact list (from an earlier visit; GitHub's ETag says so), the
   * response isn't even read, let alone passed along.
   */
  private prData(pr: PrRef): Promise<PrData> {
    let entry = this.prCache.get(pr.key);
    if (!entry || Date.now() - entry.at > PR_DATA_TTL_MS) {
      const prefetched = this.prefetched?.key === pr.key ? this.prefetched.promise : null;
      this.prefetched = null;
      const promise = (prefetched ?? this.fetchPr(pr)).then(async (responses) => {
        const res = responses.fileTree;
        const etag = res.headers.get('ETag');
        let result = etag && etag === responses.storedEtag ? await prune(pr, responses, null, etag) : null;
        if (result) res.body?.cancel().catch(() => {});
        // Not stored (any more): send the list over.
        else result = await prune(pr, responses, await res.text(), etag);
        if (!result) throw new Error('Could not prune this pull request');
        return { key: pr.key, result, repoConfigPath: responses.repo.path };
      });
      entry = cache(this.prCache, pr.key, promise, PR_DATA_TTL_MS);
      promise.catch(() => this.prCache.delete(pr.key));
    }
    return entry.promise;
  }

  /** GitHub's responses for `pr`, minus what the background script already has. Doesn't need settings. */
  private fetchPr(pr: PrRef): Promise<PrResponses> {
    // Also wakes up a Chromium service worker while GitHub responds.
    const lookup = sendMessage<Lookup>({ type: 'lookup', key: pr.key, repoKey: pr.repoKey }).catch(
      (): Lookup => ({ etag: null, repo: null }),
    );
    return Promise.all([
      fetchFileTree(pr),
      fetchPrTotals(pr),
      lookup.then(({ repo }) => repo ?? fetchRepoConfig(pr, 'HEAD').catch(() => ({ path: null, text: null }))),
      lookup,
    ]).then(([fileTree, totals, repo, stored]) => ({
      fileTree,
      storedEtag: stored.etag,
      totals,
      repo,
      repoFetched: !stored.repo,
    }));
  }

  // ---- Rendering --------------------------------------------------------

  private get result(): PruneResult | null {
    return this.data?.result ?? null;
  }

  private isEnabledHere(): boolean {
    return !!this.pr && this.settings.enabled && !isRepoDisabled(this.settings, this.pr.repoKey);
  }

  private isActive(): boolean {
    return !!this.pr && !this.inactive().has(this.pr.key);
  }

  private inactive(): Set<string> {
    return (this.inactiveKeys ??= new Set(readInactive()));
  }

  private isPruning(): boolean {
    return this.isActive() && this.status === 'ready' && (this.result?.pruned.length ?? 0) > 0;
  }

  private revealedSet(): Set<string> {
    const key = this.pr?.key ?? '';
    let set = this.revealed.get(key);
    if (!set) {
      set = new Set();
      this.revealed.set(key, set);
    }
    return set;
  }

  private viewState(): ViewState {
    return {
      status: this.status,
      error: this.error,
      result: this.result,
      active: this.isActive(),
      sources: this.result?.sources ?? [],
      revealed: this.revealedSet(),
      isDiffView: this.pr?.isDiffView ?? false,
    };
  }

  private render(): void {
    if (!this.pr || !this.isEnabledHere()) {
      this.teardown();
      return;
    }
    const pruning = this.isPruning();
    if (pruning && this.result) {
      // Only diff views have file diffs and a file tree to hide.
      this.styles.update(this.pr.isDiffView ? this.result : null, {
        diffMode: this.settings.diffMode,
        treeMode: this.settings.treeMode,
        revealed: this.revealedSet(),
      });
      this.applyCounts();
      if (this.settings.diffMode === 'collapse') {
        this.collapser.sync(this.result.pruned.map((f) => f.digest));
        this.collapser.run();
      } else {
        this.collapser.restore();
      }
    } else {
      this.styles.clear();
      this.counts.restore();
      this.collapser.restore();
    }
    this.lastLocate = 0;
    const state = this.viewState();
    (this.indicator ??= new Indicator(this)).render(state);
    if (this.wantsSection()) (this.section ??= new PrunedSection(this)).render(state);
    this.mountUi();
  }

  private applyCounts(): void {
    if (!this.pr || !this.result) return;
    this.counts.apply(this.pr.basePath, this.result.original, this.result.kept, this.bulk());
  }

  private wantsSection(): boolean {
    // Single-commit views only show some files, so a whole-PR list would mislead.
    return !!this.pr?.isFilesTab && this.settings.diffMode === 'hide' && this.isPruning();
  }

  private mountUi(fromMutation = false): void {
    const indicator = this.indicator;
    if (!document.body || !indicator) return;
    let anchor = this.counts.diffstatAnchor;
    // While pruning, applyCounts() discovers the diffstat; locate() is only for
    // finding where to put the pill when there is nothing to patch.
    if (!anchor && this.result && !this.isPruning() && this.canLocate(fromMutation)) {
      anchor = this.counts.locate(this.result.original, this.bulk());
    }
    anchor ??= findDiffstatFallback();
    // Avoid a floating pill flashing while the header is still rendering.
    if (anchor || this.status !== 'loading') indicator.mount(anchor);
    else indicator.unmount();
    if (this.section && this.wantsSection()) {
      if (!this.sectionContainer?.isConnected && this.canLocate(fromMutation)) {
        this.sectionContainer = this.findDiffListContainer();
      }
      if (this.sectionContainer) this.section.mount(this.sectionContainer);
    } else {
      this.section?.unmount();
    }
  }

  /** Rate-limits searches for page parts that may not have rendered yet (queues a retry instead). */
  private canLocate(fromMutation: boolean): boolean {
    const since = performance.now() - this.lastLocate;
    if (since >= INCOMPLETE_RESCAN_MS) {
      this.lastLocate = performance.now();
      return true;
    }
    if (fromMutation) this.scheduleRetry(INCOMPLETE_RESCAN_MS - since);
    return false;
  }

  /** Parts of a diff page that hold no header counters, so scans can skip them. */
  private bulk(): Element[] {
    return this.pr?.isDiffView && this.result ? this.regions.find(this.result) : [];
  }

  /** The element whose children are the file diffs. */
  private findDiffListContainer(): Element | null {
    this.bulk();
    return this.regions.diffList();
  }

  private teardown(): void {
    this.styles.clear();
    this.counts.restore();
    this.collapser.restore();
    this.indicator?.unmount();
    this.section?.unmount();
  }

  /**
   * Left PR pages: drops the UI and this PR's data, so browsing the rest of
   * GitHub costs next to nothing. Recently fetched data stays in prCache until
   * it expires, so coming straight back doesn't refetch.
   */
  private release(): void {
    this.loadToken++;
    this.indicator = null;
    this.section = null;
    this.sectionContainer = null;
    this.data = null;
    this.prefetched = null;
    this.status = 'loading';
    this.error = undefined;
  }

  /** Visiting `#diff-<digest>` of a pruned file (e.g. from a link) reveals it. */
  private revealFromHash(): void {
    const m = /^#diff-([0-9a-f]{64})/.exec(location.hash);
    if (m && this.result?.pruned.some((f) => f.digest === m[1])) this.revealedSet().add(m[1]!);
  }

  // ---- UiActions --------------------------------------------------------

  setActive(active: boolean): void {
    if (!this.pr) return;
    const inactive = this.inactive();
    if (active) inactive.delete(this.pr.key);
    else inactive.add(this.pr.key);
    writeInactive(inactive);
    this.render();
  }

  setRevealed(digest: string, revealed: boolean): void {
    const set = this.revealedSet();
    if (revealed) set.add(digest);
    else set.delete(digest);
    this.render();
  }

  setAllRevealed(revealed: boolean): void {
    const set = this.revealedSet();
    for (const file of this.result?.pruned ?? []) {
      if (revealed) set.add(file.digest);
      else set.delete(file.digest);
    }
    this.render();
  }

  goToFile(file: PrFile): void {
    if (!this.pr) return;
    const anchor = `diff-${file.digest}`;
    if (this.pr.isDiffView) {
      if (this.settings.diffMode === 'hide' && !this.revealedSet().has(file.digest)) {
        this.setRevealed(file.digest, true);
      }
      const target = document.getElementById(anchor);
      if (target) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
      location.hash = anchor;
      return;
    }
    location.assign(`${filesTabPath(this.pr)}#${anchor}`);
  }

  openSettings(): void {
    sendMessage({ type: 'open-options' }).catch(() => {});
  }

  private tabStatus(): TabStatus {
    const pr = this.pr;
    const enabled = this.isEnabledHere();
    return {
      pr: pr ? `${pr.owner}/${pr.repo}#${pr.number}` : null,
      repo: pr ? `${pr.owner}/${pr.repo}` : null,
      status: !pr ? 'idle' : !enabled ? 'disabled' : this.status,
      error: this.error,
      active: this.isActive(),
      pruned: this.result?.pruned.length ?? 0,
      original: this.result?.original,
      kept: this.result?.kept,
      sources: this.result?.sources ?? [],
      repoConfigPath: this.data?.repoConfigPath ?? null,
    };
  }
}

/**
 * Caches `promise` under `key`. Entries older than `ttl` are never read again,
 * so they are dropped then instead of keeping a PR's file list for good.
 */
function cache<T>(map: Map<string, CacheEntry<T>>, key: string, promise: Promise<T>, ttl: number): CacheEntry<T> {
  const entry = { promise, at: Date.now() };
  map.set(key, entry);
  setTimeout(() => {
    if (map.get(key) === entry) map.delete(key);
  }, ttl + 1000);
  return entry;
}

/** Header diffstat container when the exact-match search found nothing (e.g. no pruned files). */
function findDiffstatFallback(): Element | null {
  return document.getElementById('diffstat');
}

function prune(
  pr: PrRef,
  { totals, repo, repoFetched }: PrResponses,
  fileTree: string | null,
  etag: string | null,
): Promise<PruneResult | null> {
  return sendMessage<PruneResult | null>({
    type: 'prune',
    key: pr.key,
    repoKey: pr.repoKey,
    fileTree,
    etag,
    totals,
    repo,
    repoFetched,
  });
}

/** Messages the background script; it replies `{ error }` when something failed. */
async function sendMessage<T = unknown>(msg: Message): Promise<T> {
  const reply = (await ext.runtime.sendMessage(msg)) as T | { error: string } | undefined;
  if (reply && typeof reply === 'object' && 'error' in reply) throw new Error(reply.error);
  return reply as T;
}

function filesTabPath(pr: PrRef): string {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href$="/changes"], a[href$="/files"]')) {
    if (link.pathname === `${pr.basePath}/changes` || link.pathname === `${pr.basePath}/files`) return link.pathname;
  }
  return `${pr.basePath}/files`;
}

function readInactive(): string[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(INACTIVE_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeInactive(keys: Set<string>): void {
  try {
    if (keys.size === 0) sessionStorage.removeItem(INACTIVE_KEY);
    else sessionStorage.setItem(INACTIVE_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage can be unavailable (e.g. blocked); the toggle then lasts until reload.
  }
}

new Controller().start();
