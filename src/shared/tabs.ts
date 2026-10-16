import { ext } from './browser.ts';
import { PAGE_EVENT, type Message } from './messages.ts';

/**
 * Sends `msg` to the content script in tab `tabId` and resolves with its
 * reply; rejects if the tab has none (gone, or not on github.com).
 *
 * In the Chromium build the content script runs in the page's JS world
 * (world.d.ts), which has no `runtime.onMessage`: `deliver` is run there
 * instead, and hands `msg` over in a DOM event. The page's own scripts can
 * see, and send, such events too; nothing in them is secret, and all they can
 * make the content script do is what the page could do to its own DOM anyway.
 */
export async function sendToTab<T>(tabId: number, msg: Message): Promise<T | undefined> {
  if (!PRUNE_MAIN_WORLD) return (await ext.tabs.sendMessage(tabId, msg)) as T | undefined;
  const [frame] = await ext.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: deliver,
    args: [PAGE_EVENT, msg],
  });
  return frame?.result as T | undefined;
}

/** Runs in the page, so it must not use anything from outside. */
function deliver(type: string, msg: unknown): unknown {
  const detail = { msg, reply: null as unknown };
  dispatchEvent(new CustomEvent(type, { detail }));
  return detail.reply;
}
