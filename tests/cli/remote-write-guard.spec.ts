import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { runCli } from '../../src/cli.js';
import type { EnvironmentPaths } from '../../src/environment/paths.js';
import { loadLock, loadManifest, parseOverlay } from '../../src/manifest/files.js';
import { findLocalDrift, findRemoteLockDrift } from '../../src/remote/ownership.js';
import { readRemoteConfig } from '../../src/remote/schema.js';
import { FIXTURE_REMOTE_URL, LOCAL_OVERLAY, OWNED_LOCK, OWNED_MANIFEST, OWNED_OVERLAY, writeRemoteOwnedFixture } from '../helpers/remote-fixture.js';

describe('CLI writes to remote-owned files and lock entries', () => {
  let home: string;
  let paths: EnvironmentPaths;
  const run = async (args: string[]) => {
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', home], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    return { code, stderr };
  };
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const overlayFile = (name: string) => path.join(paths.overlaysDir, `${name}.yaml`);
  const expectUnchanged = () => {
    expect(read(paths.manifestFile)).toBe(OWNED_MANIFEST);
    expect(read(paths.lockFile)).toBe(OWNED_LOCK);
    expect(read(overlayFile('team'))).toBe(OWNED_OVERLAY);
    expect(read(overlayFile('mine'))).toBe(LOCAL_OVERLAY);
  };

  async function localPluginRepo(): Promise<string> {
    const dir = path.join(home, 'upstream', 'local-tool');
    fs.mkdirSync(dir, { recursive: true });
    await execa('git', ['init', '--quiet'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'local-tool', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['commit', '--quiet', '-m', 'init'], { cwd: dir });
    return dir;
  }

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-guard-'));
    paths = await writeRemoteOwnedFixture(home);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it.each([
    [['install', 'extra-plugin@1.0.0', '-p', 'web']],
    [['enable', 'shared', '-p', 'web']],
    [['disable', 'shared', '-p', 'web']],
    [['remove', 'shared', '-p', 'web']],
    [['config', 'set', 'shared', 'mode', 'fast', '-p', 'web']]
  ])('refuses %j on the base', async (args) => {
    const { code, stderr } = await run(args);
    expect(code).toBe(3);
    expect(stderr).toContain(`The base manifest is owned by remote ${FIXTURE_REMOTE_URL}`);
    expect(stderr).toContain('--layer overlay');
    expectUnchanged();
  });

  it('refuses a base update when the team lock pins the version, before writing anything', async () => {
    const { code, stderr } = await run(['update', 'shared', '--to', '1.1.0', '-p', 'web']);
    expect(code).toBe(3);
    expect(stderr).toContain(`Lock entry 'web/shared' is pinned by the team lock of remote ${FIXTURE_REMOTE_URL}; change it in the team repository and run dshenv remote sync`);
    expectUnchanged();
  });

  // As install --layer overlay may: the version is the overlay's, and the team's lock entry is left as it is.
  it('lets a local overlay update a plugin the team lock pins, leaving the team lock entry alone', async () => {
    const { code } = await run(['update', 'shared', '--to', '1.1.0', '-p', 'web', '--overlay', 'mine', '--layer', 'overlay']);
    expect(code).toBe(0);
    expect(parseOverlay(read(overlayFile('mine')), 'mine').profiles?.web.plugins?.shared?.source).toMatchObject({ type: 'npm', version: '1.1.0' });
    expect(read(paths.lockFile)).toBe(OWNED_LOCK);
    expect(read(paths.manifestFile)).toBe(OWNED_MANIFEST);
  });

  it('writes a local overlay with --layer overlay', async () => {
    const { code } = await run(['install', 'extra-plugin@1.0.0', '-p', 'web', '--overlay', 'mine', '--layer', 'overlay']);
    expect(code).toBe(0);
    expect(parseOverlay(read(overlayFile('mine')), 'mine').profiles?.web.plugins?.['extra-plugin']?.package).toBe('extra-plugin');
    expect(read(paths.manifestFile)).toBe(OWNED_MANIFEST);
  });

  it('refuses writes to a remote-owned overlay', async () => {
    const { code, stderr } = await run(['disable', 'shared', '-p', 'web', '--overlay', 'team', '--layer', 'overlay']);
    expect(code).toBe(3);
    expect(stderr).toContain(`Overlay 'team' is owned by remote ${FIXTURE_REMOTE_URL}; use a local overlay with a different name`);
    expectUnchanged();
  });

  it('refuses source commands that write a team lock entry or the base, before touching any checkout', async () => {
    const clone = await run(['source', 'clone', 'file:///nonexistent/other.git', '-p', 'web', '--as', 'demo', '--overlay', 'mine', '--layer', 'overlay']);
    expect(clone.code).toBe(3);
    expect(clone.stderr).toContain(`Lock entry 'web/demo' is pinned by the team lock of remote ${FIXTURE_REMOTE_URL}`);

    const cloneBase = await run(['source', 'clone', 'file:///nonexistent/other.git', '-p', 'web', '--as', 'other']);
    expect(cloneBase.code).toBe(3);
    expect(cloneBase.stderr).toContain(`The base manifest is owned by remote ${FIXTURE_REMOTE_URL}`);
    expect(fs.existsSync(path.join(paths.managerDir, 'sources'))).toBe(false);

    const pull = await run(['source', 'pull', '-p', 'web', '--as', 'demo', '--ref', 'main']);
    expect(pull.code).toBe(3);
    expect(pull.stderr).toContain(`Lock entry 'web/demo' is pinned by the team lock of remote ${FIXTURE_REMOTE_URL}`);
    expectUnchanged();
  });

  it('lets source clone write a local lock entry and keeps the team entries', async () => {
    const upstream = await localPluginRepo();
    const { code } = await run(['source', 'clone', upstream, '-p', 'web', '--as', 'tool', '--overlay', 'mine', '--layer', 'overlay']);
    expect(code).toBe(0);
    expect(loadLock(read(paths.lockFile)).profiles.web.plugins.tool).toMatchObject({
      package: 'local-tool',
      source: { type: 'git', url: pathToFileURL(upstream).href }
    });
    expect(parseOverlay(read(overlayFile('mine')), 'mine').profiles?.web.plugins?.tool?.source).toEqual({ type: 'git', url: pathToFileURL(upstream).href });
    const config = readRemoteConfig(paths)!;
    expect(findRemoteLockDrift(paths, config)).toEqual([]);
    expect(findLocalDrift(paths, config)).toEqual([]);
  });

  it('refuses source clone into a remote-owned overlay before cloning', async () => {
    const { code, stderr } = await run(['source', 'clone', 'file:///nonexistent/other.git', '-p', 'web', '--as', 'other', '--overlay', 'team', '--layer', 'overlay']);
    expect(code).toBe(3);
    expect(stderr).toContain(`Overlay 'team' is owned by remote ${FIXTURE_REMOTE_URL}; use a local overlay with a different name`);
    expect(fs.existsSync(path.join(paths.managerDir, 'sources'))).toBe(false);
    expectUnchanged();
  });

  it('refuses an unsubscribed update on a corrupt lock file before writing the manifest', async () => {
    fs.rmSync(paths.remoteFile);
    fs.writeFileSync(paths.lockFile, '{');
    const before = read(paths.manifestFile);
    const { code, stderr } = await run(['update', 'shared', '--to', '1.1.0', '-p', 'web']);
    expect(code).toBe(3);
    expect(stderr).toContain('Invalid JSON in lock file');
    // As source sync does: the lock is read before the manifest is written, so a failed update changes nothing.
    expect(read(paths.manifestFile)).toBe(before);
  });

  it('refuses adopt', async () => {
    const candidate = path.join(home, 'candidate.yaml');
    expect((await run(['capture', '-o', candidate])).code).toBe(0);
    const { code, stderr } = await run(['adopt', '--from', candidate, '--yes']);
    expect(code).toBe(3);
    expect(stderr).toContain(`The base manifest is owned by remote ${FIXTURE_REMOTE_URL}`);
    expectUnchanged();
  });

  it('allows base and lock writes again once remote.json is gone', async () => {
    fs.rmSync(paths.remoteFile);
    expect((await run(['install', 'extra-plugin@1.0.0', '-p', 'web'])).code).toBe(0);
    expect((await run(['update', 'shared', '--to', '1.1.0', '-p', 'web'])).code).toBe(0);
    expect(loadLock(read(paths.lockFile)).profiles.web.plugins.shared.source).toEqual({ type: 'npm', resolvedVersion: '1.1.0' });
  });
});
