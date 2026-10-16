import { withSection } from '../chunks.ts';
import type { SectionBox } from './section-box.ts';
import type { UiActions, ViewState } from './types.ts';

/**
 * The box is only built once it has stayed in place this long. Until then
 * GitHub may still be loading diffs (the classic UI's first batch is a list of
 * its own), and the box moves after them once the controller notices, about a
 * second later.
 */
const SETTLE_MS = 1000;

/**
 * "Pruned files" box appended after the last file in the diff list (hide
 * mode). Lists hidden files and lets you reveal any of them in place.
 *
 * Nothing but an empty host is built until it comes near the viewport: at the
 * end of a long diff, most visits never get there. Then the box itself
 * (ui/section-box.ts, a chunk of its own) is imported and built.
 */
export class PrunedSection {
  readonly host: HTMLElement;
  private state: ViewState | null = null;
  /** The section has been near the viewport, so the box is (being) built. */
  private near = false;
  private nearby: IntersectionObserver | null = null;
  private nearTimer = 0;
  /** When the host was last (re)placed. */
  private movedAt = 0;
  private box: SectionBox | null = null;

  private readonly actions: UiActions;

  constructor(actions: UiActions) {
    this.actions = actions;
    this.host = document.createElement('div');
    this.host.dataset.pruneUi = 'section';
  }

  /** Appends the section after the diff list; a no-op when already in place. */
  mount(container: Element): void {
    if (this.host.parentElement !== container || container.lastElementChild !== this.host) {
      container.append(this.host);
      this.movedAt = performance.now();
    }
    if (!this.near && !this.nearby) {
      this.nearby = new IntersectionObserver(
        (entries) => {
          clearTimeout(this.nearTimer);
          if (entries.at(-1)?.isIntersecting) this.whenSettled();
        },
        { rootMargin: '1000px 0px' },
      );
      this.nearby.observe(this.host);
    }
  }

  unmount(): void {
    this.host.remove();
    this.stopWatching();
  }

  /** Near the viewport: builds the box once it has stayed in place (moving it far away cancels this). */
  private whenSettled(): void {
    const wait = this.movedAt + SETTLE_MS - performance.now();
    if (wait > 0) {
      this.nearTimer = window.setTimeout(() => this.whenSettled(), wait);
      return;
    }
    this.stopWatching();
    this.near = true;
    withSection(({ SectionBox }) => {
      this.box ??= new SectionBox(this.host, this.actions);
      if (this.state) this.box.render(this.state);
    });
  }

  private stopWatching(): void {
    clearTimeout(this.nearTimer);
    this.nearby?.disconnect();
    this.nearby = null;
  }

  render(state: ViewState): void {
    this.state = state;
    this.box?.render(state);
  }
}
