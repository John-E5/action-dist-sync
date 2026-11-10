import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '../src/exec.js';
import { syncFork, SyncError } from '../src/sync.js';

type Call = { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> };
type Handler = (call: Call) => ExecResult | Promise<ExecResult>;
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

const PR = {
  headRepositoryOwner: { login: 'contrib' },
  headRepository: { name: 'my-action' },
  headRefName: 'fix-typo',
  headRefOid: 'abc1234def5678',
  maintainerCanModify: true,
  isCrossRepository: true,
};

/** The words after `cmd` with `-c x=y` pairs and leading `--global-options` dropped. */
const words = (args: string[]) => {
  const out = args.filter((a, i) => a !== '-c' && args[i - 1] !== '-c');
  while (out[0]?.startsWith('--')) out.shift();
  return out;
};

/** A fake gh/git. Each handler key is "cmd sub1 sub2"; git is keyed on its subcommand alone. Unknown calls fail the test. */
function fake(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const snapshot: { dist?: string[]; stale?: boolean; content?: string } = {};
  const handlers: Record<string, Handler> = {
    'gh repo view': () => ok('owner/my-action\n'),
    'gh pr view': () => ok(JSON.stringify(PR)),
    'gh run list': () => ok(JSON.stringify([{ databaseId: 42, status: 'completed' }])),
    'gh run download': ({ args }) => {
      const dir = args[args.indexOf('-D') + 1]!;
      mkdirSync(join(dir, 'licenses'), { recursive: true });
      writeFileSync(join(dir, 'index.js'), 'built on CI');
      writeFileSync(join(dir, 'licenses', 'LICENSES.txt'), 'MIT');
      return ok();
    },
    'git clone': ({ args }) => {
      const dir = args.at(-1)!;
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'index.js'), 'built locally');
      writeFileSync(join(dir, 'dist', 'stale-chunk.js'), 'old');
      return ok();
    },
    'git add': () => ok(),
    'git diff': () => ({ code: 1, stdout: '', stderr: '' }),
    'git commit': ({ cwd }) => {
      snapshot.dist = readdirSync(join(cwd!, 'dist')).sort();
      snapshot.content = readFileSync(join(cwd!, 'dist', 'index.js'), 'utf8');
      return ok();
    },
    'git push': () => ok(),
    ...overrides,
  };
  const temps: string[] = [];
  const exec: Exec = async (cmd, args, opts = {}) => {
    const call: Call = { cmd, args, cwd: opts.cwd };
    calls.push(call);
    const key = `${cmd} ${words(args).slice(0, cmd === 'git' ? 1 : 2).join(' ')}`;
    if (key === 'gh run download') temps.push(dirname(args[args.indexOf('-D') + 1]!));
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    return handler(call);
  };
  return { exec, calls, snapshot, temps };
}

const keys = (calls: Call[]) => calls.map((c) => `${c.cmd} ${words(c.args)[0]}`);
const fail = (stderr: string): ExecResult => ({ code: 128, stdout: '', stderr });

