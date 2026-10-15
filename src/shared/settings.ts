import { ext } from './browser.ts';

/** How pruned files appear in the "Files changed" diff list. */
export type DiffMode = 'hide' | 'collapse' | 'show';
/** How pruned files appear in the file tree sidebar. */
export type TreeMode = 'hide' | 'dim';

export interface Settings {
  enabled: boolean;
  /** Built-in groups (see defaults.ts) that are switched off. */
  disabledGroups: string[];
  /** User rules in .gitignore syntax. Evaluated after built-in rules. */
  userPatterns: string;
  /** Read `.pruneignore` from the repository being viewed. */
  useRepoConfig: boolean;
  /** Treat files GitHub marks as generated (`linguist-generated` in .gitattributes) as pruned. */
  respectLinguistGenerated: boolean;
  /** Optional URL of a .pruneignore-style file that is fetched and kept in sync. */
  remoteUrl: string;
  diffMode: DiffMode;
  treeMode: TreeMode;
  /** `owner/repo` (lowercase) where PRune is switched off. */
  disabledRepos: string[];
}

/** Cached copy of the remote rules file, stored separately from settings. */
export interface RemoteCache {
  url: string;
  text: string;
  fetchedAt: number;
  error?: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  disabledGroups: [],
  userPatterns: '',
  useRepoConfig: true,
  respectLinguistGenerated: true,
  remoteUrl: '',
  diffMode: 'hide',
  treeMode: 'hide',
  disabledRepos: [],
});

const SETTINGS_KEY = 'settings';
export const REMOTE_KEY = 'remoteCache';
/** Remote rules are refreshed when older than this. */
export const REMOTE_TTL_MS = 60 * 60 * 1000;

export function normalizeSettings(raw: unknown): Settings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const pickArray = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS.enabled,
    disabledGroups: pickArray(value.disabledGroups),
    userPatterns: typeof value.userPatterns === 'string' ? value.userPatterns : '',
    useRepoConfig: typeof value.useRepoConfig === 'boolean' ? value.useRepoConfig : DEFAULT_SETTINGS.useRepoConfig,
    respectLinguistGenerated:
      typeof value.respectLinguistGenerated === 'boolean'
        ? value.respectLinguistGenerated
        : DEFAULT_SETTINGS.respectLinguistGenerated,
    remoteUrl: typeof value.remoteUrl === 'string' ? value.remoteUrl.trim() : '',
    diffMode: value.diffMode === 'collapse' || value.diffMode === 'show' ? value.diffMode : 'hide',
    treeMode: value.treeMode === 'dim' ? 'dim' : 'hide',
    disabledRepos: pickArray(value.disabledRepos).map((r) => r.toLowerCase()),
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await ext.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await ext.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function loadRemoteCache(): Promise<RemoteCache | null> {
  const stored = await ext.storage.local.get(REMOTE_KEY);
  const value = stored[REMOTE_KEY] as RemoteCache | undefined;
  return value && typeof value.text === 'string' ? value : null;
}

/** Calls `listener` whenever settings or the remote rule cache change. */
export function onConfigChanged(listener: () => void): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (SETTINGS_KEY in changes || REMOTE_KEY in changes)) listener();
  });
}

export function isRepoDisabled(settings: Settings, repo: string): boolean {
  return settings.disabledRepos.includes(repo.toLowerCase());
}
