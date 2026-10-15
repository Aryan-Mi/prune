/**
 * Built-in prune rules, grouped so they can be toggled individually from the
 * options page. Patterns use .gitignore syntax (see matcher.ts).
 */
export interface PatternGroup {
  id: string;
  label: string;
  description: string;
  patterns: readonly string[];
}

export const DEFAULT_GROUPS: readonly PatternGroup[] = [
  {
    id: 'lockfiles',
    label: 'Lockfiles',
    description: 'Dependency lockfiles from every common package manager.',
    patterns: [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      'bun.lockb',
      'deno.lock',
      'Cargo.lock',
      'Gemfile.lock',
      'composer.lock',
      'poetry.lock',
      'Pipfile.lock',
      'uv.lock',
      'pdm.lock',
      'pylock.toml',
      'go.sum',
      'go.work.sum',
      'mix.lock',
      'pubspec.lock',
      'Podfile.lock',
      'Package.resolved',
      'packages.lock.json',
      'paket.lock',
      'flake.lock',
      'gradle.lockfile',
      'MODULE.bazel.lock',
      'conan.lock',
      '.terraform.lock.hcl',
      'cabal.project.freeze',
      'stack.yaml.lock',
      'renv.lock',
      '.pnp.cjs',
      '.pnp.loader.mjs',
      '.yarn/releases/',
      '.yarn/plugins/',
      '.yarn/sdks/',
    ],
  },
  {
    id: 'minified',
    label: 'Minified files & source maps',
    description: 'Minified bundles and source maps are never reviewed by hand.',
    patterns: ['*.min.js', '*.min.mjs', '*.min.cjs', '*.min.css', '*.map'],
  },
  {
    id: 'snapshots',
    label: 'Test snapshots',
    description: 'Jest/Vitest/Insta style snapshot files.',
    patterns: ['__snapshots__/', '*.snap', '*.ambr'],
  },
  {
    id: 'generated',
    label: 'Generated code',
    description: 'Code emitted by protobuf, GraphQL, ORM, router and UI code generators.',
    patterns: [
      '__generated__/',
      '*.generated.*',
      '*.gen.ts',
      '*.gen.go',
      '*_gen.go',
      'zz_generated*.go',
      '*.pb.go',
      '*.pb.gw.go',
      '*.pb.cc',
      '*.pb.h',
      '*.pb.swift',
      '*_pb2.py',
      '*_pb2.pyi',
      '*_pb2_grpc.py',
      '*_pb.js',
      '*_pb.d.ts',
      '*_grpc_pb.js',
      '*.g.dart',
      '*.freezed.dart',
      '*.mocks.dart',
      '*.g.cs',
      '*.Designer.cs',
      '*.designer.cs',
      'routeTree.gen.ts',
      'next-env.d.ts',
      'worker-configuration.d.ts',
      '*.tsbuildinfo',
    ],
  },
  {
    id: 'vendored',
    label: 'Vendored dependencies & build output',
    description: 'Committed dependencies and compiled output directories.',
    patterns: ['node_modules/', 'vendor/', 'dist/', '.next/', 'coverage/'],
  },
];

/** Repository config file names, checked in order at the repository root. */
export const REPO_CONFIG_PATHS = ['.pruneignore', '.github/pruneignore'] as const;
