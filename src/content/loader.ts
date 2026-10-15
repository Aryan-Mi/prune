/**
 * The content script for every github.com page that isn't a PR. PR pages get
 * the full content script (index.ts → content.js) directly from the manifest;
 * here the only job is to load it once GitHub soft-navigates to a PR, so the
 * rest of GitHub pays for a few hundred bytes of script and a few event
 * listeners instead of PRune's whole PR logic and a document-wide observer.
 */
import { onNavigation, PR_PATH } from './route.ts';

const stop = onNavigation(() => {
  const path = location.pathname;
  // Spares most pages compiling the pattern.
  if (!path.includes('/pull/') || !PR_PATH.test(path)) return;
  stop();
  // A web-accessible resource; it runs in this content script's world and
  // takes over from here (index.ts handles the page it lands on). `browser` is
  // `chrome` in the Chromium build; spelled out, Mozilla's linter can tell
  // this imports the extension's own file.
  import(browser.runtime.getURL('content.js')).catch((err: unknown) => console.error('[PRune]', err));
});
