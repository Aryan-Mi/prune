import { ext } from '../shared/browser.ts';
import type { Message, TabStatus } from '../shared/messages.ts';
import { loadSettings, saveSettings, type Settings } from '../shared/settings.ts';

const globalToggle = document.getElementById('global') as HTMLInputElement;
const globalLabel = document.getElementById('global-label')!;
const tabEl = document.getElementById('tab')!;

let settings: Settings;
let tabId: number | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function stat(additions: number, deletions: number, className = ''): HTMLElement {
  return h(
    'span',
    { className: `stat ${className}` },
    h('span', { className: 'add', textContent: `+${additions.toLocaleString()}` }),
    ' ',
    h('span', { className: 'del', textContent: `−${deletions.toLocaleString()}` }),
  );
}

async function send(message: Message): Promise<TabStatus | null> {
  if (tabId === undefined) return null;
  try {
    return ((await ext.tabs.sendMessage(tabId, message)) as TabStatus | undefined) ?? null;
  } catch {
    return null; // Not a GitHub tab, or the content script isn't loaded yet.
  }
}

function switchRow(id: string, title: string, hint: string, checked: boolean, onChange: (on: boolean) => void) {
  const input = h('input', { id, className: 'switch', type: 'checkbox', checked });
  input.setAttribute('role', 'switch');
  input.addEventListener('change', () => onChange(input.checked));
  return h(
    'div',
    { className: 'row' },
    h('label', { htmlFor: id }, title, h('small', { textContent: hint })),
    input,
  );
}

function render(status: TabStatus | null): void {
  globalToggle.checked = settings.enabled;
  globalLabel.textContent = settings.enabled ? 'On' : 'Off';

  if (!status || !status.pr) {
    tabEl.replaceChildren(
      h('p', {
        className: 'empty',
        textContent: 'Open a pull request on github.com to see what PRune prunes.',
      }),
    );
    return;
  }

  const nodes: Node[] = [
    h('div', { className: 'pr' }, h('span', { className: 'pr-name', textContent: status.pr })),
  ];

  if (status.status === 'loading') {
    nodes.push(h('p', { className: 'empty', textContent: 'Loading changed files…' }));
  } else if (status.status === 'error') {
    nodes.push(h('p', { className: 'error', textContent: `Couldn't load the file list: ${status.error ?? ''}` }));
  } else if (status.status === 'ready' && status.original && status.kept) {
    nodes.push(
      h(
        'div',
        { className: 'big' },
        h('strong', { textContent: status.pruned.toLocaleString() }),
        h('span', {
          className: 'muted',
          textContent: `of ${status.original.files.toLocaleString()} files pruned`,
        }),
      ),
    );
    if (status.pruned > 0) {
      nodes.push(
        h(
          'div',
          { className: 'compare' },
          stat(status.original.additions, status.original.deletions, 'was'),
          h('span', { className: 'muted', textContent: '→' }),
          stat(status.kept.additions, status.kept.deletions),
        ),
      );
    }
    nodes.push(
      switchRow('pr-active', 'Prune this pull request', 'Turn off to see the original diff', status.active, async (on) => {
        render(await send({ type: 'set-active', active: on }));
      }),
    );
  }

  if (status.repo) {
    const repoKey = status.repo.toLowerCase();
    const repoOn = !settings.disabledRepos.includes(repoKey);
    nodes.push(
      switchRow(
        'repo-active',
        `Enabled on ${status.repo}`,
        status.repoConfigPath ? `Using the repo's ${status.repoConfigPath}` : 'No .pruneignore in this repo',
        repoOn,
        async (on) => {
          const disabledRepos = settings.disabledRepos.filter((r) => r !== repoKey);
          if (!on) disabledRepos.push(repoKey);
          settings = await saveSettings({ disabledRepos });
          // Content script reacts to the storage change; give it a tick.
          setTimeout(async () => render(await send({ type: 'get-status' })), 50);
        },
      ),
    );
  }

  if (status.sources.length) {
    nodes.push(h('p', { className: 'muted', textContent: `Rules: ${status.sources.join(' · ')}` }));
  }
  tabEl.replaceChildren(...nodes);
}

async function main(): Promise<void> {
  settings = await loadSettings();
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;

  globalToggle.addEventListener('change', async () => {
    settings = await saveSettings({ enabled: globalToggle.checked });
    setTimeout(async () => render(await send({ type: 'get-status' })), 50);
  });
  document.getElementById('settings')!.addEventListener('click', () => {
    ext.runtime.openOptionsPage();
    window.close();
  });

  // Keep the numbers fresh while the page is still loading its file list.
  const refresh = async () => {
    const status = await send({ type: 'get-status' });
    render(status);
    if (status?.status === 'loading') setTimeout(refresh, 300);
  };
  await refresh();
}

main();
