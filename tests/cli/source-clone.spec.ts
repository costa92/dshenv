import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import { pathToFileURL } from 'node:url';
import { runCli } from '../../src/cli.js';
import { loadManifest, loadLock, serializeManifest } from '../../src/manifest/files.js';
import { buildPlan } from '../../src/planner/plan.js';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { acquireEnvironmentLock } from '../../src/io/lock.js';

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
      'source', 'pull', '--yes', '--profile', 'web', '--as', 'demo', '--ref', `origin/${branch}`, '--dsh-home', tempHome
    ]);
    expect(code).toBe(0);
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    const gitLock = lock.profiles.web.plugins.demo.source;
    expect(gitLock.type).toBe('git');
    if (gitLock.type === 'git') {
      expect(gitLock.commit).toBe(newHead);
    }
  });

  it('waits for the environment lock before moving the clone or reading the manifest', async () => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    expect(await run(['source', 'clone', upstream, '-p', 'web', '--as', 'demo'])).toBe(0);
    fs.writeFileSync(path.join(upstream, 'next.txt'), 'next');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'next'], { cwd: upstream });
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const clone = path.join(paths.managerDir, 'sources', 'web', 'demo-plugin');
    const lockBefore = fs.readFileSync(paths.lockFile, 'utf8');
    const held = await acquireEnvironmentLock(paths);
    const pending = run(['source', 'sync', '--yes', '-p', 'web', '--as', 'demo']);
    try {
      await vi.waitFor(() => expect(fs.existsSync(`${held.lockPath}.wanted`)).toBe(true));
      expect(fs.existsSync(path.join(clone, 'next.txt'))).toBe(false);
      // A concurrent command removed this declaration. Sync must re-read it after locking.
      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      delete manifest.profiles.web.plugins.demo;
      fs.writeFileSync(paths.manifestFile, serializeManifest(manifest));
    } finally {
      await held.release();
      await pending;
    }
    expect(await pending).not.toBe(0);
    expect(fs.existsSync(path.join(clone, 'next.txt'))).toBe(false);
    expect(fs.readFileSync(paths.lockFile, 'utf8')).toBe(lockBefore);
  });

  it.each(['attached', 'detached'])('restores a %s checkout and leaves the lock unchanged when sync cannot write it', async (mode) => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    expect(await run(['source', 'clone', upstream, '-p', 'web', '--as', 'demo'])).toBe(0);
    const clone = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
    const git = (args: string[]) => execa('git', args, { cwd: clone });
    if (mode === 'attached') await git(['checkout', '-b', 'review-branch']);
    else await git(['checkout', '--detach']);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const lockFile = path.join(tempHome, 'envctl', 'lock.json');
    const before = fs.readFileSync(lockFile, 'utf8');
    fs.writeFileSync(path.join(upstream, 'next.txt'), 'next');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'next'], { cwd: upstream });
    const rename = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === 'lock.json') throw new Error('ENOSPC: test failure');
      return rename(from, to);
    });
    try {
      expect(await run(['source', 'sync', '--yes', '-p', 'web', '--as', 'demo', '--ref', 'origin/HEAD'])).not.toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe(branch);
    expect(fs.existsSync(path.join(clone, 'next.txt'))).toBe(false);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(before);
  });

  it('refuses a corrupt lock before sync changes the checkout', async () => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    expect(await run(['source', 'clone', upstream, '-p', 'web', '--as', 'demo'])).toBe(0);
    fs.writeFileSync(path.join(upstream, 'next.txt'), 'next');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'next'], { cwd: upstream });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'lock.json'), '{broken');
    expect(await run(['source', 'sync', '--yes', '-p', 'web', '--as', 'demo'])).not.toBe(0);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin', 'next.txt'))).toBe(false);
  });

  it('still takes the ref as a second positional argument', async () => {
    await runCli(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
    fs.writeFileSync(path.join(upstream, 'extra.txt'), 'second');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'second'], { cwd: upstream });
    const newHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    const branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: upstream })).stdout.trim();
    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');

    const code = await runCli(['source', 'pull', '--yes', cloneDir, `origin/${branch}`, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
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
    const code = await runCli(['source', 'pull', '--yes', other, 'HEAD', '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
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
    const code = await runCli(['source', 'pull', '--yes', '--profile', 'web', '--as', 'demo', '--ref', 'local-only', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
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
      ['source', 'pull', '--yes', '--profile', 'web', '--as', 'demo', '--ref', `origin/${branch}`, '--dsh-home', tempHome],
      { stdout: () => {}, stderr: () => {} }
    );
    expect(code).toBe(0);
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    expect(lock.profiles.web.plugins.demo).toEqual({ package: 'demo-plugin', source: { type: 'git', url: pathToFileURL(upstream).href, commit: newHead } });
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

    it('keeps the pinned commit and the manifest URL when the clone spells the same repository differently', async () => {
      const url = `file://${upstream}`;
      const pinned = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
      expect((await run(['install', `git+${url}#${pinned}`, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      await commit('newer.txt');

      expect(await run(['source', 'clone', `${url}/`, '--profile', 'web', '--as', 'demo'])).toEqual({ code: 0, stderr: '' });
      expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.demo.source).toEqual({ type: 'git', url, commit: pinned });
      expect(loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).profiles.web.plugins.demo.source).toEqual({ type: 'git', url, commit: pinned });
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

  it('records a plain repository path as a file:// URL, which pnpm installs as Git', async () => {
    expect(await runCli(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} })).toBe(0);
    const url = pathToFileURL(upstream).href;
    expect(loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web.plugins.demo.source).toEqual({ type: 'git', url });
    expect(loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).profiles.web.plugins.demo.source).toMatchObject({ type: 'git', url });
  });

  describe('input it refuses before cloning', () => {
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], {
        stdout: (chunk) => { stdout += chunk; },
        stderr: (chunk) => { stderr += chunk; }
      });
      return { code, stdout, stderr };
    };
    const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');

    it.each([
      ['an empty --ref', ['--ref', ''], 'Invalid --ref'],
      ['a --ref git would not take', ['--ref', 'main..x y'], 'Invalid --ref'],
      ['an invalid --package', ['--package', 'Bad Name'], "Invalid --package 'Bad Name'"]
    ])('refuses %s with exit 3, leaving nothing behind', async (_label, extra, message) => {
      const before = fs.readFileSync(manifestFile(), 'utf8');
      const { code, stderr } = await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', ...extra]);
      expect(code).toBe(3);
      expect(stderr).toContain(message);
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources'))).toBe(false);
    });

    it.each(['ext::sh -c touch% x', 'fd::17'])('refuses the transport-helper URL %j', async (url) => {
      const { code, stderr } = await run(['source', 'clone', url, path.join(tempHome, 'out')]);
      expect(code).toBe(3);
      expect(stderr).toMatch(/transport/);
      expect(fs.existsSync(path.join(tempHome, 'out'))).toBe(false);
    });

    it.each([
      ['--as', ['source', 'clone', 'UPSTREAM', 'OUT', '--as', 'demo']],
      ['--package', ['source', 'clone', 'UPSTREAM', 'OUT', '--package', 'demo-plugin']],
      ['--new-profile', ['source', 'clone', 'UPSTREAM', 'OUT', '--new-profile']],
      ['--as', ['source', 'show', 'UPSTREAM', '--as', 'demo']],
      ['--as', ['source', 'sync', 'UPSTREAM', '--as', 'demo']]
    ])('refuses %s without --profile instead of ignoring it', async (flag, args) => {
      const out = path.join(tempHome, 'out');
      const { code, stderr } = await run(args.map((arg) => (arg === 'UPSTREAM' ? upstream : arg === 'OUT' ? out : arg)));
      expect(code).toBe(3);
      expect(stderr).toContain(`${flag} requires --profile`);
      expect(fs.existsSync(out)).toBe(false);
    });

    it('checks an alias derived from the URL as it checks --as', async () => {
      const { code, stderr } = await run(['source', 'clone', path.join(tempHome, 'upstream', '__proto__.git'), '--profile', 'web']);
      expect(code).toBe(3);
      expect(stderr).toContain("Plugin alias '__proto__' is reserved");
    });

    it('refuses an empty ref for source sync', async () => {
      expect((await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
      for (const args of [['--profile', 'web', '--as', 'demo', '--ref', ''], [cloneDir, '']]) {
        const { code, stderr } = await run(['source', 'sync', ...args, '--yes']);
        expect(code).toBe(3);
        expect(stderr).toContain('Git ref must not be empty');
      }
    });

    it('refuses source show of a directory that does not exist', async () => {
      const { code, stderr } = await run(['source', 'show', path.join(tempHome, 'missing')]);
      expect(code).toBe(3);
      expect(stderr).toContain('Directory not found');
    });
  });

  it('takes a git+ URL as install does', async () => {
    const url = pathToFileURL(upstream).href;
    expect(await runCli(['source', 'clone', `git+${url}`, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web.plugins.demo.source).toEqual({ type: 'git', url });
  });

  it('reports a failed clone as a git error in --json, not the raw command', async () => {
    let output = '';
    const code = await runCli(['source', 'clone', path.join(tempHome, 'missing'), path.join(tempHome, 'out'), '--json', '--dsh-home', tempHome], {
      stdout: (chunk) => { output += chunk; },
      stderr: (chunk) => { output += chunk; }
    });
    expect(code).toBe(1);
    expect(output).toContain('git clone failed');
    expect(output).not.toContain('ExecaError');
  });

  it('source sync without a directory or --profile fast-forwards the checkout in the working directory', async () => {
    const checkout = path.join(tempHome, 'checkout');
    await execa('git', ['clone', '-q', upstream, checkout]);
    fs.writeFileSync(path.join(upstream, 'later.txt'), 'later');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-q', '-m', 'later'], { cwd: upstream });
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    const previous = process.cwd();
    process.chdir(checkout);
    try {
      expect(await runCli(['source', 'sync', '--yes', '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} })).toBe(0);
    } finally {
      process.chdir(previous);
    }
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim()).toBe(head);
  });

  it('takes the package name from the cloned package.json over the repository name install recorded', async () => {
    const repo = path.join(tempHome, 'upstream', 'dsh-plugin-baz');
    fs.mkdirSync(repo, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@scope/baz', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    const url = pathToFileURL(repo).href;
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });

    expect(await run(['install', `git+${url}`, '--profile', 'web'])).toBe(0);
    expect(await run(['source', 'clone', url, '--profile', 'web'])).toBe(0);
    const plugins = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web.plugins;
    expect(Object.keys(plugins)).toEqual(['baz']);
    expect(plugins.baz.package).toBe('@scope/baz');
    expect(loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).profiles.web.plugins.baz.package).toBe('@scope/baz');
  });

  it('records a relative repository path and a bare .git path as file:// URLs, and takes ssh:// as Git', async () => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    const previous = process.cwd();
    process.chdir(path.dirname(upstream));
    try {
      expect(await run(['source', 'clone', path.basename(upstream), '--profile', 'web', '--as', 'demo'])).toBe(0);
    } finally {
      process.chdir(previous);
    }
    const plugins = () => loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web.plugins;
    // A relative path resolves against process.cwd(), which on macOS is the real path (/private/var for /var).
    expect(plugins().demo.source).toEqual({ type: 'git', url: pathToFileURL(fs.realpathSync(upstream)).href });

    const bare = path.join(tempHome, 'qux.git');
    expect(await run(['install', bare, '--profile', 'web'])).toBe(0);
    expect(plugins().qux.source).toEqual({ type: 'git', url: pathToFileURL(bare).href });
    expect(await run(['install', 'ssh://git@example.invalid/org/repo', '--profile', 'web'])).toBe(0);
    expect(plugins().repo.source).toEqual({ type: 'git', url: 'ssh://git@example.invalid/org/repo' });
  });

  describe('source sync --profile against the commit the manifest pins', () => {
    const run = async (args: string[]) => {
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      return { code, stderr };
    };
    const locked = () => {
      const source = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8')).profiles.web.plugins.demo.source;
      return source.type === 'git' ? source.commit : undefined;
    };
    const head = async (dir: string) => (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const commitUpstream = async () => {
      fs.writeFileSync(path.join(upstream, 'next.txt'), String(Math.random()));
      await execa('git', ['add', '.'], { cwd: upstream });
      await execa('git', ['commit', '-q', '-m', 'next'], { cwd: upstream });
      return head(upstream);
    };

    it('only previews without --yes, as remote sync does: exit 2, neither the clone nor the lock moves', async () => {
      const url = pathToFileURL(upstream).href;
      expect((await run(['install', `git+${url}`, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      expect((await run(['source', 'clone', url, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      const clone = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
      const first = await head(clone);
      const second = await commitUpstream();

      for (const args of [[], ['--dry-run']]) {
        let stdout = '';
        let stderr = '';
        const code = await runCli(['source', 'sync', '--profile', 'web', '--as', 'demo', ...args, '--dsh-home', tempHome], {
          stdout: (chunk) => { stdout += chunk; },
          stderr: (chunk) => { stderr += chunk; }
        });
        expect(code).toBe(2);
        expect(stdout).toContain(`Would update ${clone} from ${first} to ${second}`);
        expect(stderr).toContain('Nothing was changed.');
        expect(await head(clone)).toBe(first);
        expect(locked()).toBe(first);
      }

      expect((await run(['source', 'sync', '--profile', 'web', '--as', 'demo', '--yes'])).code).toBe(0);
      expect(locked()).toBe(second);
      const settled = await run(['source', 'sync', '--profile', 'web', '--as', 'demo']);
      expect(settled.code).toBe(0);
    });

    it('moves a pinned clone on to the default branch, says the manifest still pins the old commit, and moves back with --ref', async () => {
      const url = pathToFileURL(upstream).href;
      const first = await head(upstream);
      expect((await run(['install', `git+${url}#${first}`, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      expect((await run(['source', 'clone', url, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      const second = await commitUpstream();

      const forward = await run(['source', 'sync', '--yes', '--profile', 'web', '--as', 'demo']);
      expect(forward.code).toBe(0);
      expect(locked()).toBe(second);
      expect(forward.stderr).toContain(`The manifest pins commit ${first} for demo in profile 'web', so plan stays blocked until it matches the locked ${second}`);

      const back = await run(['source', 'sync', '--yes', '--profile', 'web', '--as', 'demo', '--ref', first]);
      expect(back).toEqual({ code: 0, stderr: '' });
      expect(locked()).toBe(first);
      expect(await head(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin'))).toBe(first);
    });

    it('refuses to move a checkout outside envctl back instead of reporting success', async () => {
      const checkout = path.join(tempHome, 'checkout');
      await execa('git', ['clone', '-q', upstream, checkout]);
      const first = await head(checkout);
      await commitUpstream();
      expect((await run(['source', 'sync', '--yes', checkout])).code).toBe(0);
      const back = await run(['source', 'sync', '--yes', checkout, '--ref', first]);
      expect(back.code).toBe(3);
      expect(back.stderr).toContain('is not ahead of the checked-out commit; source sync only fast-forwards a checkout outside envctl');
    });

    it('install says the lock still pins another commit', async () => {
      const url = pathToFileURL(upstream).href;
      expect((await run(['source', 'clone', url, '--profile', 'web', '--as', 'demo'])).code).toBe(0);
      const second = await commitUpstream();
      const out = await run(['install', `git+${url}#${second}`, '--profile', 'web', '--as', 'demo']);
      expect(out.code).toBe(0);
      expect(out.stderr).toContain(`lock.json pins demo to ${locked()}; lock ${second} with: dshenv source sync --profile web --as demo --ref ${second} --yes`);
    });
  });
});
