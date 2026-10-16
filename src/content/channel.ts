/**
 * How the content scripts reach the rest of the extension: with the extension
 * APIs in Firefox's isolated world, as a web page would in Chromium, where
 * they run in the page's own JS world (see world.d.ts). There, the page's
 * scripts share every global with them: what they need is taken when this
 * script starts (at document_start on PR pages, before any of the page's;
 * after them when the loader imports it), and nothing is left in the page's
 * globals but listeners.
 */
import { ext } from '../shared/browser.ts';
import { PAGE_EVENT, type Message } from '../shared/messages.ts';
import { extensionBaseUrl } from './base.ts';

interface PageRuntime {
  sendMessage(extensionId: string, message: unknown, reply: (value: unknown) => void): void;
  lastError?: { message?: string };
}

/** `chrome-extension://<id>/` in the main world, for the chunks' URLs (chunks.ts). */
export const BASE_URL = PRUNE_MAIN_WORLD ? extensionBaseUrl() : '';
/** The page's `chrome.runtime`: just `sendMessage` and `connect`, to extensions that let github.com reach them. */
const runtime = PRUNE_MAIN_WORLD ? (globalThis as { chrome?: { runtime?: PageRuntime } }).chrome?.runtime : undefined;
const sendMessage = runtime?.sendMessage;

/** Messages the background script; it replies `{ error }` when something failed. */
export async function send<T = unknown>(msg: Message): Promise<T> {
  const reply = (PRUNE_MAIN_WORLD ? await sendFromPage(msg) : await ext.runtime.sendMessage(msg)) as
    | T
    | { error: string }
    | undefined;
  if (reply && typeof reply === 'object' && 'error' in reply) throw new Error(reply.error);
  return reply as T;
}

function sendFromPage(msg: Message): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!runtime || !sendMessage || !BASE_URL) throw new Error('PRune: no connection to the extension');
    sendMessage.call(runtime, BASE_URL.slice(19, -1), msg, (reply) => {
      // Read, or Chromium logs it as unchecked.
      const error = runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(reply);
    });
  });
}

/** Calls `handler` with each message to this tab (from the popup or the background script) and replies with what it returns. */
export function onMessage(handler: (msg: Message) => unknown): void {
  if (PRUNE_MAIN_WORLD) {
    // Run in the page by shared/tabs.ts. Pages can send these too: `handler`
    // must only do what the page could do itself.
    window.addEventListener(PAGE_EVENT, (e) => {
      const detail = (e as CustomEvent<{ msg?: Message; reply?: unknown } | null>).detail;
      if (detail && typeof detail.msg === 'object' && detail.msg) detail.reply = handler(detail.msg);
    });
    return;
  }
  ext.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
    const reply = handler(msg);
    if (reply !== undefined) sendResponse(reply);
    return undefined;
  });
}
