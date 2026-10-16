import type { PrunedFile, PruneResult } from '../../shared/prune.ts';
import { formatCount } from '../../shared/format.ts';
import { BASE_CSS, el, icon, LIST_CSS, statElement, styleElement, whyText } from './theme.ts';
import type { UiActions, ViewState } from './types.ts';

const CSS = /* css */ `
:host { display: block; margin: 16px 0 24px; }
.box { border: 1px solid var(--p-border); border-radius: var(--p-radius); background: var(--p-bg); overflow: hidden; }
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; background: var(--p-bg-muted); }
.box.open .bar { border-bottom: 1px solid var(--p-border); }
.title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; cursor: pointer; text-align: left; }
.title strong { font-size: 13px; font-weight: 600; }
.title .mark { color: var(--p-done); }
.icon-chevron { color: var(--p-muted); transition: transform 160ms cubic-bezier(.2,.8,.2,1); transform: rotate(-90deg); }
.box.open .icon-chevron { transform: none; }
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
@media (prefers-reduced-motion: reduce) { .icon-chevron { transition: none; } }
`;

/** Whether the box is expanded. Outlives the section, which is recreated per PR page visit. */
let open = true;

/** The parts of the box that change, once it is built. */
interface Box {
  box: HTMLElement;
  title: HTMLButtonElement;
  count: HTMLElement;
  stat: HTMLElement;
  toggleAll: HTMLButtonElement;
  rows: HTMLElement;
  settings: HTMLButtonElement;
  /** The result the bar and the rows show. */
  shows: PruneResult | null;
  rowsShow: PruneResult | null;
}

/**
 * The "Pruned files" box (see section.ts, which places it): lists the hidden
 * files and lets you reveal any of them in place. A chunk of its own (see
 * chunks.ts), imported once the section comes near the viewport. Renders
 * update the box in place.
 */
export class SectionBox implements EventListenerObject {
  private readonly host: HTMLElement;
  private readonly actions: UiActions;
  private state: ViewState | null = null;
  private ui: Box | null = null;

  constructor(host: HTMLElement, actions: UiActions) {
    this.host = host;
    this.actions = actions;
  }

  render(state: ViewState): void {
    this.state = state;
    const result = state.result;
    if (!result) return;
    const ui = (this.ui ??= this.build());
    ui.box.className = open ? 'box open' : 'box';
    ui.title.setAttribute('aria-expanded', String(open));
    if (ui.shows !== result) {
      ui.shows = result;
      ui.count.textContent = String(result.removed.files);
      const stat = statElement(result.removed.additions, result.removed.deletions);
      ui.stat.replaceWith(stat);
      ui.stat = stat;
    }
    ui.toggleAll.textContent = allRevealed(state) ? 'Hide all diffs' : 'Show all diffs';
    if (open) renderRows(ui, result, state.revealed);
  }

  private build(): Box {
    const root = this.host.attachShadow({ mode: 'open' });
    const box = el('section', 'box');
    box.setAttribute('aria-label', 'Pruned files');

    const bar = el('div', 'bar');
    const title = el('button', 'title');
    title.type = 'button';
    const count = el('span', 'count');
    const stat = el('span');
    title.append(icon('chevron'), icon('scissors', 'mark'), el('strong', '', 'Pruned files'), count, stat);
    const toggleAll = el('button', 'btn');
    toggleAll.type = 'button';
    bar.append(title, toggleAll);

    const rows = el('ul', 'rows');
    const note = el(
      'p',
      'note',
      'These files match your prune rules, so they are hidden above and left out of the line counts. ',
    );
    const settings = el('button', 'link', 'Edit rules');
    settings.type = 'button';
    note.append(settings);
    box.append(bar, rows, note);
    // One listener for every button in the box.
    box.addEventListener('click', this);
    root.append(styleElement(BASE_CSS + LIST_CSS + CSS), box);
    return { box, title, count, stat, toggleAll, rows, settings, shows: null, rowsShow: null };
  }

