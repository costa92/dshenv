import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    }
  });
  return { code, stdout, stderr };
}

describe('CLI errors with --json', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dshenv-json-errors-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes a command error to stderr as JSON', async () => {
    const out = await run(['--json', '--dsh-home', home, 'adopt', '--from', join(home, 'missing.yaml')]);
    expect(out.code).toBe(3);
    expect(out.stdout).toBe('');
    expect(JSON.parse(out.stderr)).toEqual({
      error: {
        type: 'ValidationError',
        message: `Candidate file not found: ${join(home, 'missing.yaml')}`,
        exitCode: 3
      }
    });
  });

  it('writes an error raised before parsing as JSON', async () => {
    const out = await run(['--json', '--overlay', 'a', '--no-overlay', 'doctor']);
    expect(out.code).toBe(3);
    expect(JSON.parse(out.stderr)).toEqual({
      error: { type: 'ValidationError', message: '--overlay and --no-overlay cannot be used together', exitCode: 3 }
    });
  });

  it('keeps plain text errors without --json', async () => {
    const out = await run(['--dsh-home', home, 'adopt', '--from', join(home, 'missing.yaml')]);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe(`Candidate file not found: ${join(home, 'missing.yaml')}\n`);
  });

  it('does not treat --json after -- as the flag', async () => {
    const out = await run(['--overlay', 'a', '--no-overlay', 'doctor', '--', '--json']);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe('--overlay and --no-overlay cannot be used together\n');
  });

  it('does not treat --no-overlay after -- as conflicting with --overlay', async () => {
    const out = await run(['--dsh-home', home, '--overlay', 'a', 'status', '--', '--no-overlay']);
    expect(out.stderr).not.toContain('cannot be used together');
  });
});
