/**
 * Where the content scripts run, set per build (scripts/build.ts; false in
 * tests, see bunfig.toml), so each build leaves out the other's code:
 *
 * - Firefox: an isolated world, with the extension APIs.
 * - Chromium: the page's own JS world ("MAIN"). An isolated world costs every
 *   GitHub tab ~170 KB before the script does anything, and ~250 KB once it
 *   touches the DOM (its own wrappers and prototypes for everything); in the
 *   main world the page already has them. Without extension APIs there, the
 *   content scripts message the background script as a web page would
 *   (`externally_connectable`; content/channel.ts), which answers them as it
 *   would any web page (background/external.ts), and are messaged back by
 *   running a function in the page (shared/tabs.ts).
 */
declare const PRUNE_MAIN_WORLD: boolean;
