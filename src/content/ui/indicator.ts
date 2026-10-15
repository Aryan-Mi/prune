import { BASE_CSS, el, icon, ICON_GEAR, ICON_SCISSORS, pathElement, statElement, styleElement, whyElement } from './theme.ts';
import type { UiActions, ViewState } from './types.ts';

const CSS = /* css */ `
:host { display: inline-flex; vertical-align: middle; margin-left: 8px; }
:host(.floating) { position: fixed; right: 16px; bottom: 16px; z-index: 100; margin: 0; }
:host(.floating) .pill { box-shadow: var(--shadow-floating-small, 0 1px 3px #0002); background: var(--p-bg); }
.pill {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px 0 6px;
  border-radius: 999px; border: 1px solid var(--p-border); background: transparent;
  color: var(--p-muted); cursor: pointer; font-size: 12px; font-weight: 500; line-height: 20px;
  transition: background-color 120ms ease-out, color 120ms ease-out, border-color 120ms ease-out;
}
.pill:hover, .pill[aria-expanded="true"] { background: var(--p-hover); color: var(--p-fg); }
.pill.active { color: var(--p-done); border-color: color-mix(in srgb, var(--p-done) 40%, transparent); background: var(--p-done-bg); }
.pill.active:hover, .pill.active[aria-expanded="true"] { background: color-mix(in srgb, var(--p-done) 18%, transparent); }
.pill.loading .icon { opacity: .5; }
.pill .icon { width: 14px; height: 14px; }

.popover {
  position: fixed; inset: auto; margin: 0; padding: 0; width: 380px; max-width: calc(100vw - 16px);
  border: 1px solid var(--p-border); border-radius: 12px; background: var(--p-bg); color: var(--p-fg);
  box-shadow: var(--shadow-floating-large, 0 8px 24px #4247524d);
  font: 400 12px/1.5 var(--p-font); overflow: hidden;
  opacity: 0; transform: translateY(-4px) scale(.98); transform-origin: top right;
  transition: opacity 120ms ease-out, transform 160ms cubic-bezier(.2,.8,.2,1), display 160ms allow-discrete, overlay 160ms allow-discrete;
}
.popover:popover-open { opacity: 1; transform: none; }
@starting-style { .popover:popover-open { opacity: 0; transform: translateY(-4px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .popover, .pill { transition: none; } }

.head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; }
.title { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; flex: 1; }
.title .icon { color: var(--p-done); }
.toggle-label { color: var(--p-muted); font-size: 12px; cursor: pointer; user-select: none; }
.summary { padding: 0 12px 10px; color: var(--p-muted); display: grid; gap: 2px; }
.summary b { color: var(--p-fg); font-weight: 600; }
.compare { display: flex; align-items: center; gap: 6px; }
.compare .arrow { color: var(--p-muted); }
.compare .was { opacity: .6; text-decoration: line-through; text-decoration-thickness: 1px; }
.list { list-style: none; margin: 0; padding: 4px; max-height: 280px; overflow: auto; border-top: 1px solid var(--p-border-muted); overscroll-behavior: contain; }
.row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; align-items: baseline;
  width: 100%; padding: 6px 8px; border: 0; border-radius: var(--p-radius); background: transparent; text-align: left; cursor: pointer;
}
.row:hover { background: var(--p-hover); }
.why { grid-column: 1 / -1; color: var(--p-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.why code { font-family: var(--p-mono); font-size: 11px; color: var(--p-fg); }
.empty { padding: 12px; color: var(--p-muted); border-top: 1px solid var(--p-border-muted); }
.error { color: var(--p-danger); }
.foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--p-border-muted); background: var(--p-bg-muted); }
.foot .sources { flex: 1; min-width: 0; color: var(--p-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { display: inline-grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: var(--p-radius); background: transparent; color: var(--p-muted); cursor: pointer; }
.icon-btn:hover { background: var(--p-hover); color: var(--p-fg); }
`;

const OPEN_DELAY = 120;
const CLOSE_DELAY = 220;

