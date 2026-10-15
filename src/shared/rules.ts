import { DEFAULT_GROUPS } from './defaults.ts';
import { compileRule, Matcher, parseRules, type Rule, type RuleError } from './matcher.ts';
import type { Settings } from './settings.ts';

export interface RuleInputs {
  /** Contents of the repository's .pruneignore, if found. */
  repoText?: string | null;
  /** Path of the repository config file that was found, for display. */
  repoPath?: string | null;
  /** Contents of the user's remote rules file, if configured. */
  remoteText?: string | null;
}

export interface CompiledRules {
  matcher: Matcher;
  errors: RuleError[];
  /** Short labels of the active rule sources, in precedence order. */
  sources: string[];
}

const builtinCache = new Map<string, Rule[]>();

function builtinRules(groupId: string): Rule[] {
  let rules = builtinCache.get(groupId);
  if (!rules) {
    const group = DEFAULT_GROUPS.find((g) => g.id === groupId)!;
    // Plain patterns, so no need to parse them as rule-file text.
    rules = group.patterns.map((pattern) => compileRule(pattern, false, `Built-in · ${group.label}`));
    builtinCache.set(groupId, rules);
  }
  return rules;
}

/**
 * Precedence, lowest to highest (last match wins):
 * built-in groups → repository .pruneignore → remote file → personal rules.
 * Your own rules always get the final say in your own browser.
 */
export function compileRules(settings: Settings, inputs: RuleInputs = {}): CompiledRules {
  const rules: Rule[] = [];
  const errors: RuleError[] = [];
  const sources: string[] = [];

  const enabledGroups = DEFAULT_GROUPS.filter((g) => !settings.disabledGroups.includes(g.id));
  for (const group of enabledGroups) rules.push(...builtinRules(group.id));
  if (enabledGroups.length > 0) sources.push('Built-in defaults');

  const add = (text: string | null | undefined, source: string) => {
    if (!text) return;
    const parsed = parseRules(text, source);
    rules.push(...parsed.rules);
    errors.push(...parsed.errors);
    if (parsed.rules.length > 0) sources.push(source);
  };
  if (settings.useRepoConfig) add(inputs.repoText, `Repo ${inputs.repoPath ?? '.pruneignore'}`);
  if (settings.remoteUrl) add(inputs.remoteText, 'Remote rules file');
  add(settings.userPatterns, 'Your rules');

  return { matcher: new Matcher(rules), errors, sources };
}
