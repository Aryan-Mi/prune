import { ext } from '../shared/browser.ts';
import type { Message } from '../shared/messages.ts';
import { onConfigChanged } from '../shared/settings.ts';
import { cachePartition } from './cache.ts';
import { isPageSender, pageMessage } from './external.ts';
import { lookup, prune } from './pr.ts';
import { refreshOnce } from './remote.ts';
import { notifyTabs, setInactive } from './tabs.ts';

/** A page may open the options at most this often per tab (see external.ts). */
const PAGE_OPTIONS_GAP_MS = 3000;
/** When each tab's page last opened the options. */
const optionsOpened = new Map<number, number>();

function handle(msg: Message, sender: browser.runtime.MessageSender): Promise<unknown> | undefined {
  if (msg.type === 'open-options') return ext.runtime.openOptionsPage();
  if (msg.type === 'refresh-remote') return refreshOnce(msg.force);
  if (msg.type === 'lookup') return lookup(msg, sender);
  if (msg.type === 'prune') return prune(msg, cachePartition(sender));
  if (msg.type === 'set-inactive') return setInactive(sender.tab?.id, msg.keys);
  return undefined;
}

/**
 * Respond via sendResponse + `return true`: works in Firefox and in every
 * Chromium version (returning a Promise is not supported everywhere).
 */
function respond(task: Promise<unknown> | undefined, sendResponse: (value: unknown) => void): true | undefined {
  if (!task) return undefined;
  task.then(
    (value) => sendResponse(value ?? null),
    (err: unknown) => sendResponse({ error: String(err) }),
  );
  return true;
}

// The extension's own pages, and Firefox's content scripts.
ext.runtime.onMessage.addListener((msg: Message, sender, sendResponse: (value: unknown) => void) =>
  respond(handle(msg, sender), sendResponse),
);

if (PRUNE_MAIN_WORLD) {
  // Chromium's content scripts, which run in the page's JS world: answered as the page's (see external.ts).
  ext.runtime.onMessageExternal.addListener((raw: unknown, sender, sendResponse: (value: unknown) => void) => {
    const msg = isPageSender(sender) ? pageMessage(raw) : null;
    if (msg?.type === 'open-options' && !mayOpenOptions(sender.tab!.id!)) return respond(Promise.resolve(null), sendResponse);
    return respond(msg ? handle(msg, sender) : undefined, sendResponse);
  });
}

/** Any script on github.com can ask for the options page: not a tab of them per message. */
function mayOpenOptions(tabId: number): boolean {
  const now = Date.now();
  if (now - (optionsOpened.get(tabId) ?? -Infinity) < PAGE_OPTIONS_GAP_MS) return false;
  optionsOpened.set(tabId, now);
  // Only recent ones matter.
  for (const [id, at] of optionsOpened) if (now - at >= PAGE_OPTIONS_GAP_MS) optionsOpened.delete(id);
  return true;
}

// Content scripts don't read settings themselves (see tabs.ts).
onConfigChanged(() => {
  notifyTabs({ type: 'config-changed' }).catch(() => {});
});

ext.runtime.onStartup.addListener(() => {
  refreshOnce().catch(() => {});
});

ext.runtime.onInstalled.addListener(() => {
  refreshOnce().catch(() => {});
});
