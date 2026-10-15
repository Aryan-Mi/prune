/**
 * What both content scripts need to follow GitHub's navigation. Kept apart
 * from the rest so the loader (loader.ts) stays a few hundred bytes.
 */

/**
 * A PR page's path: owner, repo, number, then the tab and its sub-path. The
 * manifest's PR match pattern (PR_MATCH in scripts/build.ts) must match every
 * path this does.
 */
export const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/([^/]+)(\/[^/]+)?)?/;

const NAVIGATION_EVENTS = ['soft-nav:render', 'soft-nav:end', 'turbo:load', 'popstate'];

/**
 * Calls `listener` after GitHub may have shown another page without a page
 * load: its soft navigations (Turbo and React alike dispatch `soft-nav:*`),
 * Turbo visits and history traversal. Where the Navigation API exists
 * (Chromium, recent Firefox) it also reports every other URL change. These are
 * DOM events, so they reach content scripts' isolated worlds; the page's own
 * `history.pushState` calls don't. Returns a function that stops listening.
 */
export function onNavigation(listener: () => void): () => void {
  const navigation = (globalThis as { navigation?: EventTarget }).navigation;
  // Captured on the window, which every event in the page passes through:
  // touching `document` would cost ~16 KB (its wrapper and prototype chain in
  // this world) on pages where nothing else needs it.
  for (const type of NAVIGATION_EVENTS) window.addEventListener(type, listener, true);
  navigation?.addEventListener('navigatesuccess', listener);
  return () => {
    for (const type of NAVIGATION_EVENTS) window.removeEventListener(type, listener, true);
    navigation?.removeEventListener('navigatesuccess', listener);
  };
}
