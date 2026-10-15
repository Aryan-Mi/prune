/**
 * .gitignore-style path matching.
 *
 * Supported syntax: `#` comments, `!` negation, `*`, `?`, `[...]`, `**`,
 * leading `/` (anchor to repo root) and trailing `/` (directories only).
 * A pattern without a slash matches at any depth, and a pattern that matches a
 * directory also matches everything beneath it.
 *
 * Unlike git, the last matching rule always wins — a `!` rule can re-include a
 * file even when its parent directory was excluded, which is what you want for
 * a review filter.
 */

export interface Rule {
  /** The pattern as written, without the leading `!`. */
  pattern: string;
  negated: boolean;
  /** Human readable origin, e.g. "Built-in · Lockfiles" or "Repo .pruneignore". */
  source: string;
  glob: CompiledGlob;
}

/**
 * How a pattern is evaluated. Slash-free patterns ("name" / "dir") only ever
 * match a single path component, so they are tested per component instead of
 * with a `^(?:.*\/)?…` regex, which backtracks at every slash.
 */
export interface CompiledGlob {
  /** name: any component · dir: any directory component · path: whole path. */
  kind: 'name' | 'dir' | 'path';
  /** For name/dir: `^…$` source for one component. For path: full-path source. */
  source: string;
  /** For name/dir patterns without wildcards: the exact component. */
  literal: string | null;
  /** For name/dir patterns shaped `*<literal>` (e.g. `*.min.js`): the suffix. */
  suffix: string | null;
}

export interface RuleError {
  line: number;
  text: string;
  message: string;
  source: string;
}

export interface ParseResult {
  rules: Rule[];
  errors: RuleError[];
}

const REGEX_SPECIAL = /[.+^${}()|\\]/;

/** Compiles a single gitignore pattern body (no `!`). */
export function compileGlob(raw: string): CompiledGlob {
  let pattern = raw;
  let dirOnly = false;
  if (pattern.endsWith('/') && !pattern.endsWith('\\/')) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, '');
  }
  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  } else if (pattern.includes('/')) {
    // gitignore: a slash anywhere but the end anchors the pattern to the root.
    anchored = true;
  }
  if (pattern === '' || pattern === '**') {
    return { kind: 'path', source: '^.*$', literal: null, suffix: null };
  }

  let out = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0;
        const prevSlash = atStart || pattern[i - 1] === '/';
        const next = pattern[i + 2];
        if (prevSlash && next === '/') {
          // `**/` → zero or more directories
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (prevSlash && next === undefined) {
          // trailing `/**` → everything inside
          out += '.*';
          i += 2;
          continue;
        }
        // `**` elsewhere behaves like `*`
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '[') {
      const end = findClassEnd(pattern, i);
      if (end === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, end);
      let negate = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true;
        body = body.slice(1);
      }
      body = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
      out += `[${negate ? '^/' : ''}${body}]`;
      i = end + 1;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      out += escapeChar(pattern[i + 1]!);
      i += 2;
      continue;
    }
    out += escapeChar(c);
    i += 1;
  }

  if (!anchored) {
    const literal = /[*?[\\]/.test(pattern) ? null : pattern;
    const rest = pattern.slice(1);
    const suffix = pattern.startsWith('*') && rest !== '' && !/[*?[\\]/.test(rest) ? rest : null;
    return { kind: dirOnly ? 'dir' : 'name', source: `^${out}$`, literal, suffix };
  }
  return { kind: 'path', source: `^${out}${dirOnly ? '/.*$' : '(?:/.*)?$'}`, literal: null, suffix: null };
}

function findClassEnd(pattern: string, start: number): number {
  let j = start + 1;
  if (pattern[j] === '!' || pattern[j] === '^') j++;
  if (pattern[j] === ']') j++;
  for (; j < pattern.length; j++) {
    if (pattern[j] === '\\') {
      j++;
      continue;
    }
    if (pattern[j] === ']') return j;
  }
  return -1;
}

function escapeChar(c: string): string {
  return REGEX_SPECIAL.test(c) || c === '[' || c === ']' || c === '*' || c === '?' ? `\\${c}` : c;
}

/** Parses .gitignore-style text into rules. Invalid lines are reported, not thrown. */
export function parseRules(text: string, source: string): ParseResult {
  const rules: Rule[] = [];
  const errors: RuleError[] = [];
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx]!;
    // Trailing whitespace is ignored unless escaped.
    line = line.replace(/(?<!\\)\s+$/, '').replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    if (line === '') continue;
    try {
      const glob = compileGlob(line);
      // Validates the pattern (e.g. `[z-a]` throws). Not kept: compiled regexes
      // are large, and most rules never need one (see matchesGlob).
      new RegExp(glob.source);
      rules.push({ pattern: line, negated, source, glob });
    } catch (err) {
      errors.push({ line: idx + 1, text: lines[idx]!, message: (err as Error).message, source });
    }
  }
  return { rules, errors };
}

