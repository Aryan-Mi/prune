import { ext } from '../shared/browser.ts';
import type { Lookup, Message, RepoConfig, TabStatus } from '../shared/messages.ts';
import type { PrFile, PrTotals } from '../shared/filetree.ts';
import type { PruneResult } from '../shared/prune.ts';
import { isRepoDisabled, loadSettings, pageSettings, type PageSettings } from '../shared/settings.ts';
import { withCollapse } from './chunks.ts';
import type { Collapser } from './dom/collapse.ts';
import { CountPatcher, landmarks } from './dom/counts.ts';
import { BulkRegions } from './dom/regions.ts';
import { PruneStyles } from './dom/styles.ts';
import { fetchFileTree, fetchPrTotals, fetchRepoConfig, mayBeCapped, parsePrUrl, type PrRef } from './github.ts';
import { Indicator } from './ui/indicator.ts';
import { onNavigation } from './route.ts';
import { PrunedSection } from './ui/section.ts';
import type { UiActions, ViewState, ViewStatus } from './ui/types.ts';

/** A PR's result is reused across tab switches for this long before refetching. */
const PR_DATA_TTL_MS = 60_000;
/** Minimum gap between DOM checks while the page is mutating. */
const CHECK_INTERVAL_MS = 100;
/** Whole-page search gap while some header counter has not been found yet (page still rendering). */
const INCOMPLETE_RESCAN_MS = 250;
/**
 * How long after a navigation (and at least until the page has loaded) a
 * header counter missing from GitHub's landmarks is expected to render in
 * them. Then the whole page is searched for it once more; after that, it is
 * only waited for in the landmarks (see `isSettled()`).
 */
const GIVE_UP_MS = 2000;

interface PrData {
  /** The PR this data belongs to. */
  key: string;
  result: PruneResult;
  repoConfigPath: string | null;
}

/** GitHub's responses for a PR, and what the background script has for it. */
interface PrResponses {
  /** The file_tree response, body unread. */
  fileTree: Response;
  stored: Lookup;
  repo: RepoConfig;
  repoFetched: boolean;
}

interface CacheEntry<T> {
  promise: Promise<T>;
  at: number;
}

class Controller implements UiActions {
  /** Loaded on the first PR page, so the rest of GitHub doesn't pay for it. */
  private settings!: PageSettings;
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
  /** PRs switched off in this tab; the background script keeps them across page loads. */
  private readonly inactive = new Set<string>();
  private loadToken = 0;

  private readonly styles = new PruneStyles();
  private readonly counts = new CountPatcher(() => this.scheduleCheck());
  private readonly regions = new BulkRegions();
  /** Collapse mode's, imported when that setting is first on. */
  private collapser: Collapser | null = null;
  // Created on the first PR page, dropped when leaving PR pages.
  private indicator: Indicator | null = null;
  private section: PrunedSection | null = null;
  private sectionContainer: Element | null = null;

  /** The whole document until the page has settled, then only around PRune's changes (see `track()`). */
  private readonly observer = new MutationObserver((records) => this.onMutations(records));
  private checkTimer = 0;
  private retryTimer = 0;
  /** Searches the whole page after all once a missing counter is no longer expected in the landmarks. */
  private waitTimer = 0;
  private lastCheck = 0;
  private lastRescan = 0;
  private lastLocate = 0;
  /** When the current PR page was navigated to. */
  private shownAt = 0;
  /** In `check()`, which calls `track()` when done. */
  private checking = false;
  /** The page has settled: only what PRune changed or placed is observed (see `track()`). */
  private watching = false;

