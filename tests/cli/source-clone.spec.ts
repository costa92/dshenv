import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import { runCli } from '../../src/cli.js';
import { loadManifest, loadLock, serializeManifest } from '../../src/manifest/files.js';
import { buildPlan } from '../../src/planner/plan.js';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('CLI source clone --profile', () => {
  let tempHome: string;
  let upstream: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-src-clone-'));
    upstream = path.join(tempHome, 'upstream', 'demo-plugin');
    fs.mkdirSync(upstream, { recursive: true });
    await execa('git', ['init'], { cwd: upstream });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream });
    await runCli(['init', '--dsh-home', tempHome]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('should clone into envctl/sources and lock the commit so plan is install not blocked', async () => {
    const code = await runCli([
      'source',
      'clone',
      upstream,
      '--profile',
      'web',
      '--as',
      'demo',
      '--dsh-home',
      tempHome
    ]);
    expect(code).toBe(0);

    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
    expect(fs.existsSync(path.join(cloneDir, 'package.json'))).toBe(true);

    const manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.web.plugins.demo.source.type).toBe('git');

    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    const gitLock = lock.profiles.web.plugins.demo.source;
    expect(gitLock.type).toBe('git');
    if (gitLock.type === 'git') {
      expect(gitLock.commit.length).toBeGreaterThan(6);
    }

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const inventory = await readEnvironmentInventory(paths);
    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.operations.some((op) => op.kind === 'blocked')).toBe(false);
    expect(plan.operations.some((op) => op.resource === 'plugin' && op.kind === 'install' && op.alias === 'demo')).toBe(true);
  });

  it('should update the lock commit on source pull --profile', async () => {
    await runCli([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome
    ]);
    fs.writeFileSync(path.join(upstream, 'extra.txt'), 'second');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'second'], { cwd: upstream });
    const newHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    const branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: upstream })).stdout.trim();

    const code = await runCli([
      'source', 'pull', '--profile', 'web', '--as', 'demo', '--ref', `origin/${branch}`, '--dsh-home', tempHome
    ]);
    expect(code).toBe(0);
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    const gitLock = lock.profiles.web.plugins.demo.source;
    expect(gitLock.type).toBe('git');
    if (gitLock.type === 'git') {
      expect(gitLock.commit).toBe(newHead);
    }
  });

  it('still takes the ref as a second positional argument', async () => {
    await runCli(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
    fs.writeFileSync(path.join(upstream, 'extra.txt'), 'second');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'second'], { cwd: upstream });
    const newHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    const branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: upstream })).stdout.trim();
    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');

    const code = await runCli(['source', 'pull', cloneDir, `origin/${branch}`, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
    expect(code).toBe(0);
    const gitLock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).profiles.web.plugins.demo.source;
    expect(gitLock.type === 'git' && gitLock.commit).toBe(newHead);
  });

  it('refuses to lock a checkout whose origin is not the declared repository', async () => {
    await runCli(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
    const lockBefore = fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8');
    const other = path.join(tempHome, 'other');
    await execa('git', ['clone', '--quiet', upstream, other]);
    await execa('git', ['remote', 'set-url', 'origin', 'https://example.com/someone/else.git'], { cwd: other });
    let stderr = '';
    const code = await runCli(['source', 'pull', other, 'HEAD', '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    expect(code).toBe(3);
    expect(stderr).toMatch(/origin .*not the repository .* declares/);
    expect(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).toBe(lockBefore);
  });

  it('refuses to lock a commit no branch of origin has', async () => {
    await runCli(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
    const lockBefore = fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8');
    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
    await execa('git', ['checkout', '--quiet', '-b', 'local-only'], { cwd: cloneDir });
    await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--quiet', '--allow-empty', '-m', 'unpushed'], { cwd: cloneDir });
    await execa('git', ['checkout', '--quiet', '-'], { cwd: cloneDir });
    let stderr = '';
    const code = await runCli(['source', 'pull', '--profile', 'web', '--as', 'demo', '--ref', 'local-only', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    expect(code).toBe(3);
    expect(stderr).toMatch(/not on any branch of origin/);
    expect(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).toBe(lockBefore);
  });

  it('should report the only managed clone via source status --profile', async () => {
    await runCli([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome
    ]);
    let stdout = '';
    const code = await runCli(
      ['source', 'status', '--profile', 'web', '--json', '--dsh-home', tempHome],
      {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: () => {}
      }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { dir: string; git: { isGitRepo: boolean; isDirty: boolean } };
    expect(parsed.git.isGitRepo).toBe(true);
    expect(parsed.git.isDirty).toBe(false);
    expect(parsed.dir).toContain(`${path.join('envctl', 'sources', 'web', 'demo-plugin')}`);
  });

  it('should require --as when a profile has multiple Git plugins', async () => {
    await runCli([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome
    ]);
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    const manifest = loadManifest(fs.readFileSync(manifestFile, 'utf8'));
    manifest.profiles.web.plugins.other = {
      ...manifest.profiles.web.plugins.demo,
      package: 'other-plugin'
    };
    fs.writeFileSync(manifestFile, serializeManifest(manifest));

    let stderr = '';
    const code = await runCli(
      ['source', 'status', '--profile', 'web', '--dsh-home', tempHome],
      {
        stdout: () => {},
        stderr: (chunk) => {
          stderr += chunk;
        }
      }
    );

    expect(code).toBe(3);
    expect(stderr).toContain('requires --as');
  });

  it.each([
    ['a repository that does not exist', () => ['source', 'clone', path.join(tempHome, 'upstream', 'missing'), '--profile', 'web', '--as', 'demo']],
    ['a ref the repository does not have', () => ['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--ref', 'no-such-branch']]
  ])('leaves nothing behind when git cannot clone %s', async (_label, args) => {
    const envctl = path.join(tempHome, 'envctl');
    const snapshot = () =>
      Object.fromEntries(fs.readdirSync(envctl).sort().map((name) => [name, fs.statSync(path.join(envctl, name)).isFile() ? fs.readFileSync(path.join(envctl, name), 'utf8') : 'dir']));
    const before = snapshot();
    let stderr = '';
    const code = await runCli([...args(), '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/git clone/);
    expect(fs.existsSync(path.join(envctl, 'sources'))).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('keeps a concurrent clone when a second clone of the same package fails', async () => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    const codes = await Promise.all([
      run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo']),
      run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo'])
    ]);

    expect(codes.sort()).toEqual([0, 3]);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin', 'package.json'))).toBe(true);
  });

  it('leaves the manifest untouched when the lock file is corrupt', async () => {
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    const before = fs.readFileSync(manifestFile, 'utf8');
    fs.writeFileSync(path.join(tempHome, 'envctl', 'lock.json'), '{not json');

    const code = await runCli(
      ['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome],
      { stdout: () => {}, stderr: () => {} }
    );

    expect(code).not.toBe(0);
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin'))).toBe(false);
  });

  it('puts the manifest back and removes the clone when writing the lock fails', async () => {
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    const lockFile = path.join(tempHome, 'envctl', 'lock.json');
    const before = fs.readFileSync(manifestFile, 'utf8');
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // Compared by name: macOS and Windows may spell the temp directory differently (/private/var, RUNNER~1).
      if (path.basename(String(to)) === path.basename(lockFile)) throw new Error('ENOSPC: no space left on device');
      return rename(from, to);
    });
    try {
      const code = await runCli(
        ['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome],
        { stdout: () => {}, stderr: () => {} }
      );
      expect(code).not.toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin'))).toBe(false);
  });

  it('writes the lock entry on source pull --profile even when the lock has none yet', async () => {
    await runCli(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
    fs.rmSync(path.join(tempHome, 'envctl', 'lock.json'));
    fs.writeFileSync(path.join(upstream, 'extra.txt'), 'second');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'second'], { cwd: upstream });
    const newHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    const branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: upstream })).stdout.trim();

    const code = await runCli(
      ['source', 'pull', '--profile', 'web', '--as', 'demo', '--ref', `origin/${branch}`, '--dsh-home', tempHome],
      { stdout: () => {}, stderr: () => {} }
    );
    expect(code).toBe(0);
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    expect(lock.profiles.web.plugins.demo).toEqual({ package: 'demo-plugin', source: { type: 'git', url: upstream, commit: newHead } });
  });

  it('keeps patches and the enabled state when cloning over an existing alias', async () => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    await run(['install', 'demo-plugin@1.0.0', '--profile', 'web', '--as', 'demo']);
    await run(['config', 'set', 'demo', 'mode', 'fast', '--profile', 'web']);
    await run(['disable', 'demo', '--profile', 'web']);

    expect(await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo'])).toBe(0);
    const demo = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web.plugins.demo;
    expect(demo.source.type).toBe('git');
    expect(demo.enabled).toBe(false);
    expect(demo.patches).toEqual([{ id: 'demo', config: { mode: 'fast' } }]);
  });

  describe('over a declared git plugin', () => {
    const run = async (args: string[]) => {
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      return { code, stderr };
    };
    const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
    const lockedCommit = () => {
      const source = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).profiles.web.plugins.demo.source;
      return source.type === 'git' ? source.commit : undefined;
    };
    const commit = async (file: string) => {
      fs.writeFileSync(path.join(upstream, file), file);
      await execa('git', ['add', '.'], { cwd: upstream });
      await execa('git', ['commit', '-m', file], { cwd: upstream });
      return (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    };

    it('locks the commit the manifest pins, not the newer HEAD, and keeps it declared', async () => {
      const url = `file://${upstream}`;
      const pinned = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
      expect((await run(['install', `git+${url}#${pinned}`, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      await commit('newer.txt');

      expect(await run(['source', 'clone', url, '--profile', 'web', '--as', 'demo'])).toEqual({ code: 0, stderr: '' });
      expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.demo.source).toEqual({ type: 'git', url, commit: pinned });
      expect(lockedCommit()).toBe(pinned);
      const cloneHead = await execa('git', ['rev-parse', 'HEAD'], { cwd: path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin') });
      expect(cloneHead.stdout.trim()).toBe(pinned);
    });

    it('clones the ref the manifest declares and keeps it declared', async () => {
      const url = `file://${upstream}`;
      await execa('git', ['checkout', '-q', '-b', 'feature'], { cwd: upstream });
      const featureHead = await commit('feature.txt');
      await execa('git', ['checkout', '-q', '-'], { cwd: upstream });
      expect((await run(['install', `git+${url}#feature`, '--profile', 'web', '--as', 'demo'])).code).toBe(0);

      expect((await run(['source', 'clone', url, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.demo.source).toEqual({ type: 'git', url, ref: 'feature' });
      expect(lockedCommit()).toBe(featureHead);
    });

    it('refuses a pinned commit the repository does not have, leaving nothing behind', async () => {
      const url = `file://${upstream}`;
      expect((await run(['install', `git+${url}#${'a'.repeat(40)}`, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      const before = fs.readFileSync(manifestFile(), 'utf8');
      const clone = await run(['source', 'clone', url, '--profile', 'web', '--as', 'demo']);
      expect(clone.code).toBe(3);
      expect(clone.stderr).toContain(`Commit ${'a'.repeat(40)} that the manifest pins for 'demo' is not in ${url}`);
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources'))).toBe(false);
    });
  });

  it('refuses an alias another package has, in the base and in the overlay, leaving nothing behind', async () => {
    const run = async (args: string[]) => {
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      return { code, stderr };
    };
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    expect((await run(['install', 'other-plugin@1.0.0', '--profile', 'web', '--as', 'demo'])).code).toBe(0);
    const before = fs.readFileSync(manifestFile, 'utf8');
    const lockFile = path.join(tempHome, 'envctl', 'lock.json');
    const lockBefore = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null;
    const lockNow = () => (fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null);
    const base = await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo']);
    expect(base.code).toBe(3);
    expect(base.stderr).toContain("Alias 'demo' is 'other-plugin' in profile 'web'");
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
    expect(lockNow()).toBe(lockBefore);

    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    const overlayFile = path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml');
    fs.writeFileSync(overlayFile, 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      extra:\n        package: extra-plugin\n        source: { type: npm, version: "2.0.0" }\n');
    expect((await run(['overlay', 'use', 'laptop'])).code).toBe(0);
    const overlayBefore = fs.readFileSync(overlayFile, 'utf8');
    const overlay = await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'extra', '--layer', 'overlay']);
    expect(overlay.code).toBe(3);
    expect(overlay.stderr).toContain("Alias 'extra' is 'extra-plugin' in profile 'web'");
    expect(fs.readFileSync(overlayFile, 'utf8')).toBe(overlayBefore);
    expect(lockNow()).toBe(lockBefore);
    expect(fs.readdirSync(path.join(tempHome, 'envctl')).filter((name) => name === 'sources')).toEqual([]);
  });

  it('derives the alias as install does, dropping a dsh-plugin- prefix', async () => {
    const repo = path.join(tempHome, 'upstream', 'dsh-plugin-demo');
    fs.mkdirSync(repo, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'dsh-plugin-demo', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], { cwd: repo });
    const url = `file://${repo}`;
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });

    expect(await run(['install', `git+${url}`, '--profile', 'web'])).toBe(0);
    expect(await run(['source', 'clone', url, '--profile', 'web'])).toBe(0);
    expect(Object.keys(loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web.plugins)).toEqual(['demo']);
  });
});
