import { ext } from '../shared/browser.ts';
import type { Message } from '../shared/messages.ts';
import { loadSettings, onConfigChanged, pageSettings } from '../shared/settings.ts';
import { cachePartition } from './cache.ts';
import { lookup, prune } from './pr.ts';
import { refreshOnce } from './remote.ts';
import { notifyTabs, setInactive } from './tabs.ts';

// Respond via sendResponse + `return true`: works in Firefox and in every
// Chromium version (returning a Promise is not supported everywhere).
ext.runtime.onMessage.addListener((msg: Message, sender, sendResponse: (value: unknown) => void) => {
  let task: Promise<unknown> | undefined;
  if (msg.type === 'open-options') task = ext.runtime.openOptionsPage();
  else if (msg.type === 'refresh-remote') task = refreshOnce(msg.force);
  else if (msg.type === 'lookup') task = lookup(msg, sender);
  else if (msg.type === 'prune') task = prune(msg, cachePartition(sender));
  else if (msg.type === 'set-inactive') task = setInactive(sender.tab?.id, msg.keys);
  if (!task) return undefined;
  task.then(
    (value) => sendResponse(value ?? null),
    (err: unknown) => sendResponse({ error: String(err) }),
  );
  return true;
});

// Content scripts don't read settings themselves (see tabs.ts).
onConfigChanged((rulesChanged) => {
  loadSettings()
    .then((settings) => notifyTabs({ type: 'config-changed', settings: pageSettings(settings), rulesChanged }))
    .catch(() => {});
});

ext.runtime.onStartup.addListener(() => {
  refreshOnce().catch(() => {});
});

ext.runtime.onInstalled.addListener(() => {
  refreshOnce().catch(() => {});
});
