import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI capture --profile', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-cap-'));
    for (const name of ['web', 'tui']) {
      const dir = path.join(tempHome, 'profiles', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: `dsh-profile-${name}`,
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
        })
      );
    }
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should capture only the named profile', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => {
        stdout += chunk;
      },
      stderr: () => {}
    };
    const code = await runCli(['capture', '--profile', 'web', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('web:');
    expect(stdout).not.toMatch(/^\s+tui:/m);
  });

  it('takes -p like every other command', async () => {
    let stdout = '';
    const code = await runCli(['capture', '-p', 'web', '--dsh-home', tempHome], {
      stdout: (chunk: string) => {
        stdout += chunk;
      },
      stderr: () => {}
    });
    expect(code).toBe(0);
    expect(stdout).toContain('web:');
    expect(stdout).not.toMatch(/^\s+tui:/m);
  });

  it('refuses an empty -o instead of writing to stdout', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['capture', '-o', '', '--dsh-home', tempHome], {
      stdout: (chunk: string) => {
        stdout += chunk;
      },
      stderr: (chunk: string) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(/--output must not be empty/);
    expect(stdout).toBe('');
  });

  it('suggests the profile a mistyped -p was meant to be', async () => {
    let stderr = '';
    const code = await runCli(['capture', '-p', 'wbe', '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk: string) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toContain("did you mean 'web'?");
  });

  it('should fail when the named profile does not exist', async () => {
    let stderr = '';
    const io = {
      stdout: () => {},
      stderr: (chunk: string) => {
        stderr += chunk;
      }
    };
    const code = await runCli(['capture', '--profile', 'missing', '--dsh-home', tempHome], io);
    expect(code).toBe(3);
    expect(stderr).toMatch(/profile/i);
  });
});
