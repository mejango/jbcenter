import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createKnowledgeBundle,
  MAX_BUNDLE_BYTES,
  MAX_DOCUMENT_CHARACTERS,
  type KnowledgeCategory,
  type KnowledgeDocument,
} from '../src/services/knowledge.js';

type Source = { repository: string; path: string; category: KnowledgeCategory; title?: string };
const sources: Source[] = [];
function add(repository: string, category: KnowledgeCategory, paths: string[]) {
  sources.push(...paths.map((path) => ({ repository, category, path })));
}

// Explicit documentation landmarks complement constrained source-directory discovery below.
add('juice-sdk-v4', 'sdk', [
  'README.md',
  'packages/core/src/jbcenter.ts',
  'packages/core/src/chains.ts',
  'packages/core/src/contracts.ts',
  'packages/core/src/constants.ts',
]);
add('bendystraw-v6', 'indexer', [
  'README.md',
  'ponder.schema.ts',
  'src/api/index.ts',
  'src/util/id.ts',
]);
add('jbcenter', 'center', [
  'README.md',
  'src/types.ts',
  'src/intent.ts',
  'src/deploymentVerifier.ts',
  'src/rpc.ts',
]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      skills: { type: 'string' },
      output: { type: 'string' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      'Usage: npm run knowledge:sync -- [--workspace /path/to/evm] [--skills /path/to/juicebox-skills] [--output /path/to/knowledge.json] [--check]\nAllowlisted source directories and documentation; --check verifies reproducibility without writing. Missing selected sources fail the sync.\n',
    );
  } else {
    sync(values);
  }
}

/** A source path must describe the Git blob itself, never bytes reached through a symlink. */
export function assertSourcePath(root: string, sourcePath: string): string {
  const path = resolve(root, sourcePath);
  const relation = relative(root, path);
  if (!relation || relation.startsWith('..') || isAbsolute(relation))
    throw new Error('Selected source escapes its repository');
  let current = root;
  for (const component of relation.split('/')) {
    current = resolve(current, component);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`Symlinks are not permitted in selected source paths: ${sourcePath}`);
  }
  return path;
}

