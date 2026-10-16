/**
 * `chrome-extension://<id>/`, for content scripts in the page's JS world
 * (Chromium; see world.d.ts), which has no `runtime.getURL()` or
 * `runtime.id`. The calling script's own URL shows in stack traces; this
 * formats them as V8 does by default, even if the page has customized them.
 * Empty if there is no such URL.
 */
export function extensionBaseUrl(): string {
  const E = Error as unknown as { prepareStackTrace?: unknown; stackTraceLimit: number };
  const { prepareStackTrace, stackTraceLimit } = E;
  try {
    E.prepareStackTrace = undefined;
    E.stackTraceLimit = 1;
    return /chrome-extension:\/\/[a-p]{32}\//.exec(new Error().stack ?? '')?.[0] ?? '';
  } catch {
    return '';
  } finally {
    try {
      E.prepareStackTrace = prepareStackTrace;
      E.stackTraceLimit = stackTraceLimit;
    } catch {
      // Left as the page made them.
    }
  }
}
