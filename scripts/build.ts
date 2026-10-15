/**
 * Builds the extension for Firefox and/or Chromium into dist/<target>.
 *
 *   bun scripts/build.ts                    # both targets
 *   bun scripts/build.ts --target=firefox   # one target
 *   bun scripts/build.ts --watch            # rebuild on change
 *   bun scripts/build.ts --package          # also zip into dist/*.zip
 *   bun scripts/build.ts --readable         # don't minify the content scripts
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import pkg from '../package.json' with { type: 'json' };
import { PR_MATCH } from '../src/content/route.ts';

type Target = 'firefox' | 'chrome';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  }),
);
const targets: Target[] = args.has('target') ? [args.get('target') as Target] : ['firefox', 'chrome'];
const watch = args.has('watch');
const shouldPackage = args.has('package');
const readable = args.has('readable');
const root = join(import.meta.dir, '..');

const ICON_SIZES = [16, 32, 48, 96, 128] as const;

/**
 * Parts of the content script imported only when needed (src/content/chunks.ts),
 * each an ES module of its own. Each is bundled with everything it uses, so it
 * imports nothing (a few small helpers are in content.js too).
 */
const CONTENT_CHUNKS = {
  popover: 'src/content/ui/popover.ts',
  section: 'src/content/ui/section-box.ts',
  collapse: 'src/content/dom/collapse.ts',
};

function manifest(target: Target) {
  const icons = Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-${s}.png`]));
  return {
    manifest_version: 3,
    name: 'PRune',
    short_name: 'PRune',
    version: pkg.version,
    description: pkg.description,
    homepage_url: 'https://github.com/Aryan-Mi/prune',
    icons,
    permissions: ['storage'],
    // Only requested at runtime, for the optional remote rules file URL.
    optional_host_permissions: ['https://*/*'],
    // Everywhere else on GitHub only a tiny loader runs, which imports
    // content.js if the tab soft-navigates to a PR.
    content_scripts: [
      {
        matches: ['https://github.com/*'],
        exclude_matches: [PR_MATCH],
        js: ['loader.js'],
        run_at: 'document_start',
      },
      {
        matches: [PR_MATCH],
        js: ['content.js'],
        run_at: 'document_start',
      },
    ],
    // For the loader's import() of content.js, and content.js's of its chunks.
    // Chromium serves them from a per-session random URL only, so pages can't
    // probe for the extension; Firefox's moz-extension:// URLs are random per
    // install anyway.
    web_accessible_resources: [
      {
        resources: ['content.js', ...Object.keys(CONTENT_CHUNKS).map((name) => `${name}.js`)],
        matches: ['https://github.com/*'],
        ...(target === 'chrome' ? { use_dynamic_url: true } : {}),
      },
    ],
    background: target === 'firefox' ? { scripts: ['background.js'] } : { service_worker: 'background.js' },
    action: {
      default_title: 'PRune',
      default_popup: 'popup.html',
      default_icon: icons,
    },
    options_ui: { page: 'options.html', open_in_tab: true },
    ...(target === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'prune@aryan-mi.github.io',
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['none'] },
            },
            gecko_android: { strict_min_version: '142.0' },
          },
        }
      : { minimum_chrome_version: '120' }),
  };
}

/**
 * Strips the whitespace from the content script's `/* css *\/` template
 * literals (the shadow DOM styles): less script to parse on every github.com
 * page, less CSS to parse when the UI is built. Only removes what is never
 * significant in these styles (indentation, newlines, spaces around `{};,`
 * and after `:`), so no CSS parser is needed. Templates with `${}` or
 * escapes are left alone.
 */
const minifyCssTemplates: esbuild.Plugin = {
  name: 'minify-css-templates',
  setup(build) {
    build.onLoad({ filter: /src[\\/]content[\\/].*\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const contents = source.replace(/\/\* css \*\/ `([^`$\\]*)`/g, (_, css: string) => {
        const min = css
          .replace(/\s+/g, ' ')
          .replace(/ ?([{};,]) ?/g, '$1')
          .replace(/;}/g, '}')
          .replace(/: /g, ':')
          .trim();
        return `\`${min}\``;
      });
      return { contents, loader: 'ts' };
    });
  },
};

function esbuildOptions(target: Target): esbuild.BuildOptions[] {
  const common: esbuild.BuildOptions = {
    outdir: join(root, 'dist', target),
    bundle: true,
    format: 'iife',
    target: target === 'firefox' ? ['firefox140'] : ['chrome120'],
    legalComments: 'none',
    // Escape non-ASCII characters (\u2212 etc.): a single one makes the engine
    // keep the whole script source as UTF-16, doubling its memory.
    charset: 'ascii',
    logLevel: 'warning',
  };
  const contentScript: esbuild.BuildOptions = {
    ...common,
    minify: !readable,
    plugins: readable ? [] : [minifyCssTemplates],
  };
  return [
    // Loaded into github.com tabs, so they are minified (~40% smaller source
    // to keep in memory and parse). Rebuild unminified with --readable to
    // debug them.
    {
      ...contentScript,
      entryPoints: { content: join(root, 'src/content/index.ts') },
      define: target === 'chrome' ? { browser: 'chrome' } : {},
    },
    {
      ...contentScript,
      entryPoints: Object.fromEntries(Object.entries(CONTENT_CHUNKS).map(([name, path]) => [name, join(root, path)])),
      format: 'esm',
    },
    {
      ...common,
      entryPoints: { loader: join(root, 'src/content/loader.ts') },
      minify: !readable,
      define: target === 'chrome' ? { browser: 'chrome' } : {},
    },
    // Readable output: easier to debug and to get through store review.
    {
      ...common,
      entryPoints: {
        background: join(root, 'src/background/index.ts'),
        popup: join(root, 'src/popup/popup.ts'),
        options: join(root, 'src/options/options.ts'),
        'popup-style': join(root, 'src/popup/popup.css'),
        'options-style': join(root, 'src/options/options.css'),
      },
    },
  ];
}

async function writeStatic(target: Target): Promise<void> {
  const out = join(root, 'dist', target);
  await mkdir(out, { recursive: true });
  await Promise.all([
    cp(join(root, 'public'), out, { recursive: true }),
    cp(join(root, 'src/popup/popup.html'), join(out, 'popup.html')),
    cp(join(root, 'src/options/options.html'), join(out, 'options.html')),
    writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest(target), null, 2)}\n`),
  ]);
}

async function packageTarget(target: Target): Promise<void> {
  const proc = Bun.spawn(
    [
      join(root, 'node_modules/.bin/web-ext'),
      'build',
      '--source-dir',
      join(root, 'dist', target),
      '--artifacts-dir',
      join(root, 'dist'),
      '--filename',
      `prune-${target}-${pkg.version}.zip`,
      '--overwrite-dest',
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await proc.exited) !== 0) throw new Error(`Packaging ${target} failed`);
}

for (const target of targets) {
  await rm(join(root, 'dist', target), { recursive: true, force: true });
  await writeStatic(target);
  if (watch) {
    for (const options of esbuildOptions(target)) await (await esbuild.context(options)).watch();
    console.log(`watching dist/${target}`);
  } else {
    await Promise.all(esbuildOptions(target).map((options) => esbuild.build(options)));
    if (shouldPackage) await packageTarget(target);
    console.log(`built dist/${target}`);
  }
}
