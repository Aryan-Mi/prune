import { BASE_CSS, el, icon, ICON_CHEVRON, ICON_SCISSORS, pathElement, statElement, styleElement, whyElement } from './theme.ts';
import type { UiActions, ViewState } from './types.ts';

const CSS = /* css */ `
:host { display: block; margin: 16px 0 24px; }
.box { border: 1px solid var(--p-border); border-radius: var(--p-radius); background: var(--p-bg); overflow: hidden; }
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; background: var(--p-bg-muted); }
.box.open .bar { border-bottom: 1px solid var(--p-border); }
.title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; cursor: pointer; text-align: left; }
.title strong { font-size: 13px; font-weight: 600; }
.title .icon-mark { color: var(--p-done); }
.chevron { color: var(--p-muted); transition: transform 160ms cubic-bezier(.2,.8,.2,1); transform: rotate(-90deg); }
.box.open .chevron { transform: none; }
.count { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--p-done-bg); color: var(--p-done); font-size: 12px; font-weight: 500; line-height: 18px; text-align: center; }
.rows { list-style: none; margin: 0; padding: 0; display: none; }
.box.open .rows { display: block; }
.item { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; column-gap: 12px; padding: 6px 8px 6px 12px; }
.item + .item { border-top: 1px solid var(--p-border-muted); }
.item.revealed { background: var(--p-done-bg); }
.name { display: grid; min-width: 0; }
.why { color: var(--p-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.why code { font-family: var(--p-mono); font-size: 11px; }
.note { display: none; margin: 0; padding: 8px 12px; border-top: 1px solid var(--p-border-muted); color: var(--p-muted); }
.box.open .note { display: block; }
.link { border: 0; background: none; padding: 0; color: var(--p-accent); cursor: pointer; }
.link:hover { text-decoration: underline; }
@media (prefers-reduced-motion: reduce) { .chevron { transition: none; } }
`;

/** Whether the box is expanded. Outlives the section, which is recreated per PR page visit. */
let open = true;

/**
 * "Pruned files" box appended after the last file in the diff list (hide
 * mode). Lists hidden files and lets you reveal any of them in place.
 *
 * The rows are only built once the box comes near the viewport: at the end of
 * a long diff, most visits never get there.
 */
export class PrunedSection {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly style = styleElement(BASE_CSS + CSS);
  private state: ViewState | null = null;
  /** The box has been near the viewport, so its rows are rendered. */
  private near = false;
  private nearby: IntersectionObserver | null = null;

  private readonly actions: UiActions;

  constructor(actions: UiActions) {
    this.actions = actions;
    this.host = document.createElement('div');
    this.host.dataset.pruneUi = 'section';
    this.root = this.host.attachShadow({ mode: 'open' });
  }

  /** Appends the section after the diff list; a no-op when already in place. */
  mount(container: Element): void {
    if (this.host.parentElement !== container || container.lastElementChild !== this.host) container.append(this.host);
    if (!this.near && !this.nearby) {
      this.nearby = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          this.stopWatching();
          this.near = true;
          if (this.state && open) this.render(this.state);
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

  private stopWatching(): void {
    this.nearby?.disconnect();
    this.nearby = null;
  }

  render(state: ViewState): void {
    this.state = state;
    const result = state.result;
    if (!result) return;
    const revealedCount = result.pruned.filter((f) => state.revealed.has(f.digest)).length;
    const allRevealed = revealedCount === result.pruned.length;

    const box = el('section', `box${open ? ' open' : ''}`);
    box.setAttribute('aria-label', 'Pruned files');

    const bar = el('div', 'bar');
    const title = el('button', 'title');
    title.type = 'button';
    title.setAttribute('aria-expanded', String(open));
    const mark = el('span', 'icon-mark');
    mark.append(icon(ICON_SCISSORS));
    title.append(icon(ICON_CHEVRON), mark);
    title.append(el('strong', '', 'Pruned files'), el('span', 'count', String(result.pruned.length)));
    title.append(statElement(result.removed.additions, result.removed.deletions));
    title.addEventListener('click', () => {
      open = !open;
      this.near = true;
      if (this.state) this.render(this.state);
    });
    const toggleAll = el('button', 'btn', allRevealed ? 'Hide all diffs' : 'Show all diffs');
    toggleAll.type = 'button';
    toggleAll.addEventListener('click', () => this.actions.setAllRevealed(!allRevealed));
    bar.append(title, toggleAll);
    box.append(bar);

    const rows = el('ul', 'rows');
    if (open && this.near) {
      result.pruned.forEach((file, i) => {
        const revealed = state.revealed.has(file.digest);
        const item = el('li', `item${revealed ? ' revealed' : ''}`);
        const name = el('div', 'name');
        name.append(pathElement(file.path), whyElement(file));
        const button = el('button', 'btn', revealed ? 'Hide diff' : 'Show diff');
        button.type = 'button';
        button.dataset.i = String(i);
        item.append(name, statElement(file.additions, file.deletions), button);
        rows.append(item);
      });
      // One listener for all rows.
      rows.addEventListener('click', (e) => {
        const i = (e.target as Element).closest<HTMLElement>('button[data-i]')?.dataset.i;
        const file = i === undefined ? undefined : result.pruned[Number(i)];
        if (!file) return;
        const revealed = state.revealed.has(file.digest);
        this.actions.setRevealed(file.digest, !revealed);
        if (!revealed) this.actions.goToFile(file);
      });
    }
    box.append(rows);

    const note = el(
      'p',
      'note',
      'These files match your prune rules, so they are hidden above and left out of the line counts. ',
    );
    const settings = el('button', 'link', 'Edit rules');
    settings.type = 'button';
    settings.addEventListener('click', () => this.actions.openSettings());
    note.append(settings);
    box.append(note);

    this.root.replaceChildren(this.style, box);
  }
}
