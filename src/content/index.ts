import { ext } from '../shared/browser.ts';
import type { Lookup, Message, RepoConfig, TabStatus } from '../shared/messages.ts';
import type { PrFile, PrTotals } from '../shared/filetree.ts';
import type { PruneResult } from '../shared/prune.ts';
import { isRepoDisabled, loadSettings, pageSettings, type PageSettings } from '../shared/settings.ts';
import { withCollapse } from './chunks.ts';
import type { Collapser } from './dom/collapse.ts';
import { CountPatcher, landmarks } from './dom/counts.ts';
import {
  clearSnapshots,
  CountMarks,
  encode,
  fingerprint,
  pageStorage,
  readSnapshot,
  sameTotals,
  saveSnapshot,
  type Snapshot,
} from './dom/prerender.ts';
import { BulkRegions } from './dom/regions.ts';
import { PruneStyles } from './dom/styles.ts';
import { fetchFileTree, fetchPrTotals, fetchRepoConfig, mayBeCapped, parsePrUrl, type PrRef } from './github.ts';
import { Indicator } from './ui/indicator.ts';
import { onNavigation } from './route.ts';
import { PrunedSection } from './ui/section.ts';
import type { UiActions, ViewState, ViewStatus } from './ui/types.ts';

// Times are Date.now(): precise enough for these, and performance.now() would
// have the page set up the Performance interface in this script's world.

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
let storage: Storage | null | undefined;

/**
 * Where pre-renders are kept; nothing is in private windows (see
 * dom/prerender.ts). Opened when first needed: in Chromium that takes 1–3 ms
 * if the page hasn't opened it yet (it does on every PR page, a little later).
 */
function pageStore(): Storage | null {
  if (storage === undefined) storage = ext.extension?.inIncognitoContext ? null : pageStorage();
  return storage;
}

interface PrData {
  /** The PR this data belongs to. */
  key: string;
  /** A summary unless the page wanted the pruned files (see `wantsFiles()`). */
  result: PruneResult;
  /** ETag of the file list `result` is for. */
  etag: string | null;
  repoConfigPath: string | null;
}

/** GitHub's responses for a PR, and what the background script has for it. */
interface PrResponses {
  /** The file_tree response, body unread. */
  fileTree: Response;
  stored: Lookup;
  repo: RepoConfig;
  repoFetched: boolean;
  /** Asked for the pruned files (see Lookup). */
  files: boolean;
}

interface CacheEntry {
  promise: Promise<PrData>;
  /** When GitHub's list was fetched. */
  at: number;
  /** With the pruned files. */
  files: boolean;
}

class Controller implements UiActions, EventListenerObject {
  /** Loaded on the first PR page, so the rest of GitHub doesn't pay for it. */
  private settings!: PageSettings;
  private configured = false;
  private configuring = false;
  private pr: PrRef | null = null;
  private href = '';

  private status: ViewStatus = 'loading';
  private error: string | undefined;
  private data: PrData | null = null;
  /**
   * The background script's result from an earlier visit while this PR's is
   * loading: it hides the pruned diffs before GitHub renders them, when
   * that's nearly free (see PruneStyles).
   */
  private early: { key: string; result: PruneResult } | null = null;

  private readonly prCache = new Map<string, CacheEntry>();
  /** Responses fetched while settings were still loading. */
  private prefetched: { key: string; files: boolean; promise: Promise<PrResponses> } | null = null;
  /** The PR whose pruned files the ✂ popover or its diffs are about to show. */
  private filesFor = '';
  /** "Files changed" links that ask for the pruned files once the pointer reaches them. */
  private readonly armed = new WeakSet<Element>();
  private readonly revealed = new Map<string, Set<string>>();
  /** PRs switched off in this tab; the background script keeps them across page loads. */
  private readonly inactive = new Set<string>();
  private loadToken = 0;

