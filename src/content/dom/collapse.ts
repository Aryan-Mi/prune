/**
 * "Collapse" mode: clicks GitHub's own collapse toggle once per pruned file, so
 * GitHub unmounts the diff body itself (which also saves rendering work). Files
 * the user re-expands afterwards are left alone.
 */
export class Collapser {
  /** Every digest we were asked to collapse. */
  private known = new Set<string>();
  /** Digests whose diff has not appeared in the DOM yet. */
  private pending: string[] = [];
  /** Digests we actually collapsed (so we can undo it). */
  private collapsed = new Set<string>();

  /** Adds newly pruned files; files already handled are not collapsed again. */
  sync(digests: Iterable<string>): void {
    for (const digest of digests) {
      if (this.known.has(digest)) continue;
      this.known.add(digest);
      this.pending.push(digest);
    }
  }

  /** Some pruned file's diff has not appeared yet. */
  get waiting(): boolean {
    return this.pending.length > 0;
  }

  /** Cheap to call often: only looks up files that have not been collapsed yet. */
  run(): void {
    if (this.pending.length === 0) return;
    this.pending = this.pending.filter((digest) => {
      const toggle = findToggle(digest, 'collapse');
      if (!toggle) return true;
      toggle.click();
      this.collapsed.add(digest);
      return false;
    });
  }

  /** Re-expands what we collapsed, e.g. when pruning is switched off. */
  restore(): void {
    for (const digest of this.collapsed) findToggle(digest, 'expand')?.click();
    this.known.clear();
    this.collapsed.clear();
    this.pending = [];
  }
}

function findToggle(digest: string, action: 'collapse' | 'expand'): HTMLElement | null {
  const file = document.getElementById(`diff-${digest}`);
  if (!file) return null;
  return (
    // New "Files changed" UI.
    file.querySelector<HTMLElement>(`button[aria-label="${action === 'collapse' ? 'Collapse' : 'Expand'} file"]`) ??
    // Classic UI.
    file.querySelector<HTMLElement>(
      `.file-header .js-details-target[aria-expanded="${action === 'collapse' ? 'true' : 'false'}"]`,
    )
  );
}
