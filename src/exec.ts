import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program without a shell. Resolves with the exit code; rejects only when the program can't start (e.g. ENOENT).
 * `env` is merged over the current environment.
 */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const env = opts.env ? { ...process.env, ...opts.env } : undefined;
    execFile(cmd, args, { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
        reject(err);
        return;
      }
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
