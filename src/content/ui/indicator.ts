import { withPopover } from '../chunks.ts';
import type { Popover } from './popover.ts';
import { BASE_CSS, styleElement } from './theme.ts';
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
.pill::before {
  content: ""; width: 14px; height: 14px; flex: none; background: currentColor;
  mask: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round'><path d='M6 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.6 5.2 14 12.5M5.6 10.8 14 3.5'/></svg>");
}
.pill.loading::before { opacity: .5; }
@media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
`;

/**
 * The pill shown next to the PR's line counts. Hovering opens a popover with
 * the pruned file list and an on/off switch; clicking pins it open.
 *
 * Only the pill is built up front: a button, its label and a short
 * stylesheet, which also draws the ✂ icon (an SVG element would have the page
 * set up SVG's DOM interfaces in this script's world, ~10 KB). The popover is
 * a chunk of its own (ui/popover.ts), imported when the pointer reaches the
 * pill or it gets focus: within the hover delay, so it still opens right
 * away. Events that arrive meanwhile are handed over once it's there.
 */
export class Indicator implements EventListenerObject {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly pill: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private popover: Popover | null = null;
  /** Pill events waiting for the popover chunk, and when they happened. */
  private queued: [type: string, at: number][] = [];
  private state: ViewState | null = null;
  /** What the pill currently shows, to skip DOM writes when nothing changed. */
  private shown = '';

  private readonly actions: UiActions;

  constructor(actions: UiActions) {
    this.actions = actions;
    // Attributes rather than `dataset` and `classList`: each object type a
    // script touches costs memory in its world (its prototype and methods).
    this.host = document.createElement('span');
    this.host.setAttribute('data-prune-ui', 'indicator');
    this.root = this.host.attachShadow({ mode: 'open' });
    this.pill = document.createElement('button');
    this.pill.className = 'pill';
    this.pill.type = 'button';
    this.pill.setAttribute('aria-haspopup', 'dialog');
    this.pill.setAttribute('aria-expanded', 'false');
    this.label = document.createElement('span');
    this.label.className = 'label';
    this.pill.append(this.label);
    this.root.append(styleElement(BASE_CSS + PILL_CSS), this.pill);
    for (const type of ['pointerenter', 'pointerleave', 'focus', 'click']) this.pill.addEventListener(type, this);
  }

  handleEvent(e: Event): void {
    const at = performance.now();
    if (this.popover) {
      this.popover.pillEvent(e.type, at);
      return;
    }
    this.queued.push([e.type, at]);
    this.actions.needFiles();
    withPopover(({ Popover }) => {
      this.popover ??= new Popover(this, this.actions, this.state);
      for (const [type, at] of this.queued.splice(0)) this.popover.pillEvent(type, at);
    });
  }

  /** Places the pill next to `anchor`, or floating bottom-right if there is none. */
  mount(anchor: Element | null): void {
    const kind = anchor ? '' : 'floating';
    if (this.host.className !== kind) this.host.className = kind;
    if (anchor) {
      if (this.host.parentElement !== anchor || anchor.lastElementChild !== this.host) anchor.append(this.host);
    } else if (this.host.parentElement !== document.body) {
      document.body?.append(this.host);
    }
  }

  unmount(): void {
    this.popover?.close();
    this.host.remove();
  }

  render(state: ViewState): void {
    this.state = state;
    const pruned = state.result?.removed.files ?? 0;
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
      this.pill.className = `pill${active ? ' active' : ''}${state.status === 'loading' ? ' loading' : ''}`;
      this.label.textContent = text;
      this.pill.title = title;
      this.pill.setAttribute('aria-label', ariaLabel);
    }
    this.popover?.render(state);
  }
}
