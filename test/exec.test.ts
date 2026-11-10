import { describe, expect, it } from 'vitest';
import { realExec } from '../src/exec.js';

describe('realExec', () => {
  it('merges env over process.env', async () => {
    const script = 'process.stdout.write(`${process.env.ADS_PROBE}:${Boolean(process.env.PATH ?? process.env.Path)}`)';
    const r = await realExec(process.execPath, ['-e', script], { env: { ADS_PROBE: 'set' } });
    expect(r).toMatchObject({ code: 0, stdout: 'set:true' });
  });

  it('resolves with the exit code of a failing program', async () => {
    const r = await realExec(process.execPath, ['-e', 'process.stderr.write("no"); process.exit(3)']);
    expect(r).toEqual({ code: 3, stdout: '', stderr: 'no' });
  });
});