  private readonly styles = new PruneStyles();
  private readonly counts = new CountPatcher(() => this.scheduleCheck());
  private readonly regions = new BulkRegions();
  /** The stored pre-render of the PR shown, from the first frame until its data has settled in. */
  private preShown: { key: string; value: Snapshot } | null = null;
  private readonly countMarks = new CountMarks();
  /** What is stored for the PR last shown (its fingerprint), so the same isn't written again. */
  private storedHash: { key: string; hash: number } | null = null;
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
    // Rare enough to start over: every PR's pre-render was for the old settings.
    const store = pageStore();
    if (store) clearSnapshots(store);
    this.storedHash = null;
    if (rulesChanged) {
      // Results are only kept for the pruned files, so prune again from scratch.
      this.prCache.clear();
      if (this.pr) this.load(this.pr);
      return;
    }
    this.render();
    this.remember();
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
      // What the counters show is up to their patches from now on.
      this.dropSnapshot();
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
    return Math.max(0, this.shownAt + GIVE_UP_MS - Date.now());
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
    const wait = Math.max(0, CHECK_INTERVAL_MS - (Date.now() - this.lastCheck));
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
    this.lastCheck = Date.now();
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
        const since = Date.now() - this.lastRescan;
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
    this.preRender(pr);
    if (pr && !this.configured) {
      // GitHub's responses don't depend on settings: fetch them while they load.
      const files = this.wantsFiles(pr);
      const lookup = this.lookup(pr, files);
      this.prefetched = { key: pr.key, files, promise: this.fetchPr(pr, files, lookup) };
      this.prefetched.promise.catch(() => {});
      this.configure(lookup);
      return;
    }
    const prev = this.pr;
    this.pr = pr;
    this.shownAt = Date.now();
    if (!pr) {
      this.teardown();
      this.release();
      return;
    }
    // Counters found where expected are enough at first; the whole-page search for more can wait.
    this.lastRescan = Date.now();
    if (prev?.key !== pr.key) {
      // A pre-render's stylesheet is this PR's already.
      this.teardown(this.preShown?.key === pr.key);
      this.sectionContainer = null;
      this.regions.reset();
      this.load(pr);
    } else {
      // Same PR, different tab: refresh if the data is getting old.
      this.counts.rescope();
      this.sectionContainer = null;
      this.regions.reset();
      // Or to get the pruned files, now that there are diffs.
      const cached = this.prCache.get(pr.key);
      if (!cached || Date.now() - cached.at > PR_DATA_TTL_MS || (!cached.files && this.wantsFiles(pr))) this.load(pr);
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

    this.prData(pr, this.wantsFiles(pr))
      .then((data) => {
        if (token !== this.loadToken) return;
        this.data = data;
        this.early = null;
        this.status = 'ready';
        this.error = undefined;
        // The popover was hovered meanwhile.
        if (data.result.partial && this.wantsFiles(pr)) this.load(pr);
        this.revealFromHash();
        this.render();
        this.remember();
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
   *
   * With `files`, the result has the pruned files; else it is a summary.
   */
  private prData(pr: PrRef, files: boolean): Promise<PrData> {
    const entry = this.prCache.get(pr.key);
    const fresh = !!entry && Date.now() - entry.at <= PR_DATA_TTL_MS;
    if (fresh && (entry.files || !files)) return entry.promise;
    const prefetched =
      this.prefetched?.key === pr.key && (this.prefetched.files || !files) ? this.prefetched.promise : null;
    this.prefetched = null;
    const promise = fresh
      ? entry.promise.then((data) => this.withFiles(pr, data))
      : this.fromResponses(pr, prefetched ?? this.fetchPr(pr, files));
    cache(this.prCache, pr.key, { promise, at: fresh ? entry.at : Date.now(), files });
    promise.catch(() => this.prCache.delete(pr.key));
    return promise;
  }

  private async fromResponses(pr: PrRef, pending: Promise<PrResponses>): Promise<PrData> {
    const responses = await pending;
    const { fileTree: res, stored } = responses;
    const etag = res.headers.get('ETag');
    // A result for the rules file as last seen (`repo` null) is checked against the one just fetched.
    const ready = stored.repo && stored.result;
    let result = etag && etag === stored.etag ? (ready ?? (await prune(pr, responses, null, etag, null))) : null;
    if (result) {
      discard(res);
    } else {
      // Not stored (any more): send the list over, with GitHub's totals if it may be capped.
      const totals = mayBeCapped(res) ? fetchPrTotals(pr).catch(() => null) : null;
      result = await prune(pr, responses, await res.text(), etag, await totals);
    }
    if (!result) throw new Error('Could not prune this pull request');
    return { key: pr.key, result: shareStrings(result), etag, repoConfigPath: responses.repo.path };
  }

  /**
   * `data` with the pruned files, now that the page wants them: the
   * background script still has them stored, unless GitHub's list changed.
   */
  private async withFiles(pr: PrRef, data: PrData): Promise<PrData> {
    if (!data.result.partial) return data;
    const { etag, repo, result } = await this.lookup(pr, true);
    if (result && repo && etag === data.etag) return { ...data, result: shareStrings(result) };
    return this.fromResponses(pr, this.fetchPr(pr, true));
  }

  /** Diffs show the pruned files (or hide them), and so does the ✂ popover. */
  private wantsFiles(pr: PrRef): boolean {
    return pr.isDiffView || this.filesFor === pr.key;
  }

  /** Asks the background script for settings and what it has stored for `pr`; also wakes it up. */
  private lookup(pr: PrRef, files: boolean): Promise<Lookup> {
    return sendMessage<Lookup>({ type: 'lookup', key: pr.key, repoKey: pr.repoKey, files }).catch(
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
  private fetchPr(pr: PrRef, files: boolean, lookup = this.lookup(pr, files)): Promise<PrResponses> {
    lookup.then(({ result }) => result && files && this.preview(pr.key, result)).catch(() => {});
    return Promise.all([
      fetchFileTree(pr),
      lookup,
      lookup.then(({ repo }) => repo ?? fetchRepoConfig(pr, 'HEAD').catch(() => ({ path: null, text: null }))),
    ]).then(([fileTree, stored, repo]) => ({ fileTree, stored, repo, repoFetched: !stored.repo, files }));
  }

  /** Applies a result from an earlier visit to `key` while its own is loading. */
  private preview(key: string, result: PruneResult): void {
    this.early = { key, result };
    if (this.configured && this.pr?.key === key && this.status === 'loading') this.render();
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
    return this.isActive() && this.status === 'ready' && (this.result?.removed.files ?? 0) > 0;
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
    const snapshot = this.preShown?.key === this.pr.key ? this.preShown.value : null;
    // What hides the diffs until the data is here: the pre-render, else the
    // background script's stored result (e.g. when page storage was cleared).
    const early = this.early?.key === this.pr.key ? this.early.result : null;
    const preview = snapshot?.result.pruned.length ? snapshot.result : early;
    if (pruning && this.result) {
      // The PR changed since it was stored: its counters show other numbers now.
      if (snapshot && !sameTotals(snapshot, this.result)) this.countMarks.stop();
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
    } else if ((snapshot || preview) && this.status === 'loading' && this.isActive()) {
      // Not the data yet: shown as last time, also on another tab of the PR.
      if (preview) this.revealFromHash(preview);
      this.styles.update(this.pr.isDiffView ? preview : null, {
        diffMode: snapshot?.diffMode ?? this.settings.diffMode,
        treeMode: snapshot?.treeMode ?? this.settings.treeMode,
        revealed: this.revealedSet(),
      });
    } else {
      this.dropSnapshot();
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
      this.lastRescan = Date.now();
    }
    // Patched counters show their pre-render's mark as text now.
    this.countMarks.settle();
    this.searchAfterWait(!this.counts.isComplete(), wait);
  }

  /** While something `missing` is waited for in the landmarks, has the whole page searched once that is over. */
  private searchAfterWait(missing: boolean, wait: number): void {
    clearTimeout(this.waitTimer);
    if (missing && wait > 0) this.waitTimer = window.setTimeout(() => this.check(false), wait + 10);
  }

  private wantsSection(): boolean {
    // Single-commit views only show some files, so a whole-PR list would mislead.
    // A summary has no files to list: they are on their way.
    return !!this.pr?.isFilesTab && this.settings.diffMode === 'hide' && this.isPruning() && !this.result?.partial;
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
    // A summary: the diffs will want the pruned files, so they're asked for
    // when the pointer reaches the "Files changed" tab (or it gets focus),
    // before the diffs render.
    if (this.result?.partial) {
      for (const link of this.counts.filesLinks()) {
        if (this.armed.has(link)) continue;
        this.armed.add(link);
        link.addEventListener('pointerenter', this, { once: true });
        link.addEventListener('focus', this, { once: true });
      }
    }
  }

  /** A "Files changed" link was reached (see `mountUi()`). */
  handleEvent(): void {
    this.needFiles();
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
    const since = Date.now() - this.lastLocate;
    if (since >= INCOMPLETE_RESCAN_MS) {
      this.lastLocate = Date.now();
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

  private teardown(keepStyles = false): void {
    if (!keepStyles) this.styles.clear();
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
    this.early = null;
    this.prefetched = null;
    this.status = 'loading';
    this.error = undefined;
  }

  // ---- Pre-rendering (see dom/prerender.ts) ------------------------------

  /**
   * Shows `pr` as it was pruned last time, from before its data is here.
   * Until the settings are known, that is on the assumption that they are
   * the same; once they are, a pre-render made for others is dropped.
   */
  private preRender(pr: PrRef | null, deferred = false): void {
    if (pr && this.preShown?.key === pr.key) {
      if (this.configured && !this.fits(pr, this.preShown.value)) {
        this.dropSnapshot();
        this.forgetPr(pr.key);
      }
      return;
    }
    this.dropSnapshot();
    // Back to a PR whose data is here (e.g. from the back/forward cache). The
    // root element is there at document_start (Chromium, Firefox), but checked.
    if (!pr || !document.documentElement) return;
    if (this.data?.key === pr.key && this.status === 'ready') return;
    if (!pr.isDiffView && !deferred) {
      // Without diffs, only counters are pre-rendered, and they are marked
      // from requestAnimationFrame anyway: storage can wait for the next
      // frame, by when the page itself has most likely opened it.
      requestAnimationFrame(() => {
        if (parsePrUrl(location.pathname)?.key === pr.key) this.preRender(pr, true);
      });
      return;
    }
    const store = pageStore();
    const value = store && readSnapshot(store, pr.key);
    if (!value) return;
    if (this.configured && !this.fits(pr, value)) {
      this.forgetPr(pr.key);
      return;
    }
    this.preShown = { key: pr.key, value };
    this.storedHash = { key: pr.key, hash: value.hash };
    this.countMarks.start(value.result.original, value.result.kept);
    // Rendering waits for the settings; once they are known it keeps this up. A
    // link to a pruned file's diff shows it, which can't be done before then.
    if (pr.isDiffView && !this.configured && !hashedFile(value.result)) {
      this.styles.update(value.result, { diffMode: value.diffMode, treeMode: value.treeMode, revealed: new Set() });
    }
  }

  /** Whether `snapshot` is what the settings would show on `pr`. */
  private fits(pr: PrRef, snapshot: Snapshot): boolean {
    return (
      this.settings.enabled &&
      !isRepoDisabled(this.settings, pr.repoKey) &&
      !this.inactive.has(pr.key) &&
      snapshot.diffMode === this.settings.diffMode &&
      snapshot.treeMode === this.settings.treeMode
    );
  }

  /** Done with the pre-render: the stylesheet is the real data's now, the counters' marks go. */
  private dropSnapshot(): void {
    this.preShown = null;
    if (this.countMarks.active) this.countMarks.stop();
  }

  /** Stores what this PR looks like pruned for its next visit, or forgets it if it isn't. */
  private remember(): void {
    const pr = this.pr;
    const result = this.result;
    const store = pageStore();
    if (!store || !pr || !result || this.status !== 'ready') return;
    const { diffMode, treeMode } = this.settings;
    const keep = this.isPruning() && this.isEnabledHere();
    // Off the way of the page's own work; a few hundred bytes for most PRs.
    idle(() => {
      if (!keep) {
        this.forgetPr(pr.key);
        return;
      }
      // A summary (no diffs here) only stands in for the files kept last
      // time if its numbers have changed: the counters must show the new ones.
      const prev = result.partial ? readSnapshot(store, pr.key) : null;
      const same = prev && sameTotals(prev, result) && prev.diffMode === diffMode && prev.treeMode === treeMode;
      const raw = encode(same ? prev.result : result, diffMode, treeMode);
      const hash = fingerprint(raw);
      saveSnapshot(store, pr.key, raw, this.storedHash?.key === pr.key && this.storedHash.hash === hash);
      this.storedHash = { key: pr.key, hash };
    });
  }

  private forgetPr(key: string): void {
    if (this.storedHash?.key === key) this.storedHash = null;
    const store = pageStore();
    if (store) clearSnapshots(store, (k) => k === key);
  }

  /** Visiting `#diff-<digest>` of a pruned file (e.g. from a link) reveals it. */
  private revealFromHash(result = this.result): void {
    const digest = result && hashedFile(result);
    if (digest) this.revealedSet().add(digest);
  }

  // ---- UiActions --------------------------------------------------------

  setActive(active: boolean): void {
    if (!this.pr) return;
    if (active) this.inactive.delete(this.pr.key);
    else this.inactive.add(this.pr.key);
    sendMessage({ type: 'set-inactive', keys: [...this.inactive] }).catch(() => {});
    this.render();
    // Switched off, it isn't pre-rendered next time either (a reload may come right away).
    if (active) this.remember();
    else this.forgetPr(this.pr.key);
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

  needFiles(): void {
    const pr = this.pr;
    if (!pr || this.wantsFiles(pr)) return;
    this.filesFor = pr.key;
    if (this.result?.partial) this.load(pr);
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
      pruned: this.result?.removed.files ?? 0,
      original: this.result?.original,
      kept: this.result?.kept,
      sources: this.result?.sources ?? [],
      repoConfigPath: this.data?.repoConfigPath ?? null,
    };
  }
}

/**
 * Caches `entry` under `key`. Entries older than PR_DATA_TTL_MS are never read
 * again, so they are dropped then instead of keeping a PR's result for good.
 */
function cache(map: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  map.set(key, entry);
  setTimeout(
    () => {
      if (map.get(key) === entry) map.delete(key);
    },
    entry.at + PR_DATA_TTL_MS + 1000 - Date.now(),
  );
}

/** The pruned file whose diff the URL points to (`#diff-<digest>`), if any. */
function hashedFile(result: PruneResult): string | null {
  const digest = /^#diff-([0-9a-f]{64})/.exec(location.hash)?.[1];
  return digest && result.pruned.some((f) => f.digest === digest) ? digest : null;
}

/** Runs `task` when the page is idle (soon, at the latest). */
function idle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 500 });
  else setTimeout(task, 0);
}

/** Header diffstat container when the exact-match search found nothing (e.g. no pruned files). */
function findDiffstatFallback(): Element | null {
  return document.getElementById('diffstat');
}

function prune(
  pr: PrRef,
  { repo, repoFetched, files }: PrResponses,
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
    files,
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
