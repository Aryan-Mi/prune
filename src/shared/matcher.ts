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
  /** Full-path regex; always correct, used to pinpoint which rule matched. */
  re: RegExp;
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

/** Full-path regex source equivalent to a compiled glob. */
export function globToRegexSource(glob: CompiledGlob): string {
  if (glob.kind === 'path') return glob.source;
  const inner = glob.source.slice(1, -1);
  return `^(?:.*/)?${inner}${glob.kind === 'dir' ? '/.*$' : '(?:/.*)?$'}`;
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

/** Compiles one pattern (without `!`); throws if it makes an invalid regex. */
export function compileRule(pattern: string, negated: boolean, source: string): Rule {
  const glob = compileGlob(pattern);
  return { pattern, negated, source, glob, re: new RegExp(globToRegexSource(glob)) };
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
      rules.push(compileRule(line, negated, source));
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
  /** Directory → whether one of its components matches. Files in a PR share few directories. */
  private readonly dirs = new Map<string, boolean>();

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

  /** `dir` is everything before the last slash of `path` (null without one), `name` the rest. */
  test(path: string, dir: string | null, name: string): boolean {
    if (this.name.test(name)) return true;
    if (dir !== null && this.testDir(dir)) return true;
    return this.pathRe?.test(path) ?? false;
  }

  /** The last rule of this segment that matches on its own. */
  rule(path: string): Rule {
    const parts = path.split('/');
    for (let r = this.rules.length - 1; r >= 0; r--) {
      if (ruleMatches(this.rules[r]!, path, parts)) return this.rules[r]!;
    }
    return this.rules[this.rules.length - 1]!;
  }

  private testDir(dir: string): boolean {
    let hit = this.dirs.get(dir);
    if (hit === undefined) {
      const slash = dir.lastIndexOf('/');
      const part = dir.slice(slash + 1);
      hit = (slash >= 0 && this.testDir(dir.slice(0, slash))) || this.name.test(part) || this.dir.test(part);
      this.dirs.set(dir, hit);
    }
    return hit;
  }
}

/** One rule on its own; component tests where possible, so most rule regexes are never compiled. */
function ruleMatches(rule: Rule, path: string, parts: readonly string[]): boolean {
  const { kind, literal, suffix } = rule.glob;
  if (kind === 'path' || (literal === null && suffix === null)) return rule.re.test(path);
  // name: any component · dir: any component but the last.
  const end = kind === 'name' ? parts.length : parts.length - 1;
  for (let i = 0; i < end; i++) {
    if (literal !== null ? parts[i] === literal : parts[i]!.endsWith(suffix!)) return true;
  }
  return false;
}

/** Matches one path component: exact names, `*suffix` patterns, then any other glob. */
class ComponentTest {
  private readonly literals = new Set<string>();
  /** `*suffix` patterns by the suffix's last char code, so a name is only checked against a few. */
  private readonly suffixes = new Map<number, string[]>();
  private sources: string[] = [];
  private re: RegExp | null = null;
  private empty = true;

  add(glob: CompiledGlob): void {
    this.empty = false;
    if (glob.literal !== null) this.literals.add(glob.literal);
    else if (glob.suffix !== null) {
      const key = glob.suffix.charCodeAt(glob.suffix.length - 1);
      const list = this.suffixes.get(key);
      if (list) list.push(glob.suffix);
      else this.suffixes.set(key, [glob.suffix]);
    }
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
    const suffixes = this.suffixes.get(part.charCodeAt(part.length - 1));
    if (suffixes) for (const suffix of suffixes) if (part.endsWith(suffix)) return true;
    return this.re?.test(part) ?? false;
  }
}

/**
 * Evaluates an ordered rule list with last-match-wins semantics. Consecutive
 * rules with the same polarity are merged into one segment, so the common
 * case (no negations) costs a Set lookup and one short regex for the file name,
 * plus the same for each directory not seen before.
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
  private find(path: string): Segment | null {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : null;
    const name = path.slice(slash + 1);
    for (let s = this.segments.length - 1; s >= 0; s--) {
      if (this.segments[s]!.test(path, dir, name)) return this.segments[s]!;
    }
    return null;
  }

  /** Returns the rule that prunes `path`, or null if the path is kept. */
  match(path: string): Rule | null {
    const segment = this.find(path);
    if (!segment || segment.negated) return null;
    return segment.rule(path);
  }

  /** True when a negation rule explicitly keeps this path. */
  isExplicitlyKept(path: string): boolean {
    return this.find(path)?.negated ?? false;
  }
}
