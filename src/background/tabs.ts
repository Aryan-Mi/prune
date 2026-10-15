import { ext } from '../shared/browser.ts';
import type { Message } from '../shared/messages.ts';

/**
 * Tabs that have opened a PR, with the PRs switched off in each. Kept here
 * (storage.session) rather than in the page's sessionStorage, so the content
 * script gets them with its first message instead of reading storage itself,
 * and so settings changes can be pushed to exactly these tabs.
 */
const TABS_KEY = 'tabs';

type Tabs = Record<string, string[]>;

let tabs: Promise<Tabs> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function readTabs(): Promise<Tabs> {
  tabs ??= ext.storage.session
    .get(TABS_KEY)
    .then((stored) => (stored[TABS_KEY] as Tabs | undefined) ?? {})
    .catch(() => ({}));
  return tabs;
}

function update(change: (all: Tabs) => boolean): Promise<void> {
  const task = async () => {
    const all = await readTabs();
    if (change(all)) await ext.storage.session.set({ [TABS_KEY]: all }).catch(() => {});
  };
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

/** Registers the tab for settings updates; returns the PRs switched off in it. */
export async function openTab(tabId: number | undefined): Promise<string[]> {
  if (tabId === undefined) return [];
  const inactive = (await readTabs())[tabId];
  if (inactive) return inactive;
  update((all) => {
    if (all[tabId]) return false;
    all[tabId] = [];
    return true;
  }).catch(() => {});
  return [];
}

export function setInactive(tabId: number | undefined, keys: string[]): Promise<void> {
  if (tabId === undefined) return Promise.resolve();
  return update((all) => {
    all[tabId] = keys;
    return true;
  });
}

/** Sends `msg` to every registered tab, forgetting tabs that are gone or have left GitHub. */
export async function notifyTabs(msg: Message): Promise<void> {
  const ids = Object.keys(await readTabs()).map(Number);
  const gone: number[] = [];
  await Promise.all(ids.map((id) => ext.tabs.sendMessage(id, msg).catch(() => gone.push(id))));
  if (gone.length) {
    await update((all) => {
      for (const id of gone) delete all[id];
      return true;
    });
  }
}
