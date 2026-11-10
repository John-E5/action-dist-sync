import { cp, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import type { Exec, ExecResult } from './exec.js';

export const DEFAULTS = { distPath: 'dist', workflow: 'dist.yml', artifact: 'action-dist' } as const;
const COMMIT_MESSAGE = 'build: sync dist bundle';
/** Clone and push with gh's token, whatever credential helper git has; never fall back to a prompt. */
const GH_CREDENTIALS = ['-c', 'credential.https://github.com.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential'];
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Appended to the failure message. */
  hint?: string;
}

export interface SyncOptions {
  /** Pull request number. */
  pr: number;
  /** owner/name. Defaults to the repository `gh` sees in the current directory. */
  repo?: string;
  /** The bundle folder, relative to the repo root. Default `dist`. */
  distPath?: string;
  /** The workflow file that builds the bundle. Default `dist.yml`. */
  workflow?: string;
  /** The artifact the workflow uploads on fork PRs. Default `action-dist`. */
  artifact?: string;
  /** Progress lines. */
  log?: (line: string) => void;
}

export interface SyncResult {
  status: 'pushed' | 'in-sync';
  headRepo: string;
  headRef: string;
}

/** Exit code 1: the PR can't be synced as it stands. Exit code 2: a setup or tool problem. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

interface PrInfo {
  headRepositoryOwner: { login: string };
  headRepository: { name: string };
  headRefName: string;
  headRefOid: string;
  maintainerCanModify: boolean;
  isCrossRepository: boolean;
}

/** Applies the CI-built bundle from a fork PR's workflow run to the fork's branch. */
export async function syncFork(options: SyncOptions, exec: Exec): Promise<SyncResult> {
  const distPath = checkDistPath(options.distPath ?? DEFAULTS.distPath);
  const workflow = options.workflow ?? DEFAULTS.workflow;
  const artifact = options.artifact ?? DEFAULTS.artifact;
  const log = options.log ?? (() => {});
  const n = options.pr;

  const run = async (cmd: string, args: string[], { cwd, env }: RunOptions = {}): Promise<ExecResult> => {
    try {
      return await exec(cmd, args, env ? { cwd, env } : { cwd });
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') {
        throw new SyncError(
          cmd === 'gh' ? 'action-dist-sync needs the GitHub CLI (gh), signed in: https://cli.github.com' : `action-dist-sync needs ${cmd} on PATH`,
          2,
        );
      }
      throw err;
    }
  };
  const must = async (cmd: string, args: string[], what: string, opts: RunOptions = {}): Promise<string> => {
    const r = await run(cmd, args, opts);
    if (r.code !== 0) {
      const hint = opts.hint ? `\n${opts.hint}` : '';
      throw new SyncError(`${what} failed: ${(r.stderr || r.stdout).trim()}${hint}`, 2);
    }
    return r.stdout.trim();
  };

  const repo = options.repo ?? (await must('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], 'Finding the repository (pass --repo owner/name)'));
  const pr = JSON.parse(
    await must(
      'gh',
      ['pr', 'view', String(n), '-R', repo, '--json', 'headRepositoryOwner,headRepository,headRefName,headRefOid,maintainerCanModify,isCrossRepository'],
      `Reading PR #${n}`,
    ),
  ) as PrInfo;
  const headRepo = `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`;
  const headRef = pr.headRefName;
  const sha = pr.headRefOid.slice(0, 7);

  if (!pr.isCrossRepository) throw new SyncError(`PR #${n} isn't from a fork; the sync workflow commits same-repo PRs itself.`, 1);
  if (!pr.maintainerCanModify) throw new SyncError(`PR #${n} doesn't allow maintainer edits. Ask the author to tick "Allow edits by maintainers".`, 1);

  const runs = JSON.parse(
    await must('gh', ['run', 'list', '-R', repo, '--workflow', workflow, '--commit', pr.headRefOid, '--limit', '1', '--json', 'databaseId,status'], `Listing ${workflow} runs`),
  ) as Array<{ databaseId: number; status: string }>;
  const latest = runs[0];
  if (!latest) throw new SyncError(`No ${workflow} run for ${sha} yet. Approve the PR's workflow runs first.`, 1);
  if (latest.status !== 'completed') throw new SyncError(`The ${workflow} run for ${sha} is still ${latest.status}. Try again when it finishes.`, 1);

  const tmp = await mkdtemp(join(tmpdir(), 'action-dist-sync-'));
  try {
    const bundle = join(tmp, 'bundle');
    log(`Downloading ${artifact} from run ${latest.databaseId}`);
    const download = await run('gh', ['run', 'download', String(latest.databaseId), '-R', repo, '-n', artifact, '-D', bundle]);
    if (download.code !== 0) {
      throw new SyncError(`Run ${latest.databaseId} has no ${artifact} artifact: the bundle is already in sync, or the artifact expired (re-run the workflow).`, 1);
    }

    const clone = join(tmp, 'repo');
    log(`Cloning ${headRepo}:${headRef}`);
    await must(
      'git',
      [...GH_CREDENTIALS, '-c', 'core.autocrlf=false', 'clone', '-q', '--depth', '1', '--branch', headRef, `https://github.com/${headRepo}.git`, clone],
      `Cloning ${headRepo}`,
      { env: NO_PROMPT },
    );

    const target = await checkNoSymlinks(clone, distPath, `${headRepo}:${headRef}`);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(bundle, target, { recursive: true });

    await must('git', ['--literal-pathspecs', '-c', 'core.autocrlf=false', 'add', '-A', '--', distPath], 'Staging the bundle', { cwd: clone });
    const diff = await run('git', ['diff', '--cached', '--quiet'], { cwd: clone });
    if (diff.code === 0) return { status: 'in-sync', headRepo, headRef };
    if (diff.code !== 1) throw new SyncError(`Comparing the bundle failed: ${diff.stderr.trim()}`, 2);

    await must('git', ['-c', 'core.autocrlf=false', 'commit', '-q', '-m', COMMIT_MESSAGE], 'Committing the bundle', { cwd: clone });
    log(`Pushing to ${headRepo}:${headRef}`);
    await must('git', [...GH_CREDENTIALS, 'push', '-q', 'origin', `HEAD:${headRef}`], `Pushing to ${headRepo}`, {
      cwd: clone,
      env: NO_PROMPT,
      hint: "Check `gh auth status`; the push uses gh's credentials.",
    });
    return { status: 'pushed', headRepo, headRef };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Normalises to a forward-slash path inside the repo. Rejects absolute and drive-relative paths (`C:foo`), `.`, anything
 * climbing out with `..`, any segment with a `:` (pathspec magic, NTFS streams) and any `.git` segment.
 */
function checkDistPath(input: string): string {
  const path = posix.normalize(input.replace(/\\/g, '/')).replace(/\/+$/, '');
  const segments = path.split('/');
  if (
    input.trim() === '' ||
    isAbsolute(input) ||
    path.startsWith('/') ||
    path === '.' ||
    path === '..' ||
    path.startsWith('../') ||
    segments.some((s) => s.includes(':') || s.toLowerCase().replace(/[. ]+$/, '') === '.git')
  ) {
    throw new SyncError(`--dist-path must be a folder inside the repository, got "${input}"`, 2);
  }
  return path;
}

/**
 * The fork controls the clone's contents, so a symlinked `dist-path` (or a symlinked folder above it) could point rm and
 * cp outside the temp dir. Refuses when any of them is a symlink, or resolves outside the clone. Returns the target path.
 */
async function checkNoSymlinks(clone: string, distPath: string, where: string): Promise<string> {
  const root = await realpath(clone);
  let at = clone;
  for (const segment of distPath.split('/')) {
    at = join(at, segment);
    let isLink: boolean;
    try {
      isLink = (await lstat(at)).isSymbolicLink();
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') break;
      throw err;
    }
    const inside = relative(root, await realpath(at));
    if (isLink || inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new SyncError(`${distPath} on ${where} goes through a symlink (${relative(clone, at)}). Refusing to write there.`, 1);
    }
  }
  return at;
}
