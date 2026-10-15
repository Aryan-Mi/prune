/**
 * Parsing GitHub's `page_data/file_tree` response. Runs in the background
 * script, so none of this is allocated in the GitHub page.
 */

/** One changed file, as reported by GitHub's own `page_data/file_tree` endpoint. */
export interface PrFile {
  path: string;
  /** sha256(path) hex. GitHub uses `diff-<digest>` as the DOM id/anchor of each file diff. */
  digest: string;
  additions: number;
  deletions: number;
  /** Marked `linguist-generated` via .gitattributes. */
  generated: boolean;
}

/** sha256 hex, as GitHub reports it. Digests end up in CSS selectors, so nothing else gets through. */
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * The PR's changed files in GitHub's order, stored column-wise: two string
 * arrays plus typed arrays for the line counts take far less memory than one
 * object per file on a 3000-file PR. The path and digest strings are the ones
 * JSON.parse created, so they're not copied.
 */
export class PrFileList {
  length = 0;
  private readonly paths: string[] = [];
  private readonly digests: string[] = [];
  /** Additions and deletions, interleaved. */
  private readonly lines: Uint32Array;
  private readonly generated: Uint8Array;

  constructor(capacity: number) {
    this.lines = new Uint32Array(capacity * 2);
    this.generated = new Uint8Array(capacity);
  }

  static of(files: readonly PrFile[]): PrFileList {
    const list = new PrFileList(files.length);
    for (const f of files) list.push(f.path, f.digest, f.additions, f.deletions, f.generated);
    return list;
  }

  /** Appends a file; at most `capacity` files fit. */
  push(path: string, digest: string, additions: number, deletions: number, generated: boolean): void {
    const i = this.length++;
    this.paths.push(path);
    this.digests.push(digest);
    this.lines[i * 2] = additions;
    this.lines[i * 2 + 1] = deletions;
    this.generated[i] = generated ? 1 : 0;
  }

  path(i: number): string {
    return this.paths[i]!;
  }

  digest(i: number): string {
    return this.digests[i]!;
  }

  additions(i: number): number {
    return this.lines[i * 2]!;
  }

  deletions(i: number): number {
    return this.lines[i * 2 + 1]!;
  }

  isGenerated(i: number): boolean {
    return this.generated[i] === 1;
  }

  get(i: number): PrFile {
    return {
      path: this.path(i),
      digest: this.digest(i),
      additions: this.additions(i),
      deletions: this.deletions(i),
      generated: this.isGenerated(i),
    };
  }

  /** Plain JSON for extension storage (it can't hold typed arrays): about half the size of GitHub's response. */
  toStored(): StoredFileList {
    const generated: number[] = [];
    for (let i = 0; i < this.length; i++) if (this.generated[i]) generated.push(i);
    return { paths: this.paths, digests: this.digests, lines: Array.from(this.lines.subarray(0, this.length * 2)), generated };
  }

  static fromStored(stored: StoredFileList): PrFileList {
    const n = stored.paths.length;
    const list = new PrFileList(n);
    for (let i = 0; i < n; i++) {
      list.push(stored.paths[i]!, stored.digests[i]!, stored.lines[i * 2] ?? 0, stored.lines[i * 2 + 1] ?? 0, false);
    }
    for (const i of stored.generated) if (i < n) list.generated[i] = 1;
    return list;
  }
}

export interface StoredFileList {
  paths: string[];
  digests: string[];
  /** Additions and deletions, interleaved. */
  lines: number[];
  /** Indexes of linguist-generated files. */
  generated: number[];
}

interface RawDiff {
  path?: string;
  pathDigest?: string;
  linesAdded?: number;
  linesDeleted?: number;
  isGenerated?: boolean;
}

export function parseFileTree(text: string): PrFileList {
  const diffs = (JSON.parse(text) as { diffs?: RawDiff[] }).diffs ?? [];
  // Straight into columns: no intermediate object per file.
  const list = new PrFileList(diffs.length);
  for (const d of diffs) {
    if (!d.path || !d.pathDigest || !DIGEST.test(d.pathDigest)) continue;
    list.push(d.path, d.pathDigest, d.linesAdded ?? 0, d.linesDeleted ?? 0, d.isGenerated === true);
  }
  return list;
}

export interface PrTotals {
  additions: number;
  deletions: number;
  files: number;
}
