<img src="assets/icon.svg" width="64" height="64" alt="">

# PRune

**Prune the noise out of GitHub pull requests.** PRune is a browser extension (Firefox/Zen first, Chromium too) that takes lockfiles, snapshots, build output and other generated files out of a PR's line counts and diff, so the numbers you see reflect the code someone actually wrote.

- **Honest line counts.** The `+added −removed` stat and the "Files changed" counter in the PR header leave out pruned files.
- **Pruned diffs move to the bottom.** On the Files changed tab, pruned files are hidden from the diff list and file tree and collected in a **Pruned files** section at the end. You can show any of them again in place.
- **Hover to inspect, one click to toggle.** A small ✂ pill next to the line counts lists what was pruned and why, with an on/off switch for the current PR.
- **Configurable in layers.** Built-in defaults → the repo's `.pruneignore` → your own rules file (by URL) → your personal rules. Everything uses `.gitignore` syntax.

![The PRune popover on a pull request](docs/popover.png)

![The "Pruned files" section at the bottom of Files changed](docs/pruned-section.png)

## Install

```sh
bun install
bun run build          # → dist/firefox and dist/chrome
```

### Firefox / Zen

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `dist/firefox/manifest.json`.

Temporary add-ons are removed when the browser restarts. To keep it installed:

- **Sign it for yourself (free, recommended):** create AMO API keys at <https://addons.mozilla.org/developers/addon/api/key/>, then run `bunx web-ext sign --channel=unlisted --source-dir dist/firefox --api-key=… --api-secret=…`. Install the resulting `.xpi` by opening it in the browser. Unlisted add-ons are not published on the store.
- **Or, if your build allows unsigned add-ons** (Developer Edition, Nightly, and builds that honor `xpinstall.signatures.required = false` in `about:config`), run `bun run package` and install `dist/prune-firefox-<version>.zip`.

Requires Firefox 140 or newer (current Zen is fine).

### Chrome / Edge / Brave / Arc

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `dist/chrome`.

## Configuring what gets pruned

Rules are evaluated in this order, and **the last matching rule wins**:

| Layer | Where it lives | Notes |
| --- | --- | --- |
| Built-in defaults | the extension | Lockfiles, minified files & source maps, test snapshots, generated code, vendored/build output. You can switch each group off in Settings. |
| Repository rules | `.pruneignore` (or `.github/pruneignore`) in the repo's default branch | Picked up automatically (and re-checked every 10 minutes), so a team can share rules. Works on private repos with your normal GitHub session. |
| Rules file URL | any `https://` URL, e.g. a raw file in your dotfiles repo or a gist | Fetched in the background and refreshed hourly. Edit the file and PRune follows; no need to touch the extension. |
| Your rules | the Settings page | Typed in or imported from a file. |
| `linguist-generated` | the repo's `.gitattributes` | Files GitHub already knows are generated are pruned too (can be switched off). |

Syntax is `.gitignore`: `*`, `**`, `?`, `[abc]`, a leading `/` to anchor to the repo root, a trailing `/` for directories, and `!` to keep a file another rule pruned:

```gitignore
# Generated API client
packages/api-client/src/generated/

# Drizzle migration snapshots
drizzle/meta/*.json

# In this repo we *do* review the lockfile
!pnpm-lock.yaml
```

> **Why a URL and not a local file path?** Browsers don't let extensions read arbitrary files on your disk. Keep your personal `.pruneignore` in a (public or secret-gist) dotfiles repo and point PRune at its raw URL. Or use **Import file…** on the Settings page for a one-off import.

### How pruned files are shown

Under Settings → *On the "Files changed" tab*:

- **Hide and list them at the bottom** (default): diffs are hidden in place and listed in a "Pruned files" section after the last file. **Show diff** reveals one again.
- **Collapse them in place**: PRune clicks GitHub's own collapse toggle once per pruned file and dims it.
- **Leave the diffs alone**: only the line counts and file count change.

The file tree can either hide or dim pruned files.

## How it works, and why it's fast

