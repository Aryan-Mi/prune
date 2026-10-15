import { ext } from '../shared/browser.ts';
import { DEFAULT_GROUPS } from '../shared/defaults.ts';
import type { Message } from '../shared/messages.ts';
import { parseRules } from '../shared/matcher.ts';
import { compileRules } from '../shared/rules.ts';
import {
  loadRemoteCache,
  loadSettings,
  onConfigChanged,
  saveSettings,
  type RemoteCache,
  type Settings,
} from '../shared/settings.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let remote: RemoteCache | null = null;

// ---- Saving feedback ----------------------------------------------------

let savedTimer = 0;
function flashSaved(): void {
  const el = $('saved');
  el.textContent = 'Saved';
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => el.classList.remove('show'), 1400);
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  flashSaved();
  renderTester();
}

// ---- General & display ----------------------------------------------------

const SWITCHES = ['enabled', 'useRepoConfig', 'respectLinguistGenerated'] as const;

function renderGeneral(): void {
  for (const key of SWITCHES) $<HTMLInputElement>(key).checked = settings[key];
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="diffMode"]')) {
    input.checked = input.value === settings.diffMode;
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="treeMode"]')) {
    input.checked = input.value === settings.treeMode;
  }
}

function bindGeneral(): void {
  for (const key of SWITCHES) {
    $<HTMLInputElement>(key).addEventListener('change', (e) => save({ [key]: (e.target as HTMLInputElement).checked }));
  }
  for (const name of ['diffMode', 'treeMode'] as const) {
    for (const input of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
      input.addEventListener('change', () => {
        if (input.checked) save({ [name]: input.value } as Partial<Settings>);
      });
    }
  }
}

// ---- Your rules ----------------------------------------------------------

function validateRules(text: string): void {
  const { errors } = parseRules(text, 'Your rules');
  const el = $('rule-errors');
  el.hidden = errors.length === 0;
  el.textContent = errors.map((e) => `Line ${e.line}: ${e.text.trim()} — ${e.message}`).join('\n');
}