/**
 * The pill shown next to the PR's line counts. Hovering opens a popover with
 * the pruned file list and an on/off switch; clicking pins it open.
 */
export class Indicator {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly pill: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private readonly popover: HTMLDivElement;
  private state: ViewState | null = null;
  private pinned = false;
  private openTimer = 0;
  private closeTimer = 0;
  private dirty = true;

  private readonly actions: UiActions;

  constructor(actions: UiActions) {
    this.actions = actions;
    this.host = document.createElement('span');
    this.host.dataset.pruneUi = 'indicator';
    this.root = this.host.attachShadow({ mode: 'open' });
    this.pill = el('button', 'pill');
    this.pill.type = 'button';
    this.pill.setAttribute('aria-haspopup', 'dialog');
    this.pill.setAttribute('aria-expanded', 'false');
    this.label = el('span', 'label');
    this.pill.append(icon(ICON_SCISSORS), this.label);
    this.popover = el('div', 'popover');
    this.popover.popover = 'manual';
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', 'PRune');
    this.root.append(styleElement(BASE_CSS + CSS), this.pill, this.popover);

    this.pill.addEventListener('pointerenter', () => this.scheduleOpen());
    this.pill.addEventListener('pointerleave', () => this.scheduleClose());
    this.popover.addEventListener('pointerenter', () => clearTimeout(this.closeTimer));
    this.popover.addEventListener('pointerleave', () => this.scheduleClose());
    this.pill.addEventListener('focus', () => this.open());
    this.pill.addEventListener('click', () => {
      this.pinned = !this.pinned || !this.isOpen();
      if (this.pinned) this.open();
      else this.close();
    });
    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') {
        this.pinned = false;
        this.close();
        this.pill.focus();
      }
    });
    this.onDocPointerDown = this.onDocPointerDown.bind(this);
    this.reposition = this.reposition.bind(this);
  }

  /** Places the pill next to `anchor`, or floating bottom-right if there is none. */
  mount(anchor: Element | null): void {
    if (anchor) {
      this.host.classList.remove('floating');
      if (this.host.parentElement !== anchor || anchor.lastElementChild !== this.host) anchor.append(this.host);
    } else {
      this.host.classList.add('floating');
      if (this.host.parentElement !== document.body) document.body?.append(this.host);
    }
  }

  unmount(): void {
    this.close();
    this.host.remove();
  }

  render(state: ViewState): void {
    this.state = state;
    this.dirty = true;
    const pruned = state.result?.pruned.length ?? 0;
    const active = state.active && state.status === 'ready' && pruned > 0;
    this.pill.classList.toggle('active', active);
    this.pill.classList.toggle('loading', state.status === 'loading');
    let text: string;
    if (state.status === 'loading') text = 'PRune';
    else if (state.status === 'error') text = 'PRune ⚠';
    else if (!state.active) text = 'Prune off';
    else text = `${pruned} pruned`;
    this.label.textContent = text;
    this.pill.title = state.status === 'error' ? `PRune: ${state.error}` : '';
    this.pill.setAttribute(
      'aria-label',
      state.status === 'ready'
        ? `PRune: ${pruned} file${pruned === 1 ? '' : 's'} pruned${state.active ? '' : ' (pruning off)'}`
        : 'PRune',
    );
    if (this.isOpen()) this.renderPopover();
  }

  private isOpen(): boolean {
    return this.popover.matches(':popover-open');
  }

  private scheduleOpen(): void {
    clearTimeout(this.closeTimer);
    clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => this.open(), OPEN_DELAY);
  }

  private scheduleClose(): void {
    clearTimeout(this.openTimer);
    if (this.pinned) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => this.close(), CLOSE_DELAY);
  }

  private open(): void {
    clearTimeout(this.closeTimer);
    if (this.isOpen() || !this.host.isConnected) return;
    if (this.dirty) this.renderPopover();
    this.popover.showPopover();
    this.pill.setAttribute('aria-expanded', 'true');
    this.reposition();
    window.addEventListener('scroll', this.reposition, { passive: true });
    window.addEventListener('resize', this.reposition, { passive: true });
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  private close(): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.pinned = false;
    window.removeEventListener('scroll', this.reposition);
    window.removeEventListener('resize', this.reposition);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    this.pill.setAttribute('aria-expanded', 'false');
    if (this.isOpen()) this.popover.hidePopover();
  }

  private onDocPointerDown(e: Event): void {
    if (!e.composedPath().includes(this.host)) this.close();
  }

  private reposition(): void {
    const rect = this.pill.getBoundingClientRect();
    const width = this.popover.offsetWidth;
    const height = this.popover.offsetHeight;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 && rect.top - height - 6 > 8 ? rect.top - height - 6 : below;
    this.popover.style.left = `${Math.round(left)}px`;
    this.popover.style.top = `${Math.round(top)}px`;
  }

  private renderPopover(): void {
    const state = this.state;
    if (!state) return;
    this.dirty = false;
    const result = state.result;
    const frag = document.createDocumentFragment();

    const head = el('div', 'head');
    const title = el('div', 'title');
    title.append(icon(ICON_SCISSORS), el('span', '', 'PRune'));
    const switchId = 'prune-switch';
    const toggleLabel = el('label', 'toggle-label', state.active ? 'Pruning on' : 'Pruning off');
    toggleLabel.htmlFor = switchId;
    const toggle = el('button', 'switch');
    toggle.id = switchId;
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(state.active));
    toggle.setAttribute('aria-label', 'Prune files on this pull request');
    toggle.addEventListener('click', () => this.actions.setActive(!state.active));
    head.append(title, toggleLabel, toggle);
    frag.append(head);

    if (state.status === 'loading') {
      frag.append(el('div', 'empty', 'Loading changed files…'));
    } else if (state.status === 'error' || !result) {
      const msg = el('div', 'empty error', `Couldn't load the file list: ${state.error ?? 'unknown error'}`);
      frag.append(msg);
    } else {
      const summary = el('div', 'summary');
      const counts = el('div');
      counts.append(
        el('b', '', `${result.pruned.length.toLocaleString()} of ${result.original.files.toLocaleString()}`),
        ` file${result.original.files === 1 ? '' : 's'} pruned`,
      );
      summary.append(counts);
      if (result.pruned.length > 0) {
        const compare = el('div', 'compare');
        const was = statElement(result.original.additions, result.original.deletions);
        was.classList.add('was');
        compare.append(was, el('span', 'arrow', '→'), statElement(result.kept.additions, result.kept.deletions));
        summary.append(compare);
      }
      if (result.listed < result.original.files) {
        summary.append(
          el('div', '', `GitHub lists only the first ${result.listed.toLocaleString()} files; the rest can't be checked.`),
        );
      }
      frag.append(summary);

      if (result.pruned.length === 0) {
        frag.append(el('div', 'empty', 'No files in this pull request match your prune rules.'));
      } else {
        const list = el('ul', 'list');
        for (const file of result.pruned) {
          const li = el('li');
          const row = el('button', 'row');
          row.type = 'button';
          row.title = `${file.path}\nMatched “${file.rule}” · ${file.source}\nClick to view the diff`;
          row.append(pathElement(file.path), statElement(file.additions, file.deletions), whyElement(file));
          row.addEventListener('click', () => {
            this.close();
            this.actions.goToFile(file);
          });
          li.append(row);
          list.append(li);
        }
        frag.append(list);
      }
    }

    const foot = el('div', 'foot');
    foot.append(el('span', 'sources', state.sources.length ? `Rules: ${state.sources.join(' · ')}` : 'No active rules'));
    const settings = el('button', 'icon-btn');
    settings.type = 'button';
    settings.title = 'PRune settings';
    settings.setAttribute('aria-label', 'PRune settings');
    settings.append(icon(ICON_GEAR));
    settings.addEventListener('click', () => this.actions.openSettings());
    foot.append(settings);
    frag.append(foot);

    this.popover.replaceChildren(frag);
    if (this.isOpen()) this.reposition();
  }
}

