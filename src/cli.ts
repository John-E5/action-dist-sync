#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { realExec } from './exec.js';
import { DEFAULTS, syncFork, SyncError, type SyncOptions, type SyncResult } from './sync.js';

const USAGE = `Usage: action-dist-sync <pr> [--repo owner/name] [--dist-path ${DEFAULTS.distPath}]
                        [--workflow ${DEFAULTS.workflow}] [--artifact ${DEFAULTS.artifact}]

Commits the CI-built bundle from a fork PR's workflow run to the fork's branch.
Needs the GitHub CLI (gh), signed in, and "Allow edits by maintainers" on the PR.`;

export type Parsed = { kind: 'help' } | { kind: 'run'; options: SyncOptions };

export function parseCli(argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        'dist-path': { type: 'string' },
        workflow: { type: 'string' },
        artifact: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new SyncError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  const [pr, ...extra] = positionals;
  const number = pr?.replace(/^#/, '');
  if (!number || !/^\d+$/.test(number) || extra.length > 0) throw new SyncError(USAGE, 2);
  const options: SyncOptions = { pr: Number(number) };
  if (values.repo !== undefined) options.repo = values.repo;
  if (values['dist-path'] !== undefined) options.distPath = values['dist-path'];
  if (values.workflow !== undefined) options.workflow = values.workflow;
  if (values.artifact !== undefined) options.artifact = values.artifact;
  return { kind: 'run', options };
}

async function main(): Promise<number> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return 0;
  }
  const result = await syncFork({ ...parsed.options, log: (line) => console.log(line) }, realExec);
  console.log(outcome(result));
  return 0;
}

/** The closing line for a successful run. */
export function outcome(result: SyncResult): string {
  return result.status === 'pushed'
    ? `Pushed the CI-built bundle to ${result.headRepo}:${result.headRef}. The PR's checks will run again.`
    : `Bundle already in sync on ${result.headRepo}:${result.headRef}.`;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof SyncError ? err.message : `action-dist-sync: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = err instanceof SyncError ? err.exitCode : 2;
    },
  );
}