describe('syncFork', () => {
  it('replaces dist/ with the CI artifact, then commits and pushes to the fork branch', async () => {
    const f = fake();
    const result = await syncFork({ pr: 7, repo: 'owner/my-action' }, f.exec);
    expect(result).toEqual({ status: 'pushed', headRepo: 'contrib/my-action', headRef: 'fix-typo' });
    expect(f.snapshot).toEqual({ dist: ['index.js', 'licenses'], content: 'built on CI' });
    expect(keys(f.calls)).toEqual(['gh pr', 'gh run', 'gh run', 'git clone', 'git add', 'git diff', 'git commit', 'git push']);
    const clone = f.calls.find((c) => c.args.includes('clone'))!;
    expect(clone.args).toEqual(expect.arrayContaining(['--depth', '1', '--branch', 'fix-typo', 'https://github.com/contrib/my-action.git']));
    expect(f.calls.find((c) => c.args.includes('push'))!.args).toEqual(['push', '-q', 'origin', 'HEAD:fix-typo']);
    expect(f.calls.find((c) => c.args.includes('commit'))!.args).toEqual(expect.arrayContaining(['-m', 'build: sync dist bundle']));
    const list = f.calls.find((c) => c.args[1] === 'list')!;
    expect(list.args).toEqual(expect.arrayContaining(['--workflow', 'dist.yml', '--commit', 'abc1234def5678']));
  });

  it('finds the repository with gh when --repo is not given', async () => {
    const f = fake();
    await syncFork({ pr: 7 }, f.exec);
    expect(f.calls[0]?.args.slice(0, 2)).toEqual(['repo', 'view']);
    expect(f.calls[1]?.args).toEqual(expect.arrayContaining(['-R', 'owner/my-action']));
  });

  it('honours --dist-path, --workflow and --artifact', async () => {
    const f = fake({
      'git clone': ({ args }) => {
        mkdirSync(join(args.at(-1)!, 'packages', 'action', 'dist'), { recursive: true });
        return ok();
      },
      'git commit': () => ok(),
    });
    await syncFork({ pr: 7, repo: 'o/r', distPath: 'packages/action/dist/', workflow: 'bundle.yml', artifact: 'bundle' }, f.exec);
    expect(f.calls.find((c) => c.args[1] === 'list')!.args).toEqual(expect.arrayContaining(['--workflow', 'bundle.yml']));
    expect(f.calls.find((c) => c.args[1] === 'download')!.args).toEqual(expect.arrayContaining(['-n', 'bundle']));
    expect(f.calls.find((c) => c.args.includes('add'))!.args).toEqual(expect.arrayContaining(['--', 'packages/action/dist']));
  });

  it('stops without committing when the bundle already matches', async () => {
    const f = fake({ 'git diff': () => ok() });
    expect(await syncFork({ pr: 7, repo: 'o/r' }, f.exec)).toMatchObject({ status: 'in-sync' });
    expect(keys(f.calls)).not.toContain('git commit');
    expect(keys(f.calls)).not.toContain('git push');
  });

  const refuses = async (overrides: Record<string, Handler>, message: string, exitCode: 1 | 2) => {
    const error = await syncFork({ pr: 7, repo: 'o/r' }, fake(overrides).exec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).message).toContain(message);
    expect((error as SyncError).exitCode).toBe(exitCode);
  };

  it('refuses a same-repo PR', () =>
    refuses({ 'gh pr view': () => ok(JSON.stringify({ ...PR, isCrossRepository: false })) }, "PR #7 isn't from a fork", 1));

  it('refuses when maintainers cannot edit the PR', () =>
    refuses({ 'gh pr view': () => ok(JSON.stringify({ ...PR, maintainerCanModify: false })) }, 'Allow edits by maintainers', 1));

  it('refuses when no workflow run exists for the head commit', () =>
    refuses({ 'gh run list': () => ok('[]') }, 'No dist.yml run for abc1234 yet', 1));

  it('refuses while the run is still going', () =>
    refuses({ 'gh run list': () => ok(JSON.stringify([{ databaseId: 42, status: 'in_progress' }])) }, 'still in_progress', 1));

  it('explains a missing artifact', () =>
    refuses({ 'gh run download': () => ({ code: 1, stdout: '', stderr: 'no artifact matches' }) }, 'Run 42 has no action-dist artifact', 1));

  it('reports a gh failure with its own message', () =>
    refuses({ 'gh pr view': () => ({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest' }) }, 'Could not resolve to a PullRequest', 2));

  it('needs gh on PATH', () =>
    refuses({ 'gh pr view': () => Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })) }, 'needs the GitHub CLI', 2));

  it('rejects a dist path outside the repo before calling anything', async () => {
    const B = String.fromCharCode(92);
    const bad = ['../dist', '/abs/dist', '.', '', `dist${B}..${B}..`, `..${B}`, 'C:foo', 'dist/C:foo', ':(glob)*', '.git', 'dist/.git', 'x/../.git/hooks', '.GIT', '.git.'];
    for (const distPath of bad) {
      const f = fake();
      const error = await syncFork({ pr: 7, repo: 'o/r', distPath }, f.exec).catch((e: unknown) => e);
      expect(error, distPath).toBeInstanceOf(SyncError);
      expect((error as SyncError).exitCode).toBe(2);
      expect(f.calls).toHaveLength(0);
    }
  });

  it('runs add, diff, commit and push inside the clone', async () => {
    const f = fake();
    await syncFork({ pr: 7, repo: 'o/r' }, f.exec);
    const clone = f.calls.find((c) => words(c.args)[0] === 'clone')!.args.at(-1)!;
    for (const sub of ['add', 'diff', 'commit', 'push']) {
      expect(f.calls.find((c) => c.cmd === 'git' && words(c.args)[0] === sub)!.cwd).toBe(clone);
    }
  });

  it('removes its temp dir after a push', async () => {
    const f = fake();
    await syncFork({ pr: 7, repo: 'o/r' }, f.exec);
    expect(f.temps).toHaveLength(1);
    expect(existsSync(f.temps[0]!)).toBe(false);
  });

  it('removes its temp dir after a failure', async () => {
    const f = fake({ 'git push': () => fail('rejected') });
    await syncFork({ pr: 7, repo: 'o/r' }, f.exec).catch(() => {});
    expect(f.temps).toHaveLength(1);
    expect(existsSync(f.temps[0]!)).toBe(false);
  });

  it("reports a failed clone with git's message", () => refuses({ 'git clone': () => fail('fatal: Remote branch fix-typo not found') }, 'Remote branch fix-typo not found', 2));

  it("reports a failed push with git's message", () => refuses({ 'git push': () => fail('! [rejected] HEAD -> fix-typo (fetch first)') }, '[rejected] HEAD -> fix-typo', 2));

  it("reports a failed comparison with git's message", () => refuses({ 'git diff': () => fail('fatal: bad object HEAD') }, 'bad object HEAD', 2));

  it('stages the bundle with literal pathspecs', async () => {
    const f = fake();
    await syncFork({ pr: 7, repo: 'o/r' }, f.exec);
    expect(f.calls.find((c) => words(c.args)[0] === 'add')!.args[0]).toBe('--literal-pathspecs');
  });

  /** A fake clone where `link` (relative to the clone) is a symlink to a folder outside it. Returns null when symlinks can't be made here. */
  const symlinked = (link: string, distPath: string) => {
    const outside = mkdtempSync(join(tmpdir(), 'ads-outside-'));
    mkdirSync(join(outside, 'action', 'dist'), { recursive: true });
    writeFileSync(join(outside, 'keep.js'), 'precious');
    writeFileSync(join(outside, 'action', 'dist', 'keep.js'), 'precious');
    let made = true;
    const f = fake({
      'git clone': ({ args }) => {
        const at = join(args.at(-1)!, ...link.split('/'));
        mkdirSync(dirname(at), { recursive: true });
        try {
          symlinkSync(outside, at, 'junction');
        } catch {
          made = false;
        }
        return ok();
      },
    });
    return { run: () => syncFork({ pr: 7, repo: 'o/r', distPath }, f.exec), outside, made: () => made, f };
  };

  for (const [link, distPath] of [
    ['packages', 'packages/action/dist'],
    ['dist', 'dist'],
  ] as const) {
    it(`refuses to write through a symlinked ${link} in the fork (dist-path ${distPath})`, async (ctx) => {
      const s = symlinked(link, distPath);
      try {
        const error = await s.run().catch((e: unknown) => e);
        if (!s.made()) ctx.skip();
        expect(error).toBeInstanceOf(SyncError);
        expect((error as SyncError).exitCode).toBe(1);
        expect((error as SyncError).message).toContain('symlink');
        expect(readFileSync(join(s.outside, 'keep.js'), 'utf8')).toBe('precious');
        expect(readFileSync(join(s.outside, 'action', 'dist', 'keep.js'), 'utf8')).toBe('precious');
        expect(keys(s.f.calls)).not.toContain('git add');
      } finally {
        rmSync(s.outside, { recursive: true, force: true });
      }
    });
  }
});
