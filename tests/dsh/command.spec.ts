import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findOnPath } from '../../src/dsh/command.js';
import { CapabilityError } from '../../src/errors.js';
import {
  resolveDshCommand,
  probeDsh,
  capabilitiesFor,
  type CommandSpec
} from '../../src/dsh/index.js';
import { reaped } from '../helpers/process.js';

describe('probeDsh', () => {
  const cmd: CommandSpec = { file: 'dsh', args: [] };
  it.each([
    'v0.1.7', '0.1.7garbage', '0.1.7-', '0.1.7.0', '00.01.007',
    '0.1.7-01', '0.1.7-rc.01', 'DSH 0.1.7', ' 0.1.7 ',
    '0.1.70-Authorization_Bearer_doctor-secret',
  ])('rejects output without a strictly valid version line: %j', async stdout => {
    await expect(probeDsh(cmd, async () => ({ stdout, stderr: '' })))
      .rejects.toThrow('Unable to parse DSH runtime version');
  });
  it('selects the independent version line after pnpm command echoes', async () => {
    const stdout = '> harness@0.1.7 dsh /source\r\n> node cli.js --version\r\n\r\n0.1.7-rc.2\r\n';
    expect(await probeDsh(cmd, async () => ({ stdout, stderr: '' })))
      .toEqual({ version: '0.1.7-rc.2', raw: stdout.trim() });
  });
  it('accepts a strict version line from stderr when stdout is empty', async () => {
    expect((await probeDsh(cmd, async () => ({ stdout: '', stderr: '0.1.7\n' }))).version).toBe('0.1.7');
  });

  it('times out when dsh runs under a wrapper, as pnpm runs a source checkout, and stops what it started', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-probe-'));
    try {
      const pidFile = path.join(dir, 'grandchild.pid');
      const wrapper = path.join(dir, 'wrapper.mjs');
      // Like pnpm: the grandchild shares the output pipes, so they stay open after the wrapper is killed.
      fs.writeFileSync(wrapper, `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', \`require('fs').writeFileSync(\${JSON.stringify(${JSON.stringify(pidFile)})}, String(process.pid)); setTimeout(() => {}, 60000)\`], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);
      const started = Date.now();
      // Long enough for the grandchild to start even on a slow Windows runner, so there is a tree to stop.
      await expect(probeDsh({ file: process.execPath, args: [wrapper] }, undefined, 3_000)).rejects.toThrow('DSH runtime probe execution failed');
      // Far short of the grandchild's 60 s: the probe did not wait for the pipes it holds.
      expect(Date.now() - started).toBeLessThan(20_000);
      // Read outside any toThrow callback, so a grandchild that never started fails here instead of passing.
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(await reaped(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('resolveDshCommand', () => {
  it('reports a command PATH does not have as no DSH (exit 4) on every platform', async () => {
    const err = await probeDsh({ file: 'nodsh-missing-cmd', args: [] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as Error).message).toBe('The DSH CLI that DSH_CLI names was not found');
  });

  it('should parse DSH_CLI as JSON array if formatted as array', () => {
    const cmd = resolveDshCommand({
      envDshCli: '["node", "/path/to/dsh.js", "--verbose"]'
    });
    expect(cmd).toEqual({
      file: 'node',
      args: ['/path/to/dsh.js', '--verbose']
    });
  });

  it('should treat malicious shell string in DSH_CLI as literal file and never shell', () => {
    const cmd = resolveDshCommand({
      envDshCli: 'dsh; touch /tmp/pwned'
    });
    expect(cmd).toEqual({
      file: 'dsh; touch /tmp/pwned',
      args: []
    });
  });

  it('should resolve harness source dir to pnpm --silent --dir <sourceDir> dsh', () => {
    const cmd = resolveDshCommand({
      cliHarnessSource: '/Users/costalong/code/dsh/deepseek-harness',
      sourceDirExists: () => true
    });
    expect(cmd).toEqual({
      file: 'pnpm',
      args: ['--silent', '--dir', '/Users/costalong/code/dsh/deepseek-harness', 'dsh'],
      cwd: '/Users/costalong/code/dsh/deepseek-harness'
    });
  });

  it('refuses a --harness-source that does not exist rather than run another DSH', () => {
    expect(() => resolveDshCommand({
      cliHarnessSource: '/nonexistent/harness',
      which: () => '/usr/local/bin/dsh',
      sourceDirExists: () => false
    })).toThrow(/Harness source not found: \/nonexistent\/harness/);
  });

  it('refuses an empty --harness-source and expands a leading ~, as --dsh-home does', () => {
    for (const value of ['', '  ']) {
      expect(() => resolveDshCommand({ cliHarnessSource: value, envDshCli: '/usr/bin/dsh', sourceDirExists: () => true })).toThrow(/harness-source must not be empty/);
    }
    const cmd = resolveDshCommand({ cliHarnessSource: '~/harness', sourceDirExists: () => true });
    expect(cmd?.cwd).toBe(path.join(os.homedir(), 'harness'));
  });

  it('lets an explicit --harness-source win over DSH_CLI, which only the manifest source yields to', () => {
    const fromFlag = resolveDshCommand({ cliHarnessSource: '/src/harness', envDshCli: '/usr/bin/dsh', sourceDirExists: () => true });
    expect(fromFlag).toEqual({ file: 'pnpm', args: ['--silent', '--dir', '/src/harness', 'dsh'], cwd: '/src/harness' });
    expect(() => resolveDshCommand({ cliHarnessSource: '/nonexistent/harness', envDshCli: '/usr/bin/dsh', sourceDirExists: () => false })).toThrow(
      /Harness source not found/
    );
    expect(resolveDshCommand({ manifestHarnessSource: '/src/harness', envDshCli: '/usr/bin/dsh', sourceDirExists: () => true })).toEqual({ file: '/usr/bin/dsh', args: [] });
  });

  it('resolves a relative --harness-source against the working directory', () => {
    const absolute = path.resolve('hs');
    const cmd = resolveDshCommand({ cliHarnessSource: 'hs', sourceDirExists: (dir) => dir === absolute });
    expect(cmd).toEqual({ file: 'pnpm', args: ['--silent', '--dir', absolute, 'dsh'], cwd: absolute });
  });

  it('falls back to PATH when the manifest sourceDir does not exist on this machine', () => {
    const cmd = resolveDshCommand({
      manifestHarnessSource: '/elsewhere/harness',
      which: () => '/usr/local/bin/dsh',
      sourceDirExists: () => false
    });
    expect(cmd).toEqual({ file: '/usr/local/bin/dsh', args: [] });
  });

  it('should resolve dsh in PATH if no source dir or DSH_CLI', () => {
    const cmd = resolveDshCommand({
      which: (bin) => (bin === 'dsh' ? '/usr/local/bin/dsh' : null),
      sourceDirExists: () => false
    });
    expect(cmd).toEqual({
      file: '/usr/local/bin/dsh',
      args: []
    });
  });

  it('should return null if no command or source directory can be resolved', () => {
    const cmd = resolveDshCommand({
      which: () => null,
      sourceDirExists: () => false
    });
    expect(cmd).toBeNull();
  });
});

describe('capabilitiesFor', () => {
  it('should return capabilities for 0.1.7-rc.2', () => {
    const caps = capabilitiesFor('0.1.7-rc.2');
    expect(caps.discovery.status).toBe('available');
    expect(caps.packageOperations.status).toBe('disabled');
    expect(caps.mutations).toBe(false);
    expect(caps.operationsExport).toBe('@deepseek-ai/dsh-plugin-manager/operations');
  });

  it('should return unsupported capabilities for unknown version', () => {
    const caps = capabilitiesFor('0.0.1');
    expect(caps.discovery.status).toBe('disabled');
    expect(caps.packageOperations.status).toBe('disabled');
    expect(caps.mutations).toBe(false);
    expect(caps.operationsExport).toBeNull();
  });
});

describe('findOnPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-which-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds dsh.cmd on a Windows PATH split by semicolons', () => {
    fs.writeFileSync(path.join(dir, 'dsh.CMD'), '');
    const env = { PATH: `C:\\missing;${dir}`, PATHEXT: '.COM;.EXE;.CMD' };
    expect(findOnPath('dsh', env, 'win32')).toBe(path.join(dir, 'dsh.CMD'));
  });

  it.skipIf(process.platform === 'win32')('finds a plain dsh on a POSIX PATH and skips a directory of that name', () => {
    const other = path.join(dir, 'other');
    fs.mkdirSync(path.join(other, 'dsh'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dsh'), '');
    expect(findOnPath('dsh', { PATH: `${other}:${dir}` }, 'linux')).toBe(path.join(dir, 'dsh'));
  });
});
