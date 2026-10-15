import { ext } from '../shared/browser.ts';
import type { Message, TabStatus } from '../shared/messages.ts';
import { compileRules, type CompiledRules } from '../shared/rules.ts';
import {
  isRepoDisabled,
  loadRemoteCache,
  loadSettings,
  onConfigChanged,
  REMOTE_TTL_MS,
  type RemoteCache,
  type Settings,
} from '../shared/settings.ts';
import { Collapser } from './dom/collapse.ts';
import { CountPatcher } from './dom/counts.ts';
import { PruneStyles } from './dom/styles.ts';
import {
  fetchPrFiles,
  fetchPrTotals,
  fetchRepoConfig,
  parsePrUrl,
  type PrFile,
  type PrFileList,
  type PrRef,
  type PrTotals,
  type RepoConfig,
} from './github.ts';
import { computePrune, type PruneResult } from './prune.ts';
import { Indicator } from './ui/indicator.ts';
import { PrunedSection } from './ui/section.ts';
import type { UiActions, ViewState, ViewStatus } from './ui/types.ts';

/** PR data is reused across tab switches for this long before refetching. */
const PR_DATA_TTL_MS = 60_000;
const REPO_CONFIG_TTL_MS = 10 * 60_000;
/** Minimum gap between DOM checks while the page is mutating. */
const CHECK_INTERVAL_MS = 100;
/** Minimum gap between full rescans for new header counters (e.g. sticky headers). */
const RESCAN_INTERVAL_MS = 1000;
/** Rescan gap while some header counter has not been found yet (page still rendering). */
const INCOMPLETE_RESCAN_MS = 250;
const INACTIVE_KEY = 'prune:inactive';

interface PrData {
  files: PrFileList;
  totals: Partial<PrTotals>;
  repoConfig: RepoConfig;
}

interface CacheEntry<T> {
  promise: Promise<T>;
  at: number;
}

class Controller implements UiActions {
  private settings!: Settings;
  private remote: RemoteCache | null = null;
  private pr: PrRef | null = null;
  private href = '';

  private status: ViewStatus = 'loading';
  private error: string | undefined;
  private data: PrData | null = null;
  private compiled: CompiledRules | null = null;
  private result: PruneResult | null = null;

  private readonly prCache = new Map<string, CacheEntry<Omit<PrData, 'repoConfig'>>>();
  private readonly repoCache = new Map<string, CacheEntry<RepoConfig>>();
  private readonly revealed = new Map<string, Set<string>>();
  private readonly inactive = new Set<string>(readInactive());
  private loadToken = 0;

  private readonly styles = new PruneStyles();
  private readonly counts = new CountPatcher();
  private readonly collapser = new Collapser();
  private readonly indicator = new Indicator(this);
  private readonly section = new PrunedSection(this);
  private sectionContainer: Element | null = null;

  private checkTimer = 0;
  private retryTimer = 0;
  private lastCheck = 0;
  private lastRescan = 0;
  private lastLocate = 0;