/** A run of consecutive rules with the same polarity, evaluated as one unit. */
class Segment {
  readonly negated: boolean;
  readonly rules: Rule[];
  private readonly name = new ComponentTest();
  private readonly dir = new ComponentTest();
  private readonly pathRe: RegExp | null;

  constructor(rules: Rule[]) {
    this.negated = rules[0]!.negated;
    this.rules = rules;
    const pathSources: string[] = [];
    for (const { glob } of rules) {
      if (glob.kind === 'path') pathSources.push(glob.source);
      else (glob.kind === 'name' ? this.name : this.dir).add(glob);
    }
    this.name.seal();
    this.dir.seal();
    this.pathRe = pathSources.length ? new RegExp(pathSources.map((x) => `(?:${x})`).join('|')) : null;
  }

  test(path: string, parts: readonly string[]): boolean {
    const last = parts.length - 1;
    for (let i = 0; i <= last; i++) {
      if (this.name.test(parts[i]!)) return true;
      if (i < last && this.dir.test(parts[i]!)) return true;
    }
    return this.pathRe?.test(path) ?? false;
  }
}

/** Matches one path component: exact names, `*suffix` patterns, then any other glob. */
class ComponentTest {
  private readonly literals = new Set<string>();
  private readonly suffixes: string[] = [];
  private sources: string[] = [];
  private re: RegExp | null = null;
  private empty = true;

  add(glob: CompiledGlob): void {
    this.empty = false;
    if (glob.literal !== null) this.literals.add(glob.literal);
    else if (glob.suffix !== null) this.suffixes.push(glob.suffix);
    // Strip the per-pattern anchors; the combined regex is anchored once.
    else this.sources.push(glob.source.slice(1, -1));
  }

  seal(): void {
    if (this.sources.length) this.re = new RegExp(`^(?:${this.sources.join('|')})$`);
    this.sources = [];
  }

  test(part: string): boolean {
    if (this.empty) return false;
    if (this.literals.has(part)) return true;
    for (const suffix of this.suffixes) if (part.endsWith(suffix)) return true;
    return this.re?.test(part) ?? false;
  }
}

/** Per-rule regexes for `matchesGlob`, compiled on first use. */
const globRegexes = new WeakMap<CompiledGlob, RegExp>();

function globRegex(glob: CompiledGlob): RegExp {
  let re = globRegexes.get(glob);
  if (!re) {
    re = new RegExp(glob.source);
    globRegexes.set(glob, re);
  }
  return re;
}

/**
 * Tests a single rule the way its segment does, used to pinpoint which rule
 * matched. Exact names and `*suffix` patterns need no regex at all.
 */
function matchesGlob(glob: CompiledGlob, path: string, parts: readonly string[]): boolean {
  if (glob.kind === 'path') return globRegex(glob).test(path);
  // A directory pattern never matches the last component (the file name).
  const end = glob.kind === 'dir' ? parts.length - 1 : parts.length;
  for (let i = 0; i < end; i++) {
    const part = parts[i]!;
    if (glob.literal !== null) {
      if (part === glob.literal) return true;
    } else if (glob.suffix !== null) {
      if (part.endsWith(glob.suffix)) return true;
    } else if (globRegex(glob).test(part)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates an ordered rule list with last-match-wins semantics. Consecutive
 * rules with the same polarity are merged into one segment, so the common
 * case (no negations) costs a Set lookup and one short regex per path component.
 */
export class Matcher {
  readonly rules: readonly Rule[];
  private readonly segments: Segment[] = [];

  constructor(rules: readonly Rule[]) {
    this.rules = rules;
    let current: Rule[] = [];
    for (const rule of rules) {
      if (current.length > 0 && current[0]!.negated !== rule.negated) {
        this.segments.push(new Segment(current));
        current = [];
      }
      current.push(rule);
    }
    if (current.length > 0) this.segments.push(new Segment(current));
  }

  /** The last segment that matches `path`, if any. */
  private find(path: string, parts: readonly string[]): Segment | null {
    for (let s = this.segments.length - 1; s >= 0; s--) {
      if (this.segments[s]!.test(path, parts)) return this.segments[s]!;
    }
    return null;
  }

  /** Returns the rule that prunes `path`, or null if the path is kept. */
  match(path: string): Rule | null {
    const parts = path.split('/');
    const segment = this.find(path, parts);
    if (!segment || segment.negated) return null;
    for (let r = segment.rules.length - 1; r >= 0; r--) {
      if (matchesGlob(segment.rules[r]!.glob, path, parts)) return segment.rules[r]!;
    }
    return segment.rules[segment.rules.length - 1]!;
  }

  /** True when a negation rule explicitly keeps this path. */
  isExplicitlyKept(path: string): boolean {
    return this.find(path, path.split('/'))?.negated ?? false;
  }
}
