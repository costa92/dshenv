import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

// A newcomer's first commands must say what to run next, not only what is missing.
describe('CLI getting started', () => {
  let tempHome: string;
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };
  const INIT_HINT = 'run dshenv init to start one, or dshenv capture -o candidate.yaml then dshenv adopt candidate.yaml';

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-start-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('tells how to start when there is no manifest yet', async () => {
    for (const args of [['plan'], ['apply', '--yes'], ['install', '@nanmicoder/dsh-agent-teams@0.1.21', '-p', 'web'], ['disable', 'x', '-p', 'web']]) {
      const out = await run(args);
      expect(out.code, args.join(' ')).toBe(3);
      expect(out.stderr, args.join(' ')).toContain(INIT_HINT);
    }
    // status reports the missing manifest as plan does, with no degraded report beside it.
    const status = await run(['status']);
    expect(status).toEqual({ code: 3, stdout: '', stderr: expect.stringContaining(INIT_HINT) });
    const json = await run(['--json', 'status']);
    expect(json.stdout).toBe('');
    expect(JSON.parse(json.stderr).error.exitCode).toBe(3);
  });

  it('ends init with the next step, and says so when already initialized', async () => {
    const first = await run(['init']);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(
      `Initialized dshenv environment at ${path.join(tempHome, 'envctl')}\n` +
        'Next: declare a plugin with dshenv install <package>@<version> -p <profile>, then dshenv plan and dshenv apply --yes\n'
    );
    const again = await run(['init']);
    expect(again.code).toBe(3);
    expect(again.stderr).toBe(`dshenv is already initialized at ${path.join(tempHome, 'envctl')}; see dshenv status or dshenv plan\n`);
  });

  it('says there was nothing to adopt instead of an empty profile list', async () => {
    const candidate = path.join(tempHome, 'candidate.yaml');
    expect((await run(['capture', '-o', candidate])).code).toBe(0);
    const out = await run(['adopt', '-f', candidate, '--yes']);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('Nothing to adopt: the candidate declares no plugins.\nNext: dshenv plan\n');
  });
});