  handleEvent(e: Event): void {
    const button = (e.target as Element).closest('button');
    const { ui, state } = this;
    const result = state?.result;
    if (!button || !ui || !result) return;
    if (button === ui.title) {
      open = !open;
      this.render(state);
    } else if (button === ui.toggleAll) {
      this.actions.setAllRevealed(!allRevealed(state));
    } else if (button === ui.settings) {
      this.actions.openSettings();
    } else if (button.hasAttribute('data-i')) {
      const file = result.pruned[Number(button.getAttribute('data-i'))];
      if (!file) return;
      const revealed = state.revealed.has(file.digest);
      this.actions.setRevealed(file.digest, !revealed);
      if (!revealed) this.actions.goToFile(file);
    }
  }
}

function allRevealed({ result, revealed }: ViewState): boolean {
  const pruned = result?.pruned ?? [];
  // Most of the time nothing is revealed: don't even look the digests up.
  if (revealed.size < pruned.length) return false;
  return pruned.every((f) => revealed.has(f.digest));
}

/**
 * Builds the rows when the result changed, else only updates which files are
 * revealed. Each row is a clone of one template row, filled in.
 */
function renderRows(ui: Box, result: PruneResult, revealed: ReadonlySet<string>): void {
  const any = revealed.size > 0;
  if (ui.rowsShow !== result) {
    ui.rowsShow = result;
    const template = rowTemplate();
    const frag = document.createDocumentFragment();
    result.pruned.forEach((file, i) => {
      frag.append(fillRow(template.cloneNode(true) as HTMLLIElement, file, i, any && revealed.has(file.digest)));
    });
    ui.rows.replaceChildren(frag);
    return;
  }
  let item = ui.rows.firstElementChild;
  for (const file of result.pruned) {
    if (!item) break;
    const shown = any && revealed.has(file.digest);
    const className = shown ? 'item revealed' : 'item';
    if (item.className !== className) {
      item.className = className;
      item.lastChild!.textContent = shown ? 'Hide diff' : 'Show diff';
    }
    item = item.nextElementSibling;
  }
}

/**
 * `<li class="item">
 *    <div class="name"><span class="path"><bdi><span class="dir"/>name</bdi></span><span class="why"/></div>
 *    <span class="stat"><span class="add"/><span class="del"/></span>
 *    <button class="btn"/>
 *  </li>`
 */
function rowTemplate(): HTMLLIElement {
  const item = el('li', 'item');
  const name = el('div', 'name');
  const path = el('span', 'path');
  const bdi = document.createElement('bdi');
  bdi.append(el('span', 'dir'));
  path.append(bdi);
  name.append(path, el('span', 'why'));
  const stat = el('span', 'stat');
  stat.append(el('span', 'add'), el('span', 'del'));
  const button = el('button', 'btn');
  button.type = 'button';
  item.append(name, stat, button);
  return item;
}

function fillRow(item: HTMLLIElement, file: PrunedFile, i: number, revealed: boolean): HTMLLIElement {
  const name = item.firstChild!;
  const path = name.firstChild as HTMLElement;
  const bdi = path.firstChild as Element;
  const slash = file.path.lastIndexOf('/');
  path.title = file.path;
  if (slash >= 0) bdi.firstChild!.textContent = file.path.slice(0, slash + 1);
  bdi.append(file.path.slice(slash + 1));
  const why = name.lastChild as Element;
  const rule = whyText(file);
  if (rule) why.append(el('code', '', rule), ' · ');
  why.append(file.source);
  const stat = name.nextSibling!;
  stat.firstChild!.textContent = `+${formatCount(file.additions)}`;
  stat.lastChild!.textContent = ` −${formatCount(file.deletions)}`;
  const button = item.lastChild as HTMLElement;
  button.setAttribute('data-i', String(i));
  button.textContent = revealed ? 'Hide diff' : 'Show diff';
  if (revealed) item.className = 'item revealed';
  return item;
}
