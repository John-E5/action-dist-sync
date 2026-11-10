import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { outcome, parseCli } from '../src/cli.js';
import { SyncError } from '../src/sync.js';

describe('parseCli', () => {
  it('reads the PR number and the options', () => {
    expect(parseCli(['12', '--repo', 'o/r', '--dist-path', 'packages/action/dist', '--workflow', 'bundle.yml', '--artifact', 'bundle'])).toEqual({
      kind: 'run',
      options: { pr: 12, repo: 'o/r', distPath: 'packages/action/dist', workflow: 'bundle.yml', artifact: 'bundle' },
    });
    expect(parseCli(['#12'])).toEqual({ kind: 'run', options: { pr: 12 } });
  });

  it('shows help', () => {
    expect(parseCli(['--help'])).toEqual({ kind: 'help' });
  });

  it('rejects bad arguments with exit code 2', () => {
    for (const argv of [[], ['abc'], ['1', '2'], ['1', '--nope']]) {
      const error = (() => {
        try {
          parseCli(argv);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).exitCode).toBe(2);
    }
  });
});

describe('outcome', () => {
  it('says what happened', () => {
    expect(outcome({ status: 'in-sync', headRepo: 'c/r', headRef: 'b' })).toBe('Bundle already in sync on c/r:b.');
    expect(outcome({ status: 'pushed', headRepo: 'c/r', headRef: 'b' })).toBe("Pushed the CI-built bundle to c/r:b. The PR's checks will run again.");
  });
});

describe('action-dist-sync command', () => {
  it('prints usage and exits 2 without a PR number', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: action-dist-sync <pr>');
  });
});
