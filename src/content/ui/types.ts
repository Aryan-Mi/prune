import type { PrFile } from '../../shared/filetree.ts';
import type { PruneResult } from '../../shared/prune.ts';

export type ViewStatus = 'loading' | 'ready' | 'error';

export interface ViewState {
  status: ViewStatus;
  error?: string;
  result: PruneResult | null;
  /** Pruning switched on for this PR (the in-page toggle). */
  active: boolean;
  /** Active rule sources, for display. */
  sources: string[];
  revealed: ReadonlySet<string>;
  isDiffView: boolean;
}

export interface UiActions {
  setActive(active: boolean): void;
  setRevealed(digest: string, revealed: boolean): void;
  setAllRevealed(revealed: boolean): void;
  goToFile(file: PrFile): void;
  openSettings(): void;
  /** The ✂ popover is about to show the pruned files: a summary won't do any more (see shared/prune.ts). */
  needFiles(): void;
}