function bindRules(): void {
  const textarea = $<HTMLTextAreaElement>('userPatterns');
  let timer = 0;
  textarea.addEventListener('input', () => {
    validateRules(textarea.value);
    clearTimeout(timer);
    timer = window.setTimeout(() => save({ userPatterns: textarea.value }), 400);
  });

  const fileInput = $<HTMLInputElement>('import-file');
  $('import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const text = (await file.text()).replace(/\r\n/g, '\n').trimEnd();
    const current = textarea.value.trimEnd();
    textarea.value = current ? `${current}\n\n# Imported from ${file.name}\n${text}\n` : `${text}\n`;
    validateRules(textarea.value);
    await save({ userPatterns: textarea.value });
  });

  $('export').addEventListener('click', () => {
    const blob = new Blob([textarea.value], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: '.pruneignore' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

// ---- Path tester -----------------------------------------------------------

function renderTester(): void {
  const path = $<HTMLInputElement>('test-path').value.trim().replace(/^\/+/, '');
  const out = $('test-result');
  out.classList.remove('pruned');
  if (!path) {
    out.textContent = 'Type a file path to see which rule applies.';
    return;
  }
  const remoteText = remote && remote.url === settings.remoteUrl ? remote.text : null;
  const { matcher } = compileRules(settings, { remoteText });
  const rule = matcher.match(path);
  if (rule) {
    out.classList.add('pruned');
    out.replaceChildren('Pruned by ', Object.assign(document.createElement('code'), { textContent: rule.pattern }), ` (${rule.source})`);
  } else if (matcher.isExplicitlyKept(path)) {
    out.textContent = 'Kept: a ! rule re-includes it.';
  } else {
    out.textContent = 'Kept: no rule matches. (Repository .pruneignore rules are not included in this test.)';
  }
}

// ---- Remote rules file -------------------------------------------------

function renderRemote(): void {
  const status = $('remote-status');
  status.classList.remove('error');
  if (!settings.remoteUrl) {
    status.textContent = 'No URL set.';
    return;
  }
  if (!remote || remote.url !== settings.remoteUrl) {
    status.textContent = 'Not fetched yet.';
    return;
  }
  const when = new Date(remote.fetchedAt).toLocaleString();
  const count = parseRules(remote.text, 'Remote').rules.length;
  if (remote.error) {
    status.classList.add('error');
    status.textContent = `Last attempt ${when}: ${remote.error}${remote.text ? ` (using the previous copy with ${count} rules)` : ''}`;
  } else {
    status.textContent = `${count} rule${count === 1 ? '' : 's'} loaded · fetched ${when}`;
  }
}

function bindRemote(): void {
  const input = $<HTMLInputElement>('remoteUrl');
  const button = $<HTMLButtonElement>('remote-save');
  button.addEventListener('click', () => {
    const value = input.value.trim();
    let origin: string | null = null;
    if (value) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:') throw new Error('Use an https:// URL');
        origin = `${url.origin}/*`;
      } catch (err) {
        $('remote-status').textContent = err instanceof Error && err.message.startsWith('Use') ? err.message : 'That is not a valid URL.';
        $('remote-status').classList.add('error');
        return;
      }
    }
    // permissions.request must run synchronously inside the click handler.
    const granted = origin ? ext.permissions.request({ origins: [origin] }).catch(() => false) : Promise.resolve(true);
    button.disabled = true;
    $('remote-status').textContent = value ? 'Fetching…' : '';
    granted
      .then(() => save({ remoteUrl: value }))
      .then(() => ext.runtime.sendMessage({ type: 'refresh-remote', force: true } satisfies Message))
      .then(async () => {
        remote = await loadRemoteCache();
        renderRemote();
        renderTester();
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

// ---- Built-in groups -----------------------------------------------------

function renderGroups(): void {
  const container = $('groups');
  container.replaceChildren(
    ...DEFAULT_GROUPS.map((group) => {
      const on = !settings.disabledGroups.includes(group.id);
      const id = `group-${group.id}`;
      const wrap = document.createElement('div');
      wrap.className = `group${on ? '' : ' off'}`;

      const head = document.createElement('div');
      head.className = 'group-head';
      const label = document.createElement('label');
      label.htmlFor = id;
      label.append(
        Object.assign(document.createElement('strong'), { textContent: group.label }),
        Object.assign(document.createElement('small'), { textContent: group.description }),
      );
      const input = Object.assign(document.createElement('input'), { id, type: 'checkbox', className: 'switch', checked: on });
      input.setAttribute('role', 'switch');
      input.addEventListener('change', () => {
        const disabledGroups = settings.disabledGroups.filter((g) => g !== group.id);
        if (!input.checked) disabledGroups.push(group.id);
        wrap.classList.toggle('off', !input.checked);
        save({ disabledGroups });
      });
      head.append(label, input);

      const details = document.createElement('details');
      const summary = Object.assign(document.createElement('summary'), {
        textContent: `${group.patterns.length} patterns`,
      });
      const chips = document.createElement('div');
      chips.className = 'chips';
      chips.append(...group.patterns.map((p) => Object.assign(document.createElement('code'), { textContent: p })));
      details.append(summary, chips);

      wrap.append(head, details);
      return wrap;
    }),
  );
}

// ---- Disabled repositories ----------------------------------------------

function renderRepos(): void {
  const list = $('repos');
  if (settings.disabledRepos.length === 0) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'None. PRune runs on every repository.' }));
    return;
  }
  list.replaceChildren(
    ...settings.disabledRepos.map((repo) => {
      const li = document.createElement('li');
      const button = Object.assign(document.createElement('button'), {
        className: 'btn small',
        type: 'button',
        textContent: 'Enable',
      });
      button.addEventListener('click', async () => {
        await save({ disabledRepos: settings.disabledRepos.filter((r) => r !== repo) });
        renderRepos();
      });
      li.append(repo, button);
      return li;
    }),
  );
}

// ---- Boot ----------------------------------------------------------------

function renderAll(): void {
  renderGeneral();
  renderGroups();
  renderRepos();
  renderRemote();
  renderTester();
}

async function main(): Promise<void> {
  [settings, remote] = await Promise.all([loadSettings(), loadRemoteCache()]);
  $<HTMLTextAreaElement>('userPatterns').value = settings.userPatterns;
  $<HTMLInputElement>('remoteUrl').value = settings.remoteUrl;
  validateRules(settings.userPatterns);
  renderAll();
  bindGeneral();
  bindRules();
  bindRemote();
  $('test-path').addEventListener('input', renderTester);

  // Keep in sync with changes made from the popup or another options tab.
  onConfigChanged(async () => {
    [settings, remote] = await Promise.all([loadSettings(), loadRemoteCache()]);
    renderGeneral();
    renderRepos();
    renderRemote();
  });
}

main();
