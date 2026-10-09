import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compareVersions,
  defaultRunner,
  detectInstallMethod,
  resolveTargetVersion,
  selfUpdate,
  type RunResult,
  type Runner
} from '../../src/self-update/self-update.js';
import { ValidationError } from '../../src/errors.js';

// A project's .npmrc in the directory dshenv was started from could point the global install at another registry.
describe('defaultRunner', () => {
  it('runs the package manager from the home directory, not the current one', async () => {
    const result = await defaultRunner(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {});
    expect(result.stdout).toBe(os.homedir());
  });

  it('says the command is missing instead of an undefined exit code', async () => {
    const result = await defaultRunner('dshenv-no-such-npm', ['view'], {});
    const run: Runner = async () => result;
    await expect(resolveTargetVersion(run)).rejects.toThrow(/on the npm registry: dshenv-no-such-npm was not found on PATH$/);
  });
});

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' });

function fakeRunner(responses: Record<string, RunResult>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    return responses[key] ?? { exitCode: 1, stdout: '', stderr: `unexpected: ${key}` };
  };
  return { run, calls };
}

describe('self-update', () => {
  let home: string;
  let npmRoot: string;
  let pnpmRoot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-self-update-'));
    npmRoot = path.join(home, 'npm', 'lib', 'node_modules');
    pnpmRoot = path.join(home, 'pnpm', 'global', '5', 'node_modules');
    fs.mkdirSync(path.join(npmRoot, '@costa92', 'dshenv'), { recursive: true });
    fs.mkdirSync(path.join(pnpmRoot, '@costa92', 'dshenv'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const roots = (): Record<string, RunResult> => ({ 'npm root -g': ok(`${npmRoot}\n`), 'pnpm root -g': ok(`${pnpmRoot}\n`) });

  it('looks up the latest version online so a fresh release is not hidden by the cache', async () => {
    const { run, calls } = fakeRunner({ 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1\n') });
    expect(await resolveTargetVersion(run)).toBe('0.2.1');
    expect(calls).toEqual(['npm view @costa92/dshenv@latest version --prefer-online']);
  });

  it('refuses a --to that is not an exact version before asking the registry', async () => {
    const { run, calls } = fakeRunner({});
    await expect(resolveTargetVersion(run, 'latest')).rejects.toThrow(/exact version/);
    expect(calls).toEqual([]);
  });

  it('reports a registry failure with npm\'s error code', async () => {
    const { run } = fakeRunner({
      'npm view @costa92/dshenv@9.9.9 version --prefer-online': { exitCode: 1, stdout: '', stderr: 'npm error code E404\nmore' }
    });
    await expect(resolveTargetVersion(run, '9.9.9')).rejects.toThrow(/9\.9\.9 on the npm registry: E404$/);
  });

  it('reports a --to version npm does not have as a usage error, as install does', async () => {
    const { run } = fakeRunner({
      'npm view @costa92/dshenv@9.9.9 version --prefer-online': { exitCode: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 No match found for version 9.9.9' }
    });
    const err = await resolveTargetVersion(run, '9.9.9').catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe('npm has no version 9.9.9 of @costa92/dshenv');
  });

  it.each([
    ['npm', () => path.join(npmRoot, '@costa92', 'dshenv')],
    ['pnpm', () => path.join(pnpmRoot, '@costa92', 'dshenv')]
  ] as const)('detects a global %s install', async (method, packageRoot) => {
    const { run } = fakeRunner(roots());
    expect(await detectInstallMethod(run, packageRoot())).toBe(method);
  });

  it('does not treat a pnpm link --global checkout as a global install', async () => {
    const checkout = path.join(home, 'code', 'dshenv');
    fs.mkdirSync(checkout, { recursive: true });
    fs.rmSync(path.join(pnpmRoot, '@costa92', 'dshenv'), { recursive: true });
    fs.symlinkSync(checkout, path.join(pnpmRoot, '@costa92', 'dshenv'));
    const { run } = fakeRunner(roots());
    expect(await detectInstallMethod(run, fs.realpathSync(path.join(pnpmRoot, '@costa92', 'dshenv')))).toBeNull();
  });

  it('does not treat a linked checkout as a global install', async () => {
    const checkout = path.join(home, 'code', 'dshenv');
    fs.mkdirSync(checkout, { recursive: true });
    fs.symlinkSync(checkout, path.join(npmRoot, '@costa92', 'linked'));
    const { run } = fakeRunner(roots());
    expect(await detectInstallMethod(run, path.join(npmRoot, '@costa92', 'linked'))).toBeNull();
  });

  it('installs the target with the package manager that installed dshenv', async () => {
    const { run, calls } = fakeRunner({
      ...roots(),
      'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1'),
      'pnpm add -g @costa92/dshenv@0.2.1': ok('')
    });
    const result = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(pnpmRoot, '@costa92', 'dshenv'), run });
    expect(result).toEqual({ status: 'updated', current: '0.2.0', target: '0.2.1', direction: 'upgrade', method: 'pnpm', command: 'pnpm add -g @costa92/dshenv@0.2.1' });
    expect(calls.at(-1)).toBe('pnpm add -g @costa92/dshenv@0.2.1');
  });

  it('only reports with --check and installs nothing', async () => {
    const { run, calls } = fakeRunner({ ...roots(), 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1') });
    const result = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(npmRoot, '@costa92', 'dshenv'), check: true, run });
    expect(result.status).toBe('available');
    expect(calls.some((call) => call.includes('install -g') || call.includes('add -g'))).toBe(false);
  });

  it('does nothing when already on the target version', async () => {
    const { run, calls } = fakeRunner({ 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.0') });
    expect((await selfUpdate({ currentVersion: '0.2.0', packageRoot: '/x', run })).status).toBe('up-to-date');
    expect(calls).toHaveLength(1);
  });

  it('refuses to replace a non-global install and says how to update it', async () => {
    const { run, calls } = fakeRunner({ ...roots(), 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1') });
    await expect(selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(home, 'code', 'dshenv'), run })).rejects.toThrow(
      /cannot replace itself.*npm install -g @costa92\/dshenv@0\.2\.1/
    );
    expect(calls.some((call) => call.includes('install -g') || call.includes('add -g'))).toBe(false);
  });

  it('names the npm error code behind leading warnings and hints at permissions', async () => {
    const { run } = fakeRunner({
      ...roots(),
      'npm view @costa92/dshenv@0.1.3 version --prefer-online': ok('0.1.3'),
      'npm install -g @costa92/dshenv@0.1.3 --prefer-online': {
        exitCode: 243,
        stdout: '',
        stderr: 'npm warn config bogus\nnpm error code EACCES\nnpm error path /usr/lib/node_modules'
      }
    });
    await expect(
      selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(npmRoot, '@costa92', 'dshenv'), to: '0.1.3', run })
    ).rejects.toThrow(/--prefer-online' failed: EACCES; the global install directory is not writable/);
  });

  it('names a pnpm error written to stdout without echoing the token on that line', async () => {
    const { run } = fakeRunner({
      ...roots(),
      'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1'),
      'pnpm add -g @costa92/dshenv@0.2.1': {
        exitCode: 1,
        stdout: ' ERR_PNPM_FETCH_401  GET https://registry.example.com/x: Unauthorized - //registry.example.com/:_authToken=secret-token',
        stderr: ''
      }
    });
    const error = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(pnpmRoot, '@costa92', 'dshenv'), run }).then(
      () => new Error('should fail'),
      (err: Error) => err
    );
    expect(error.message).toContain('failed: ERR_PNPM_FETCH_401');
    expect(error.message).not.toContain('secret-token');
  });

  it('says the registry lookup timed out', async () => {
    const { run } = fakeRunner({
      'npm view @costa92/dshenv@latest version --prefer-online': { timedOut: true, stdout: '', stderr: '' }
    });
    await expect(resolveTargetVersion(run)).rejects.toThrow(/timed out after 30 s/);
  });

  it('shows the install output to the user and sets no timeout on it', async () => {
    const seen: Array<{ key: string; options: unknown }> = [];
    const run: Runner = async (file, args, options) => {
      const key = [file, ...args].join(' ');
      seen.push({ key, options });
      if (key.startsWith('npm view')) return ok('0.2.1');
      if (key === 'npm root -g') return ok(npmRoot);
      return ok('');
    };
    await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(npmRoot, '@costa92', 'dshenv'), run });
    expect(seen.at(-1)).toEqual({ key: 'npm install -g @costa92/dshenv@0.2.1 --prefer-online', options: { showOutput: true } });
  });

  it('does not downgrade when latest is behind a prerelease or local build', async () => {
    const { run, calls } = fakeRunner({ ...roots(), 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.0') });
    const result = await selfUpdate({ currentVersion: '0.3.0-rc.1', packageRoot: path.join(npmRoot, '@costa92', 'dshenv'), run });
    expect(result).toEqual({ status: 'newer-installed', current: '0.3.0-rc.1', target: '0.2.0' });
    expect(calls).toHaveLength(1);
  });

  it('downgrades only when --to asks for it, and says so', async () => {
    const { run, calls } = fakeRunner({
      ...roots(),
      'npm view @costa92/dshenv@0.1.3 version --prefer-online': ok('0.1.3'),
      'npm install -g @costa92/dshenv@0.1.3 --prefer-online': ok('')
    });
    const result = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(npmRoot, '@costa92', 'dshenv'), to: '0.1.3', run });
    expect(result).toMatchObject({ status: 'updated', direction: 'downgrade', target: '0.1.3' });
    expect(calls.at(-1)).toBe('npm install -g @costa92/dshenv@0.1.3 --prefer-online');
  });

  it('reports the install method from --check, null for an install it cannot replace', async () => {
    const { run } = fakeRunner({ ...roots(), 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1') });
    const global = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(npmRoot, '@costa92', 'dshenv'), check: true, run });
    expect(global).toEqual({ status: 'available', current: '0.2.0', target: '0.2.1', direction: 'upgrade', method: 'npm' });
    const linked = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(home, 'code', 'dshenv'), check: true, run });
    expect(linked.method).toBeNull();
  });

  it('refuses to replace a pnpm install from a git URL with the registry package', async () => {
    fs.writeFileSync(
      path.join(path.dirname(pnpmRoot), 'package.json'),
      JSON.stringify({ dependencies: { '@costa92/dshenv': 'git+https://github.com/costa92/dshenv.git#v0.2.0' } })
    );
    const { run, calls } = fakeRunner({ ...roots(), 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1') });
    await expect(selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(pnpmRoot, '@costa92', 'dshenv'), run })).rejects.toThrow(
      /installed with pnpm from git\+https:\/\/github\.com\/costa92\/dshenv\.git#v0\.2\.0/
    );
    expect(calls.some((call) => call.startsWith('pnpm add'))).toBe(false);
  });

  it('leaves a token in the query or userinfo of the pnpm install source out of the message', async () => {
    fs.writeFileSync(
      path.join(path.dirname(pnpmRoot), 'package.json'),
      JSON.stringify({ dependencies: { '@costa92/dshenv': 'https://user:pw@npm.example.com/dshenv.tgz?token=SECRET123' } })
    );
    const { run } = fakeRunner({ ...roots(), 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1') });
    const err = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(pnpmRoot, '@costa92', 'dshenv'), run }).catch((e: Error) => e);
    expect((err as Error).message).toContain('installed with pnpm from https://npm.example.com/dshenv.tgz, not');
    expect((err as Error).message).not.toMatch(/SECRET123|pw/);
  });

  it('detects the real pnpm 10 layout, where the package resolves into .pnpm beside node_modules', async () => {
    const store = path.join(path.dirname(pnpmRoot), '.pnpm', '@costa92+dshenv@0.2.0', 'node_modules', '@costa92', 'dshenv');
    fs.mkdirSync(store, { recursive: true });
    fs.rmSync(path.join(pnpmRoot, '@costa92', 'dshenv'), { recursive: true });
    fs.symlinkSync(store, path.join(pnpmRoot, '@costa92', 'dshenv'));
    fs.writeFileSync(path.join(path.dirname(pnpmRoot), 'package.json'), JSON.stringify({ dependencies: { '@costa92/dshenv': '^0.2.0' } }));
    const { run } = fakeRunner(roots());
    expect(await detectInstallMethod(run, fs.realpathSync(store))).toBe('pnpm');
  });

  it.each([
    ['0.2.1', '0.2.0', 1],
    ['0.3.0-rc.1', '0.2.9', 1],
    ['0.3.0', '0.3.0-rc.1', 1],
    ['0.3.0-rc.2', '0.3.0-rc.10', -1],
    ['0.3.0-alpha', '0.3.0-1', 1],
    ['1.0.0+build', '1.0.0', 0]
  ])('orders %s against %s by semver precedence', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});