Performance was a design constraint from the start:

- **No diff downloading or parsing.** PRune reads `/{owner}/{repo}/pull/{n}/page_data/file_tree`, the same-origin JSON endpoint GitHub's own UI uses. It returns every file's path, line stats and `sha256(path)` digest in one request (~250 bytes per file) and works on private repos with your session. No API token is needed. Below GitHub's 3,000-file cap the listed files add up to exactly the header's totals, so GitHub's separate totals endpoints are only asked when the response is big enough to be capped (and only the first time, see below).
- **The heavy lifting happens off the page.** The content script fetches that response (it has to, for your session and Firefox container) and hands the text straight to the extension's background script (as a structured clone in Firefox and Chromium 148+, not as JSON), which parses it and runs the rules. Only the pruned files come back. On a 3,000-file PR the page never parses the 700 KB response, never holds the file list, and doesn't even load the rule matcher. A page without diffs (the conversation tab) gets only the numbers: the pruned files' paths and digests are left out until you point at the ✂ pill or switch to the diffs, and then come in one message (on a PR that prunes 186 vendored files, that's ~40 KB the conversation tab doesn't keep).
- **A PR is pruned once.** The background script keeps its results (in memory, for the browser session) with GitHub's `ETag` for the file list, a hash of the response. When you reload or reopen a PR, the stored result comes with the background script's first reply. If GitHub's response has the same `ETag` and your rules haven't changed, that's it: one message, the page doesn't even read the response, nothing is passed along, parsed or matched, and neither the repo's `.pruneignore` nor (on a capped list) GitHub's totals are fetched again. The totals are kept with the result: the file list names the PR's commits and base, so its `ETag` covers them. Results are kept per Firefox container and never for private windows, and are only ever used after GitHub answered the tab's own request, so access checks still apply. Before that, a stored result only hides the pruned diffs on the page GitHub served for that PR, while its HTML is still coming in.
- **No extension storage reads in the page.** What the page needs of the settings (on/off, display modes, whether PRune is off for this repository) and the per-tab on/off state come with the background script's reply about the PR, and open PR tabs are told when settings change, so they ask again.
- **In Chromium, no world of its own.** Content scripts normally run in an isolated world, which costs every tab its own copy of the DOM bindings and builtins: ~170 KB before the script does anything, ~250 KB once it touches the page. PRune's Chromium build runs its content scripts in the page's own JS world instead, where all that already exists. They have no extension APIs there, so they message the background script the way a github.com page can (`externally_connectable`), and the background script treats those messages as the page's: only from github.com tabs, only what a PR page needs, checked field by field, and never anything that changes settings or tells about other repositories or tabs. Firefox, which has no such channel for pages, keeps the isolated world.
- **A PR you've seen is drawn pruned from its first frame.** What PRune showed for it (the pruned files' paths and digests, the totals, the display modes; a few hundred bytes for most PRs) is kept in github.com's `localStorage`, the one store a content script can read before the page renders. On the next visit the stylesheet is built from it at `document_start`, before any diff exists, so it costs no restyle, and when the PR's data arrives and prunes the same files it is not written again. The header counters aren't patched that early (React would find text it didn't render), so each one showing the stored totals gets an attribute with its pruned text, which a static stylesheet shows in its place, set right before the frame that would first draw it. A counter showing other numbers (new commits) isn't marked. At most 50 PRs and 256K characters are kept, least recently used first out; nothing is written in private windows; a PR switched off and any change of settings drop them. GitHub's scripts can read them, but they hold only what GitHub sent.
- **Hiding is one stylesheet.** GitHub gives every file diff the DOM id `diff-<sha256(path)>`, in both the classic and the new React "Files changed" UI. PRune injects a single `<style>` with rules for those ids, and the browser applies it to diffs as they stream in, lazy-load or re-render. There's no per-file JavaScript and no node is ever moved, so React's tree is never disturbed.
- **The stylesheet is written once, and early.** In Chromium, any change to a GitHub page's stylesheets restyles nearly the whole page (~8,000 elements on a PR page, about a second on a 3,000-file diff): GitHub links its `@layer primer-react` CSS 4–5 times, and Chromium then re-matches all of its rules. So the only cheap time to put the sheet in is before the page's first paint, when that restyle is part of the first one, and it is only written again when a PR's pruned files or your settings change. A PR seen before gets it at `document_start` from its pre-render (above); if the page's storage has none, from the stored result as soon as the background script answers (often, not always, before the first paint: the page's own loading goes first). **Show diff** puts an attribute on that one diff and its tree row, and the on/off switch and changing tabs flip one on `<html>`, which only restyles the pruned files. (Firefox only restyles what a changed sheet's ids match, so there the switch takes the sheet out instead.)
- **Pruned diffs shown again render lazily.** Switching PRune off shows every pruned diff again, which GitHub had rendered but the browser never styled or laid out. They get `content-visibility: auto` first, so only those on screen render in that frame, and the rest follow eight per frame, after which nothing of it is left (placeholder heights would throw off jumps to files further down).
- **Counts are patched in place.** The header's text nodes get their `nodeValue` rewritten (never replaced), found by matching the exact totals GitHub reports. They are looked for where GitHub's own ids (`#diffstat`, `#files_tab_counter`, `#prs-files-anchor-tab`) and the last search say they are, a few dozen elements; the whole page is searched only if something is still missing there once the page has loaded. An observer on exactly the patched nodes puts PRune's number back the moment React writes its own, before the page paints.
- **Almost nothing runs outside PRs.** The content script is only injected on PR pages. The rest of GitHub gets a loader of under 1 KB that listens for GitHub's navigation events and imports the content script if you open a PR without a page load. Neither watches the DOM there.
- **Watching only what matters.** While a PR page renders, one `MutationObserver` on the page only schedules a check, and pauses until it has run. Checks are coalesced (at most every 100 ms), do no work when nothing changed, and never read layout (no forced reflows). Once everything PRune needs has been found, the observer moves to the few header elements holding the counters and, for direct children only, the ancestors of what PRune changed or placed (so a re-rendered header is noticed). From then on the diff list, file tree and timeline render, lazy-load and re-render without PRune running at all: no polling, no timers, and nothing to do while you scroll. A whole-page search skips the diff list and file tree, which on a big PR are nearly the whole page, and is made of single class or tag queries, which browsers answer from a fast path.
- **Fast matching.** Slash-free patterns are tested on the file name and, once per directory, on the directory names (Set lookups, `endsWith`, and one combined regex), so 3,000 paths against all defaults take ~1.5 ms, in the background script.
- **Lazy UI, lazily loaded.** Up front there is only the ✂ pill: a button and a short stylesheet, which also draws the icon. (Icons are CSS masks: in Firefox's isolated world an SVG element would have the page set up SVG's DOM interfaces for the content script, ~10 KB. For the same reason it uses attributes rather than `dataset` and `classList`, and `Date.now()` rather than `performance.now()`.) The popover, the "Pruned files" section and collapse mode aren't even in the content script: each is a small module of its own that is imported the first time it's needed (the popover when the pointer reaches the pill, well within the hover delay; the section once its empty placeholder scrolls near the viewport; collapse mode when that setting is on). Most visits never load them, so every PR page compiles and keeps a third less script (41 KB instead of 62 KB, minified, with private member names shortened).

