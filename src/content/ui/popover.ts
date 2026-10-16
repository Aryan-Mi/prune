import { formatCount } from '../../shared/format.ts';
import { el, icon, LIST_CSS, pathElement, statElement, styleElement, whyElement } from './theme.ts';
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
.icon-gear { --icon: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z'/></svg>"); }
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
    const i = button.getAttribute('data-i');
    if (button.className === 'switch') {
      this.actions.setActive(!state.active);
    } else if (button.className === 'icon-btn') {
      this.actions.openSettings();
    } else if (i !== null) {
      const file = state.result?.pruned[Number(i)];
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
    title.append(icon('scissors'), el('span', '', 'PRune'));
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
        was.className += ' was';
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
          row.setAttribute('data-i', String(i));
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
    settings.append(icon('gear'));
    foot.append(settings);
    frag.append(foot);

    popover.replaceChildren(frag);
    if (this.isOpen()) this.reposition();
  }
}