  async start(): Promise<void> {
    [this.settings, this.remote] = await Promise.all([loadSettings(), loadRemoteCache()]);
    this.maybeRefreshRemote();
    onConfigChanged(async () => {
      const hadRepoConfig = this.settings.useRepoConfig;
      [this.settings, this.remote] = await Promise.all([loadSettings(), loadRemoteCache()]);
      if (this.pr && this.settings.useRepoConfig && !hadRepoConfig) {
        // Repo rules were off, so they were never fetched for this PR.
        this.repoCache.delete(this.pr.repoKey);
        this.load(this.pr);
        return;
      }
      this.recompute();
      this.render();
    });
    ext.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
      if (msg.type === 'get-status') {
        sendResponse(this.tabStatus());
      } else if (msg.type === 'set-active') {
        this.setActive(msg.active);
        sendResponse(this.tabStatus());
      }
      return undefined;
    });

    // One observer for the whole page; the callback only schedules a check, so
    // its cost is constant no matter how many nodes GitHub adds.
    new MutationObserver(() => this.scheduleCheck()).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
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
    (globalThis as { navigation?: EventTarget }).navigation?.addEventListener('navigatesuccess', () =>
      this.scheduleCheck(),
    );
    this.check();
  }

  // ---- Scheduling -------------------------------------------------------

  private scheduleCheck(): void {
    if (this.checkTimer) return;
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
    const prev = this.pr;
    this.pr = pr;
    if (!pr) {
      this.teardown();
      return;
    }
    if (prev?.key !== pr.key) {
      this.teardown();
      this.sectionContainer = null;
      this.load(pr);
    } else {
      // Same PR, different tab: refresh if the data is getting old.
      const cached = this.prCache.get(pr.key);
      if (!cached || Date.now() - cached.at > PR_DATA_TTL_MS) this.load(pr);
      this.sectionContainer = null;
      this.revealFromHash();
      this.render();
    }
  }

  // ---- Data -------------------------------------------------------------

  private load(pr: PrRef): void {
    const token = ++this.loadToken;
    const hadData = this.data !== null && this.pr?.key === pr.key;
    if (!hadData) {
      this.status = 'loading';
      this.data = null;
      this.result = null;
    }
    this.render();

    let entry = this.prCache.get(pr.key);
    if (!entry || Date.now() - entry.at > PR_DATA_TTL_MS) {
      const promise = Promise.all([fetchPrFiles(pr), fetchPrTotals(pr)]).then(([files, totals]) => ({ files, totals }));
      entry = { promise, at: Date.now() };
      this.prCache.set(pr.key, entry);
      promise.catch(() => this.prCache.delete(pr.key));
    }

    Promise.all([entry.promise, this.repoConfig(pr)])
      .then(([prData, repoConfig]) => {
        if (token !== this.loadToken) return;
        this.data = { ...prData, repoConfig };
        this.status = 'ready';
        this.error = undefined;
        this.recompute();
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

  private repoConfig(pr: PrRef): Promise<RepoConfig> {
    if (!this.settings.useRepoConfig) return Promise.resolve({ path: null, text: null });
    let entry = this.repoCache.get(pr.repoKey);
    if (!entry || Date.now() - entry.at > REPO_CONFIG_TTL_MS) {
      const promise = fetchRepoConfig(pr, 'HEAD').catch(() => ({ path: null, text: null }));
      entry = { promise, at: Date.now() };
      this.repoCache.set(pr.repoKey, entry);
    }
    return entry.promise;
  }

  private maybeRefreshRemote(): void {
    const { remoteUrl } = this.settings;
    if (!remoteUrl) return;
    const stale = !this.remote || this.remote.url !== remoteUrl || Date.now() - this.remote.fetchedAt > REMOTE_TTL_MS;
    if (stale) ext.runtime.sendMessage({ type: 'refresh-remote' } satisfies Message).catch(() => {});
  }

  private recompute(): void {
    if (!this.data) return;
    const remoteText = this.remote && this.remote.url === this.settings.remoteUrl ? this.remote.text : null;
    this.compiled = compileRules(this.settings, {
      repoText: this.data.repoConfig.text,
      repoPath: this.data.repoConfig.path,
      remoteText,
    });
    this.result = computePrune(this.data.files, this.data.totals, this.compiled, this.settings);
  }

  // ---- Rendering --------------------------------------------------------

  private isEnabledHere(): boolean {
    return !!this.pr && this.settings.enabled && !isRepoDisabled(this.settings, this.pr.repoKey);
  }

  private isActive(): boolean {
    return !!this.pr && !this.inactive.has(this.pr.key);
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
      sources: this.compiled?.sources ?? [],
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
      this.styles.update(this.result, {
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
    this.indicator.render(state);
    if (this.wantsSection()) this.section.render(state);
    this.mountUi();
  }

  private applyCounts(): void {
    if (!this.pr || !this.result) return;
    this.counts.apply(this.pr.basePath, this.result.original, this.result.kept);
  }

  private wantsSection(): boolean {
    // Single-commit views only show some files, so a whole-PR list would mislead.
    return !!this.pr?.isFilesTab && this.settings.diffMode === 'hide' && this.isPruning();
  }

  private mountUi(fromMutation = false): void {
    if (!document.body) return;
    let anchor = this.counts.diffstatAnchor;
    // While pruning, applyCounts() discovers the diffstat; locate() is only for
    // finding where to put the pill when there is nothing to patch.
    if (!anchor && this.result && !this.isPruning()) {
      const since = performance.now() - this.lastLocate;
      if (since >= INCOMPLETE_RESCAN_MS) {
        this.lastLocate = performance.now();
        anchor = this.counts.locate(this.result.original);
      } else if (fromMutation) {
        this.scheduleRetry(INCOMPLETE_RESCAN_MS - since);
      }
    }
    anchor ??= findDiffstatFallback();
    // Avoid a floating pill flashing while the header is still rendering.
    if (anchor || this.status !== 'loading') this.indicator.mount(anchor);
    else this.indicator.unmount();
    if (this.wantsSection()) {
      if (!this.sectionContainer?.isConnected) this.sectionContainer = this.findDiffListContainer();
      if (this.sectionContainer) this.section.mount(this.sectionContainer);
    } else {
      this.section.unmount();
    }
  }

  /** The closest common ancestor of the first and last file diff on the page. */
  private findDiffListContainer(): Element | null {
    const files = this.data?.files;
    if (!files || files.length === 0) return null;
    let first: Element | null = null;
    let last: Element | null = null;
    for (let i = 0; i < files.length && !first; i++) first = document.getElementById(`diff-${files.digest(i)}`);
    for (let i = files.length - 1; i >= 0 && !last; i--) last = document.getElementById(`diff-${files.digest(i)}`);
    if (!first || !last) return null;
    if (first === last) return first.parentElement;
    const ancestors = new Set<Element>();
    for (let n: Element | null = first; n; n = n.parentElement) ancestors.add(n);
    for (let n: Element | null = last; n; n = n.parentElement) if (ancestors.has(n)) return n;
    return null;
  }

  private teardown(): void {
    this.styles.clear();
    this.counts.restore();
    this.collapser.restore();
    this.indicator.unmount();
    this.section.unmount();
  }

  /** Visiting `#diff-<digest>` of a pruned file (e.g. from a link) reveals it. */
  private revealFromHash(): void {
    const m = /^#diff-([0-9a-f]{64})/.exec(location.hash);
    if (m && this.result?.prunedDigests.has(m[1]!)) this.revealedSet().add(m[1]!);
  }

  // ---- UiActions --------------------------------------------------------

  setActive(active: boolean): void {
    if (!this.pr) return;
    if (active) this.inactive.delete(this.pr.key);
    else this.inactive.add(this.pr.key);
    writeInactive(this.inactive);
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
    ext.runtime.sendMessage({ type: 'open-options' } satisfies Message).catch(() => {});
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
      sources: this.compiled?.sources ?? [],
      repoConfigPath: this.data?.repoConfig.path ?? null,
    };
  }
}

/** Header diffstat container when the exact-match search found nothing (e.g. no pruned files). */
function findDiffstatFallback(): Element | null {
  return document.getElementById('diffstat');
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

new Controller().start().catch((err: unknown) => console.error('[PRune]', err));
