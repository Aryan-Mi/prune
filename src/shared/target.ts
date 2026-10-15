declare const __CHROMIUM__: boolean | undefined;

/** Built for Chromium; scripts/build.ts defines `__CHROMIUM__` per target (unit tests run without it). */
export const CHROMIUM = typeof __CHROMIUM__ !== 'undefined' && __CHROMIUM__;
