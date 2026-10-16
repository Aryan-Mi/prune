import { formatCount } from '../../shared/format.ts';
import { el, icon, ICON_GEAR, ICON_SCISSORS, LIST_CSS, pathElement, statElement, styleElement, whyElement } from './theme.ts';
import type { UiActions, ViewState } from './types.ts';

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

/** The parts of the ✂ pill (indicator.ts) the popover hangs off. */
export interface Pill {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly pill: HTMLButtonElement;
}

/**
 * The ✂ pill's popover: the pruned file list and an on/off switch. Hovering
 * the pill opens it; clicking pins it open.
 *
 * A chunk of its own (see chunks.ts), imported the first time the pointer
 * reaches the pill or it gets focus, and built on first open. The pill hands
 * over its events (`pillEvent`); the popover is the one listener for the rest
 * (`handleEvent`).
 */
export class Popover implements EventListenerObject {
  private readonly ui: Pill;
  private readonly actions: UiActions;
  private popover: HTMLDivElement | null = null;
  private state: ViewState | null;
  private pinned = false;
  private openTimer = 0;
  private closeTimer = 0;
  private dirty = true;

  constructor(ui: Pill, actions: UiActions, state: ViewState | null) {
    this.ui = ui;
    this.actions = actions;
    this.state = state;
    ui.root.addEventListener('keydown', this);
  }

  /** An event on the pill, which happened at `at` (`performance.now()`): it may have waited for this chunk. */
  pillEvent(type: string, at: number): void {
    switch (type) {
      case 'pointerenter':
        this.scheduleOpen(OPEN_DELAY - (performance.now() - at));
        break;
      case 'pointerleave':
        this.scheduleClose();
        break;
      case 'focus':
        this.open();
        break;
      case 'click':
        this.pinned = !this.pinned || !this.isOpen();
        if (this.pinned) this.open();
        else this.close();
        break;
    }
  }

  handleEvent(e: Event): void {
    switch (e.type) {
      case 'pointerenter':
        clearTimeout(this.closeTimer);
        break;
      case 'pointerleave':
        this.scheduleClose();
        break;
      case 'click':
        this.onPopoverClick(e);
        break;
      case 'keydown':
        if ((e as KeyboardEvent).key === 'Escape') {
          this.pinned = false;
          this.close();
          this.ui.pill.focus();
        }
        break;
      case 'scroll':
      case 'resize':
        this.reposition();
        break;
      case 'pointerdown':
        if (!e.composedPath().includes(this.ui.host)) this.close();
        break;
    }
  }

  render(state: ViewState): void {
    this.state = state;
    this.dirty = true;
    if (this.isOpen()) this.renderPopover();
  }

  private isOpen(): boolean {
    return !!this.popover?.matches(':popover-open');
  }

  private scheduleOpen(delay: number): void {
    clearTimeout(this.closeTimer);
    clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => this.open(), Math.max(0, delay));
  }

  private scheduleClose(): void {
    clearTimeout(this.openTimer);
    if (this.pinned) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => this.close(), CLOSE_DELAY);
  }

  private open(): void {
    clearTimeout(this.closeTimer);
    if (this.isOpen() || !this.ui.host.isConnected) return;
    if (!this.popover) {
      this.popover = el('div', 'popover');
      this.popover.popover = 'manual';
      this.popover.setAttribute('role', 'dialog');
      this.popover.setAttribute('aria-label', 'PRune');
      for (const type of ['pointerenter', 'pointerleave', 'click']) this.popover.addEventListener(type, this);
      this.ui.root.append(styleElement(LIST_CSS + POPOVER_CSS), this.popover);
    }
    if (this.dirty) this.renderPopover();
    this.popover.showPopover();
    this.ui.pill.setAttribute('aria-expanded', 'true');
    this.reposition();
    window.addEventListener('scroll', this, { passive: true });
    window.addEventListener('resize', this, { passive: true });
    document.addEventListener('pointerdown', this, true);
  }

  close(): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.pinned = false;
    // Never opened: nothing to undo.
    if (!this.popover) return;
    window.removeEventListener('scroll', this);
    window.removeEventListener('resize', this);
    document.removeEventListener('pointerdown', this, true);
    this.ui.pill.setAttribute('aria-expanded', 'false');
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
    const rect = this.ui.pill.getBoundingClientRect();
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
        el('b', '', `${formatCount(result.removed.files)} of ${formatCount(result.original.files)}`),
        ` file${result.original.files === 1 ? '' : 's'} pruned`,
      );
      summary.append(counts);
      if (result.removed.files > 0) {
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

      if (result.removed.files === 0) {
        frag.append(el('div', 'empty', 'No files in this pull request match your prune rules.'));
      } else if (result.partial) {
        // Asked for when the pointer reached the pill: here in a moment.
        frag.append(el('div', 'empty', 'Loading pruned files…'));
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