On an 8,161-file PR (`nodejs/node#65161`) that you reload or reopen, PRune spends about 4.5 ms of the page's main-thread time on the conversation tab and ~5.5 ms on the Files changed tab, none of its tasks longer than ~1 ms and ~3.5 ms there (half of that is opening the page's `localStorage` before the first frame, which GitHub does a little later anyway), and keeps ~75–80 KB of memory in the page (`node bench/live.ts`; about 0.5 ms more the first time, to hand the file list over). The pruned numbers and diffs show from the first frame: none of GitHub's numbers and no pruned diff in any frame, where they used to show for 2–6 frames, and on the Files changed tab the pruned numbers are up ~125 ms after navigation instead of ~350 ms or later (`node bench/latency.ts --revisit`). The browser's own work for PRune's changes (style recalculation and layout) is measured too: loading that Files changed tab restyles for ~8 ms instead of ~30 ms (and now and then ~1 s), a small PR's ~7 ms instead of ~100 ms; **Show diff** restyles for ~13 ms instead of ~0.7 s; switching PRune off shows ~190 diffs again in frames of at most ~50 ms instead of one of ~0.25–1.1 s, and back on takes a ~65 ms frame instead of ~0.9 s; going from Files changed to the conversation tab restyles ~11 ms instead of ~0.8 s. Marking the counters adds a few ms of layout to GitHub's own first frames of a conversation tab. Once the page has settled, scrolling through its diffs while GitHub loads more costs nothing. Elsewhere on GitHub it costs ~0.1 ms and under 1 KB. The background script's share (parsing and matching, ~4 ms; next to nothing for a PR it has a result for) runs in the extension's own process. On top of that, compiling the content script takes ~1.5 ms on the first PR page a tab's process shows (later ones reuse V8's compiled copy), and the page keeps its 40 KB of source and ~105–110 KB of bytecode and other compiled-code data, of it up to ~20 KB of optimized machine code for what runs often (`bun run bench:compile`). All told, a PR tab in Chromium costs ~130 KB (conversation) to ~170 KB (Files changed) of JS heap more than without PRune, where an isolated world took ~440–480 KB, and any other GitHub tab nothing measurable, where it took ~200 KB (`bun run bench:worlds`).

## Development

```sh
bun run watch           # rebuild dist/ on change (reload the add-on to pick it up)
bun run dev:firefox     # build + launch Firefox with the add-on (web-ext run)
bun run typecheck
bun run test            # unit tests (matcher, formatting, prune logic, CSS)
bun run test:e2e        # live smoke test on github.com in Chromium (Playwright)
bun run lint:firefox    # Mozilla's add-on linter
bun run package         # dist/prune-{firefox,chrome}-<version>.zip
bun scripts/icons.ts    # regenerate PNG icons from assets/icon.svg
bun run bench           # main-thread CPU, style/layout + page memory on live PRs (Chromium)
bun run bench:memory    # what the page keeps for a 3000-file PR (offline)
bun run bench:latency   # time until the pruned numbers show up
bun run bench:compile   # compile time + code memory of PRune's scripts in the page
bun run bench:worlds    # what a GitHub tab costs in memory, every JS world included (Chromium)
```

```
src/
  shared/      settings, defaults, .gitignore matcher, rule layering,
               file_tree parsing + which files are pruned (run in background/)
  content/     the GitHub content script (PR pages)
    loader.ts  the one for other GitHub pages: loads the content script on soft navigation to a PR
    channel.ts messaging the rest of the extension (from the page's JS world in Chromium)
    chunks.ts  imports the parts below that are only loaded when needed
    route.ts   PR URLs + following GitHub's navigation
    github.ts  URL parsing + GitHub data endpoints
    dom/       stylesheet hiding, header count patching, collapse mode
    ui/        the ✂ pill + popover, the "Pruned files" section (Shadow DOM);
               popover.ts, section-box.ts and dom/collapse.ts are chunks of their own
  background/  parses + prunes file lists for the content script, keeps results by ETag;
               settings + per-tab state for PR tabs; fetches the remote rules file;
               external.ts: what github.com pages may ask (Chromium)
  popup/       toolbar popup
  options/     settings page
scripts/       build + icon generation
tests/         bun unit tests
e2e/           Playwright smoke test
```

## Limitations

- GitHub lists at most 3,000 files per PR (in its UI and API alike), so files beyond that can't be matched. The totals still come from GitHub's own numbers.
- PRune relies on GitHub's page structure and internal endpoints. When GitHub changes them, the counts may stop updating until PRune is updated. Your PR is never modified; everything happens in your browser.
- Only `github.com` is supported for now (no GitHub Enterprise Server).

## License

MIT