  start(): void {
    ext.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
      if (msg.type === 'get-status') {
        sendResponse(this.tabStatus());
      } else if (msg.type === 'set-active') {
        this.setActive(msg.active);
        sendResponse(this.tabStatus());
      } else if (msg.type === 'config-changed') {
        this.onConfigChanged(msg.settings, msg.rulesChanged);
        sendResponse(null);
      }
      return undefined;
    });

    // On PR pages, one observer; the callback only schedules a check (and
    // pauses itself until then), so its cost is constant no matter how many
    // nodes GitHub adds. Elsewhere only navigations are followed.
    onNavigation(() => this.onChange());
    // Back/forward-cache restores bring back a frozen DOM without mutations.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) this.href = '';
      this.scheduleCheck();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scheduleCheck();
    });
    window.addEventListener('load', () => this.scheduleCheck());
    this.check();
  }

  /**
   * Takes the settings from the background script's reply to the first PR
   * page's `lookup`, then handles the current page again. Changes are pushed
   * from there too, so this script never reads extension storage.
   */
  private configure(lookup: Promise<Lookup>): void {
    if (this.configuring) return;
    this.configuring = true;
    lookup
      .then(({ settings, inactive }) => {
        this.settings = settings;
        for (const key of inactive) this.inactive.add(key);
        this.configured = true;
        this.href = '';
        this.check();
      })
      .catch((err: unknown) => console.error('[PRune]', err));
  }

  private onConfigChanged(settings: PageSettings, rulesChanged: boolean): void {
    if (!this.configured) return;
    this.settings = settings;
    if (rulesChanged) {
      // Results are only kept for the pruned files, so prune again from scratch.
      this.prCache.clear();
      if (this.pr) this.load(this.pr);
      return;
    }
    this.render();
  }

  // ---- Scheduling -------------------------------------------------------

  /**
   * Chooses what the observer watches until the next check. While the page is
   * still rendering, that is the whole document. Once everything PRune needs
   * was found (`isSettled()`), only where that can change: the header parts
   * holding the counters, and the ancestors of every node PRune patched or
   * placed, so that their removal is noticed. The diff list and the rest of
   * the page can then render, lazy-load and re-render without PRune running at
   * all. GitHub writing into a patched node is handled by `counts` itself.
   */
  private track(): void {
    // A check is due, and will call this when done.
    if (this.checkTimer) return;
    this.observer.disconnect();
    // Off PR pages (or where PRune is off) only navigations are followed.
    const active = !!this.pr && this.isEnabledHere();
    if (!active || !this.isSettled()) {
      this.watching = false;
      // The document itself: at document_start <html> may not exist yet.
      if (active) this.observer.observe(document, { childList: true, subtree: true });
      return;
    }
    if (!this.watching) {
      this.watching = true;
      // The diff list may have grown since it was last looked for.
      this.placeSection(true);
    }
    const subtrees = this.counts.places();
    // Collapse mode clicks each pruned file's toggle once its diff shows up.
    // So does a revealed diff, to be marked again.
    const list = this.collapser?.waiting || this.styles.waiting ? this.regions.diffList() : null;
    if (list) subtrees.push(list);
    const seen = new Set<Node>(subtrees);
    const climb = (node: Node) => {
      for (let n = node.parentNode; n && n !== document && !seen.has(n); n = n.parentNode) {
        seen.add(n);
        this.observer.observe(n, { childList: true });
      }
    };
    for (const el of subtrees) {
      this.observer.observe(el, { childList: true, subtree: true });
      climb(el);
    }
    // The section's parent is the diff list: its own children are watched too, so the section stays last.
    // Revealed diffs too: GitHub re-rendering one replaces it without PRune's mark.
    for (const node of [...this.counts.patched(), ...this.styles.shownElements(), this.indicator?.host, this.section?.host]) {
      if (node?.isConnected) climb(node);
    }
  }

  /**
   * Everything PRune needs on this page has rendered: the header counters (or
   * the diffstat the pill goes next to) and the place of the "Pruned files"
   * section. A counter that is still missing after a while doesn't count if
   * the header part it would render in is there (and watched from then on).
   */
  private isSettled(): boolean {
    if (document.readyState !== 'complete' || this.status === 'loading') return false;
    if (this.wantsSection() && !this.section?.host.isConnected) return false;
    if (this.collapser?.waiting && !this.regions.diffList()) return false;
    const found = this.isPruning()
      ? this.counts.isComplete() && this.counts.isIntact()
      : !this.result || !!this.counts.diffstatAnchor;
    return found || (this.waitFor() === 0 && landmarks().length > 0);
  }

  /** How much longer what is missing from the header landmarks is expected to render there (see GIVE_UP_MS). */
  private waitFor(): number {
    if (document.readyState !== 'complete') return GIVE_UP_MS;
    return Math.max(0, this.shownAt + GIVE_UP_MS - performance.now());
  }

  private onMutations(records: MutationRecord[]): void {
    const host = this.section?.host;
    const list = host?.parentNode;
    if (this.watching && list && records.every((r) => r.target === list)) {
      // GitHub rendered (or unmounted) diffs: only the section's place may need fixing, and right away.
      if (list.lastElementChild !== host) this.placeSection(false);
      return;
    }
    this.onChange();
  }

  private onChange(): void {
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
    // PRune's own changes needn't be observed; track() picks up from here.
    this.observer.disconnect();
    this.checking = true;
    try {
      if (location.href !== this.href) {
        this.href = location.href;
        this.onLocationChange(parsePrUrl(location.pathname));
      } else if (this.pr && this.isEnabledHere()) {
        this.update(fromMutation);
      }
    } finally {
      this.checking = false;
    }
    this.track();
  }

  private update(fromMutation: boolean): void {
    this.styles.ensure();
    if (this.isPruning()) {
      const intact = this.counts.isIntact();
      if (!intact || !this.counts.isComplete()) {
        const since = performance.now() - this.lastRescan;
        // apply() searches the whole page only if the likely places come up short.
        if (!intact || since >= INCOMPLETE_RESCAN_MS) this.applyCounts();
        else if (fromMutation) this.scheduleRetry(INCOMPLETE_RESCAN_MS - since);
      }
      if (this.settings.diffMode === 'collapse') this.collapser?.run();
    }
    this.mountUi(fromMutation);
  }

  private scheduleRetry(delay: number): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.check(false), delay + 10);
  }

  private onLocationChange(pr: PrRef | null): void {
    if (pr && !this.configured) {
      // GitHub's responses don't depend on settings: fetch them while they load.
      const lookup = this.lookup(pr);
      this.prefetched = { key: pr.key, promise: this.fetchPr(pr, lookup) };
      this.prefetched.promise.catch(() => {});
      this.configure(lookup);
      return;
    }
    const prev = this.pr;
    this.pr = pr;
    this.shownAt = performance.now();
    if (!pr) {
      this.teardown();
      this.release();
      return;
    }
    // Counters found where expected are enough at first; the whole-page search for more can wait.
    this.lastRescan = performance.now();
    if (prev?.key !== pr.key) {
      this.teardown();
      this.sectionContainer = null;
      this.regions.reset();
      this.load(pr);
    } else {
      // Same PR, different tab: refresh if the data is getting old.
      this.counts.rescope();
      this.sectionContainer = null;
      this.regions.reset();
      const cached = this.prCache.get(pr.key);
      if (!cached || Date.now() - cached.at > PR_DATA_TTL_MS) this.load(pr);
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
   * gets back only the pruned files. If the background script already has a
   * result for this exact list (from an earlier visit; GitHub's ETag says so),
   * the response isn't even read, let alone passed along: the result usually
   * came with the reply to `lookup` already.
   */
  private prData(pr: PrRef): Promise<PrData> {
    let entry = this.prCache.get(pr.key);
    if (!entry || Date.now() - entry.at > PR_DATA_TTL_MS) {
      const prefetched = this.prefetched?.key === pr.key ? this.prefetched.promise : null;
      this.prefetched = null;
      const promise = (prefetched ?? this.fetchPr(pr)).then(async (responses) => {
        const res = responses.fileTree;
        const etag = res.headers.get('ETag');
        let result =
          etag && etag === responses.stored.etag
            ? (responses.stored.result ?? (await prune(pr, responses, null, etag, null)))
            : null;
        if (result) {
          discard(res);
        } else {
          // Not stored (any more): send the list over, with GitHub's totals if it may be capped.
          const totals = mayBeCapped(res) ? fetchPrTotals(pr).catch(() => null) : null;
          result = await prune(pr, responses, await res.text(), etag, await totals);
        }
        if (!result) throw new Error('Could not prune this pull request');
        return { key: pr.key, result: shareStrings(result), repoConfigPath: responses.repo.path };
      });
      entry = cache(this.prCache, pr.key, promise, PR_DATA_TTL_MS);
      promise.catch(() => this.prCache.delete(pr.key));
    }
    return entry.promise;
  }

  /** Asks the background script for settings and what it has stored for `pr`; also wakes it up. */
  private lookup(pr: PrRef): Promise<Lookup> {
    return sendMessage<Lookup>({ type: 'lookup', key: pr.key, repoKey: pr.repoKey }).catch(
      async (): Promise<Lookup> => ({
        // Not reachable right now: fetch everything, and read settings here.
        settings: this.configured ? this.settings : pageSettings(await loadSettings()),
        inactive: [],
        etag: null,
        repo: null,
        result: null,
      }),
    );
  }

  /** GitHub's responses for `pr`, minus what the background script already has. Doesn't need settings. */
  private fetchPr(pr: PrRef, lookup = this.lookup(pr)): Promise<PrResponses> {
    return Promise.all([
      fetchFileTree(pr),
      lookup,
      lookup.then(({ repo }) => repo ?? fetchRepoConfig(pr, 'HEAD').catch(() => ({ path: null, text: null }))),
    ]).then(([fileTree, stored, repo]) => ({ fileTree, stored, repo, repoFetched: !stored.repo }));
  }

  // ---- Rendering --------------------------------------------------------

  private get result(): PruneResult | null {
    return this.data?.result ?? null;
  }

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
      sources: this.result?.sources ?? [],
      revealed: this.revealedSet(),
      isDiffView: this.pr?.isDiffView ?? false,
    };
  }

  private render(): void {
    if (this.checking) {
      this.paint();
      return;
    }
    // PRune's own changes needn't be observed.
    this.observer.disconnect();
    this.paint();
    this.track();
  }

  private paint(): void {
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
        this.collapse(this.result);
      } else {
        this.collapser?.restore();
      }
    } else {
      // Switched off (or refreshing): the same rules may apply again in a moment.
      this.styles.off();
      this.counts.restore();
      this.collapser?.restore();
    }
    this.lastLocate = 0;
    const state = this.viewState();
    (this.indicator ??= new Indicator(this)).render(state);
    if (this.wantsSection()) (this.section ??= new PrunedSection(this)).render(state);
    this.mountUi();
  }

  /** Collapses the pruned files' diffs; the first time, once collapse mode's chunk is there. */
  private collapse(result: PruneResult): void {
    if (!this.collapser) {
      withCollapse(({ Collapser }) => {
        if (this.collapser) return;
        this.collapser = new Collapser();
        this.render();
      });
      return;
    }
    this.collapser.sync(result.pruned.map((f) => f.digest));
    this.collapser.run();
  }

  /** Patches the header counters, searching where they were last found first. */
  private applyCounts(): void {
    if (!this.pr || !this.result) return;
    const { original, kept } = this.result;
    const wait = this.waitFor();
    if (this.counts.apply(this.pr.basePath, original, kept, () => this.bulk(), false, wait > 0)) {
      this.lastRescan = performance.now();
    }
    this.searchAfterWait(!this.counts.isComplete(), wait);
  }

  /** While something `missing` is waited for in the landmarks, has the whole page searched once that is over. */
  private searchAfterWait(missing: boolean, wait: number): void {
    clearTimeout(this.waitTimer);
    if (missing && wait > 0) this.waitTimer = window.setTimeout(() => this.check(false), wait + 10);
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
      const wait = this.waitFor();
      anchor = this.counts.locate(this.result.original, () => this.bulk(), wait > 0);
      this.searchAfterWait(!anchor, wait);
    }
    anchor ??= findDiffstatFallback();
    // Avoid a floating pill flashing while the header is still rendering.
    if (anchor || this.status !== 'loading') indicator.mount(anchor);
    else indicator.unmount();
    this.placeSection(this.watching, fromMutation);
  }

  /**
   * Puts the "Pruned files" section after the diff list. With `grow`, the list
   * is looked for again first, in case GitHub rendered more diffs next to it
   * (whole-page header searches do that too). Once the page has settled, checks
   * are rare and mean that the surroundings of the list may have changed.
   */
  private placeSection(grow: boolean, fromMutation = false): void {
    if (!this.section || !this.wantsSection()) {
      this.section?.unmount();
      return;
    }
    if (!this.sectionContainer?.isConnected) {
      if (this.canLocate(fromMutation)) this.sectionContainer = this.findDiffListContainer();
    } else {
      if (grow) this.bulk();
      this.sectionContainer = this.regions.diffList() ?? this.sectionContainer;
    }
    if (this.sectionContainer) this.section.mount(this.sectionContainer);
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

  /** Where the "Pruned files" section goes: after the file diffs. */
  private findDiffListContainer(): Element | null {
    this.bulk();
    return this.regions.diffList();
  }

  private teardown(): void {
    this.styles.clear();
    this.counts.restore();
    this.collapser?.restore();
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
    if (active) this.inactive.delete(this.pr.key);
    else this.inactive.add(this.pr.key);
    sendMessage({ type: 'set-inactive', keys: [...this.inactive] }).catch(() => {});
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
  { repo, repoFetched }: PrResponses,
  fileTree: string | null,
  etag: string | null,
  totals: Partial<PrTotals> | null,
): Promise<PruneResult | null> {
  return sendMessage<PruneResult | null>({
    type: 'prune',
    key: pr.key,
    repoKey: pr.repoKey,
    fileTree,
    etag,
    repo,
    repoFetched,
    totals,
  });
}

/**
 * Messages arrive with a copy of every string, but the pruned files' rules
 * and sources repeat (hundreds of files under one `vendor/` rule): keeps one
 * of each, the rest is garbage right away.
 */
function shareStrings(result: PruneResult): PruneResult {
  const strings = new Map<string, string>();
  const share = (s: string): string => strings.get(s) ?? (strings.set(s, s), s);
  for (const file of result.pruned) {
    file.rule = share(file.rule);
    file.source = share(file.source);
  }
  return result;
}

/** Lets go of a response that won't be read. */
function discard(res: Response): void {
  try {
    res.body?.cancel().catch(() => {});
  } catch {
    // Only frees the connection's buffers early; the response is dropped anyway.
  }
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

new Controller().start();
