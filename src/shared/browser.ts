/**
 * Firefox exposes the promise-based `browser` namespace; Chromium exposes
 * `chrome`, which is promise-based in MV3 for every API we use.
 */
export const ext: typeof browser =
  (globalThis as { browser?: typeof browser }).browser ??
  (globalThis as unknown as { chrome: typeof browser }).chrome;