/** Compare bytes, not porcelain status: assume-unchanged, skip-worktree, and clean filters can conceal differences. */
export function sourceDiffersFromCommit(
  root: string,
  sourcePath: string,
  commit: string,
  bytes: Buffer,
): boolean {
  try {
    const committed = execFileSync('git', ['-C', root, 'show', `${commit}:${sourcePath}`], {
      maxBuffer: MAX_DOCUMENT_CHARACTERS * 4,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !committed.equals(bytes);
  } catch (error) {
    const entry = execFileSync(
      'git',
      ['-C', root, '--literal-pathspecs', 'ls-tree', '-z', commit, '--', sourcePath],
      {
        maxBuffer: 4_096,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // An untracked file has no committed blob. Other Git failures invalidate the sync.
    if (entry.length === 0) return true;
    throw error;
  }
}

export function writeBundleAtomically(output: string, serialized: string): void {
  mkdirSync(dirname(output), { recursive: true });
  const temporaryDirectory = mkdtempSync(resolve(dirname(output), '.knowledge-sync-'));
  try {
    const temporary = resolve(temporaryDirectory, 'knowledge.json');
    writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, output);
  } finally {
    // Only this invocation's mkdtemp directory is eligible for cleanup.
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function sync(values: { workspace?: string; skills?: string; output?: string; check?: boolean }) {
  const workspace = resolve(
    values.workspace ?? fileURLToPath(new URL('../../../', import.meta.url)),
  );
  const skills = resolve(values.skills ?? resolve(workspace, '..', '..', 'juicebox-skills'));
  const output = resolve(
    values.output ?? fileURLToPath(new URL('../data/knowledge.json', import.meta.url)),
  );
  // Explicit repository, directory and extension allowlists expand automatically with first-party V6 sources.
  // Internal src/libraries are protocol source; external lib/node_modules/vendor trees are never imported.
  const contractRepositories = [
    'banny-retail-v6',
    'croptop-core-v6',
    'defifa',
    'nana-721-hook-v6',
    'nana-address-registry-v6',
    'nana-buyback-hook-v6',
    'nana-core-v6',
    'nana-distributor-v6',
    'nana-jbx-distributor-v6',
    'nana-omnichain-deployers-v6',
    'nana-ownable-v6',
    'nana-permission-ids-v6',
    'nana-project-handles-v6',
    'nana-project-payer-v6',
    'nana-router-terminal-v6',
    'nana-suckers-v6',
    'nana-swap-split-hook-v6',
    'revnet-core-v6',
    'univ4-lp-split-hook-v6',
    'univ4-router-v6',
  ];
  function discover(root: string, directory: string, accept: (path: string) => boolean): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(assertSourcePath(realpathSync(root), directory), {
      withFileTypes: true,
    }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (['lib', 'node_modules', 'vendor', '.git'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are not permitted in selected source directories: ${path}`);
      if (entry.isDirectory()) files.push(...discover(root, path, accept));
      else if (entry.isFile() && accept(path)) files.push(path);
    }
    return files;
  }
  for (const repository of contractRepositories) {
    add(
      repository,
      'contracts',
      discover(resolve(workspace, repository), 'src', (path) => path.endsWith('.sol')),
    );
  }
  add(
    'juicebox-skills',
    'skills',
    discover(skills, 'plugins/juicebox-v6/skills', (path) => path.endsWith('/SKILL.md')),
  );
  add(
    'juice-sdk-v4',
    'sdk',
    discover(
      resolve(workspace, 'juice-sdk-v4'),
      'packages/core/src/v6',
      (path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.spec.ts'),
    ),
  );
  const git = (root: string, args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const repositories = new Map<
    string,
    {
      root: string;
      commit: string;
      repositoryDirty: boolean;
      upstream?: string;
      version?: string;
    }
  >();

  for (const repository of new Set(sources.map((source) => source.repository))) {
    const root = realpathSync(
      repository === 'juicebox-skills'
        ? skills
        : resolve(workspace, repository === 'jbcenter' ? 'extensions/jbcenter' : repository),
    );
    if (realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root) {
      throw new Error(
        `${repository} must be its own Git checkout; refusing ambiguous commit provenance`,
      );
    }
    const commit = git(root, ['rev-parse', '--verify', 'HEAD']);
    const repositoryDirty =
      git(root, ['status', '--porcelain', '--untracked-files=normal']).length > 0;
    let remote = '';
    try {
      remote = git(root, ['remote', 'get-url', 'origin']);
    } catch {
      /* Local-only repositories have no upstream link. */
    }
    // Only retain a credential-free, canonical GitHub repository URL, never arbitrary remote configuration.
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote);
    const upstream = match ? `https://github.com/${match[1]}` : undefined;
    const packagePath = resolve(
      root,
      repository === 'juice-sdk-v4' ? 'packages/core/package.json' : 'package.json',
    );
    let version: string | undefined;
    if (existsSync(packagePath)) {
      const metadata: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (
        metadata &&
        typeof metadata === 'object' &&
        'version' in metadata &&
        typeof metadata.version === 'string'
      ) {
        version = metadata.version;
      }
    }
    repositories.set(repository, { root, commit, repositoryDirty, upstream, version });
  }

  const documents: KnowledgeDocument[] = sources.map((source) => {
    const repository = repositories.get(source.repository)!;
    const path = assertSourcePath(repository.root, source.path);
    if (!statSync(path).isFile() || statSync(path).size > MAX_DOCUMENT_CHARACTERS * 4) {
      throw new Error(
        `Selected source is not a bounded text file: ${source.repository}/${source.path}`,
      );
    }
    const bytes = readFileSync(path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    const fileDirty = sourceDiffersFromCommit(
      repository.root,
      source.path,
      repository.commit,
      bytes,
    );
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    const skillVersion =
      source.category === 'skills' && frontmatter
        ? /^version:[ \t]*["']?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?)["']?[ \t]*$/m.exec(
            frontmatter,
          )?.[1]
        : undefined;
    const basename = source.path.split('/').at(-1)!;
    const rawTitle =
      source.category === 'skills'
        ? (/^# (.+)$/m.exec(text)?.[1] ?? source.path.split('/').at(-2)!)
        : basename === 'README.md'
          ? `${source.repository} — README`
          : `${source.repository} — ${basename}`;
    const title = source.path.includes('/archive/') ? `[Archived source] ${rawTitle}` : rawTitle;
    const version =
      skillVersion ?? repository.version ?? (source.category === 'contracts' ? 'v6' : undefined);
    const license = /SPDX-License-Identifier:\s*([^\r\n]+)/.exec(text)?.[1]?.trim();
    return {
      id: `${source.repository}.${source.path.replace(/\//g, '.').toLowerCase()}`,
      title: source.title ?? title,
      category: source.category,
      text,
      source: {
        repository: source.repository,
        path: source.path,
        commit: repository.commit,
        fileSha256,
        fileDirty,
        repositoryDirty: repository.repositoryDirty,
        ...(version ? { version } : {}),
        ...(repository.upstream
          ? {
              upstreamUrl: `${repository.upstream}/blob/${repository.commit}/${source.path.split('/').map(encodeURIComponent).join('/')}`,
            }
          : {}),
        ...(license ? { license } : {}),
        startLine: 1,
        endLine: text.split('\n').length,
      },
    };
  });
  const repositoriesWithSourceDrift = new Set(
    documents
      .filter((document) => document.source.fileDirty)
      .map((document) => document.source.repository),
  );
  for (const document of documents) {
    document.source.repositoryDirty ||= repositoriesWithSourceDrift.has(document.source.repository);
  }
  // Detect edits or commits made while sampling. The digest records sampled bytes, not a live checkout promise.
  for (const [name, repository] of repositories) {
    if (git(repository.root, ['rev-parse', '--verify', 'HEAD']) !== repository.commit) {
      throw new Error(`${name} changed commits during sync; retry against a stable checkout`);
    }
    if (
      git(repository.root, ['status', '--porcelain', '--untracked-files=normal']).length > 0 !==
      repository.repositoryDirty
    ) {
      throw new Error(`${name} changed dirty state during sync; retry against a stable checkout`);
    }
  }
  for (const document of documents) {
    const repository = repositories.get(document.source.repository)!;
    const currentHash = createHash('sha256')
      .update(readFileSync(assertSourcePath(repository.root, document.source.path)))
      .digest('hex');
    if (currentHash !== document.source.fileSha256) {
      throw new Error(
        `${document.source.repository}/${document.source.path} changed during sync; retry`,
      );
    }
  }
  const bundle = createKnowledgeBundle(documents);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BUNDLE_BYTES)
    throw new Error('Selected references exceed bundle byte bound');
  if (values.check) {
    if (!existsSync(output) || readFileSync(output, 'utf8') !== serialized) {
      throw new Error(
        'Vendored reference bundle differs from selected sources; inspect changes and run knowledge:sync',
      );
    }
  } else {
    writeBundleAtomically(output, serialized);
  }
  process.stdout.write(
    `${values.check ? 'Verified' : 'Vendored'} ${documents.length} references from ${repositories.size} repositories; bundle ${bundle.bundleId}.\n`,
  );
}
