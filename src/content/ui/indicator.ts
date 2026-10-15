import { formatCount } from '../../shared/format.ts';
import {
  BASE_CSS,
  el,
  icon,
  ICON_GEAR,
  ICON_SCISSORS,
  LIST_CSS,
  pathElement,
  statElement,
  styleElement,
  whyElement,
} from './theme.ts';
import type { UiActions, ViewState } from './types.ts';

const PILL_CSS = /* css */ `
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
@media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
`;

/** Added with the popover, on first open. */
const POPOVER_CSS = /* css */ `
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

.head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; }
.title { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; flex: 1; }
.title .icon { color: var(--p-done); }
.toggle-label { color: var(--p-muted); font-size: 12px; cursor: pointer; user-select: none; }
.switch {
  position: relative; width: 32px; height: 18px; flex: none; border-radius: 9px; border: 0; padding: 0;
  background: var(--p-border); cursor: pointer; transition: background-color 120ms ease-out;
}
.switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px #0003; transition: transform 160ms cubic-bezier(.2,.8,.2,1);
}
.switch[aria-checked="true"] { background: var(--p-done); }
.switch[aria-checked="true"]::after { transform: translateX(14px); }
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
@media (prefers-reduced-motion: reduce) { .popover, .switch, .switch::after { transition: none; } }
`;

const OPEN_DELAY = 120;
const CLOSE_DELAY = 220;

/**
 * The pill shown next to the PR's line counts. Hovering opens a popover with
 * the pruned file list and an on/off switch; clicking pins it open.
 *
 * Only the pill is built up front (a button, an icon and a short stylesheet);
 * the popover and its styles are added on first open. The indicator itself is
 * the one event listener for everything (`handleEvent`).
 */
export class Indicator implements EventListenerObject {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly pill: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private popover: HTMLDivElement | null = null;
  private state: ViewState | null = null;
  /** What the pill currently shows, to skip DOM writes when nothing changed. */
  private shown = '';
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
    this.root.append(styleElement(BASE_CSS + PILL_CSS), this.pill);
    for (const type of ['pointerenter', 'pointerleave', 'focus', 'click']) this.pill.addEventListener(type, this);
    this.root.addEventListener('keydown', this);
  }

  handleEvent(e: Event): void {
    switch (e.type) {
      case 'pointerenter':
        if (e.currentTarget === this.pill) this.scheduleOpen();
        else clearTimeout(this.closeTimer);
        break;
      case 'pointerleave':
        this.scheduleClose();
        break;
      case 'focus':
        this.open();
        break;
      case 'click':
        if (e.currentTarget === this.pill) {
          this.pinned = !this.pinned || !this.isOpen();
          if (this.pinned) this.open();
          else this.close();
        } else {
          this.onPopoverClick(e);
        }
        break;
      case 'keydown':
        if ((e as KeyboardEvent).key === 'Escape') {
          this.pinned = false;
          this.close();
          this.pill.focus();
        }
        break;
      case 'scroll':
      case 'resize':
        this.reposition();
        break;
      case 'pointerdown':
        if (!e.composedPath().includes(this.host)) this.close();
        break;
    }
  }

  /** Places the pill next to `anchor`, or floating bottom-right if there is none. */
  mount(anchor: Element | null): void {
    // toggle() with a force only writes the class attribute if it changes (remove() always does).
    this.host.classList.toggle('floating', !anchor);
    if (anchor) {
      if (this.host.parentElement !== anchor || anchor.lastElementChild !== this.host) anchor.append(this.host);
    } else if (this.host.parentElement !== document.body) {
      document.body?.append(this.host);
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
    let text: string;
    if (state.status === 'loading') text = 'PRune';
    else if (state.status === 'error') text = 'PRune ⚠';
    else if (!state.active) text = 'Prune off';
    else text = `${pruned} pruned`;
    const title = state.status === 'error' ? `PRune: ${state.error}` : '';
    const ariaLabel =
      state.status === 'ready'
        ? `PRune: ${pruned} file${pruned === 1 ? '' : 's'} pruned${state.active ? '' : ' (pruning off)'}`
        : 'PRune';
    const shown = `${active}\n${text}\n${title}\n${ariaLabel}`;
    if (shown !== this.shown) {
      this.shown = shown;
      this.pill.classList.toggle('active', active);
      this.pill.classList.toggle('loading', state.status === 'loading');
      this.label.textContent = text;
      this.pill.title = title;
      this.pill.setAttribute('aria-label', ariaLabel);
    }
    if (this.isOpen()) this.renderPopover();
  }

  private isOpen(): boolean {
    return !!this.popover?.matches(':popover-open');
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
    if (!this.popover) {
      this.popover = el('div', 'popover');
      this.popover.popover = 'manual';
      this.popover.setAttribute('role', 'dialog');
      this.popover.setAttribute('aria-label', 'PRune');
      for (const type of ['pointerenter', 'pointerleave', 'click']) this.popover.addEventListener(type, this);
      this.root.append(styleElement(LIST_CSS + POPOVER_CSS), this.popover);
    }
    if (this.dirty) this.renderPopover();
    this.popover.showPopover();
    this.pill.setAttribute('aria-expanded', 'true');
    this.reposition();
    window.addEventListener('scroll', this, { passive: true });
    window.addEventListener('resize', this, { passive: true });
    document.addEventListener('pointerdown', this, true);
  }

  private close(): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.pinned = false;
    // Never opened: nothing to undo.
    if (!this.popover) return;
    window.removeEventListener('scroll', this);
    window.removeEventListener('resize', this);
    document.removeEventListener('pointerdown', this, true);
    this.pill.setAttribute('aria-expanded', 'false');
    if (this.isOpen()) this.popover.hidePopover();
  }

  private onPopoverClick(e: Event): void {
    const button = (e.target as Element).closest('button');
    const state = this.state;
    if (!button || !state) return;
    if (button.classList.contains('switch')) {
      this.actions.setActive(!state.active);
    } else if (button.classList.contains('icon-btn')) {
      this.actions.openSettings();
    } else if (button.dataset.i !== undefined) {
      const file = state.result?.pruned[Number(button.dataset.i)];
      if (!file) return;
      this.close();
      this.actions.goToFile(file);
    }
  }

  private reposition(): void {
    const popover = this.popover;
    if (!popover) return;
    const rect = this.pill.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 && rect.top - height - 6 > 8 ? rect.top - height - 6 : below;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  private renderPopover(): void {
    const state = this.state;
    const popover = this.popover;
    if (!state || !popover) return;
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
        el('b', '', `${formatCount(result.pruned.length)} of ${formatCount(result.original.files)}`),
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
          el('div', '', `GitHub lists only the first ${formatCount(result.listed)} files; the rest can't be checked.`),
        );
      }
      frag.append(summary);

      if (result.pruned.length === 0) {
        frag.append(el('div', 'empty', 'No files in this pull request match your prune rules.'));
      } else {
        // Rows are handled by the popover's click listener (onPopoverClick).
        const list = el('ul', 'list');
        result.pruned.forEach((file, i) => {
          const li = el('li');
          const row = el('button', 'row');
          row.type = 'button';
          row.dataset.i = String(i);
          row.title = `${file.path}\nMatched “${file.rule}” · ${file.source}\nClick to view the diff`;
          row.append(pathElement(file.path), statElement(file.additions, file.deletions), whyElement(file));
          li.append(row);
          list.append(li);
        });
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
    foot.append(settings);
    frag.append(foot);

    popover.replaceChildren(frag);
    if (this.isOpen()) this.reposition();
  }
}
