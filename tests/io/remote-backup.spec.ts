import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot } from '../../src/io/backup.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { lockEntryDigests } from '../../src/remote/lock-entries.js';
import { findRemoteLockDrift } from '../../src/remote/ownership.js';
import { readRemoteConfig, sha256Hex, writeRemoteConfig } from '../../src/remote/schema.js';
import { LOCAL_OVERLAY, OWNED_LOCK, OWNED_MANIFEST, OWNED_OVERLAY, writeRemoteOwnedFixture } from '../helpers/remote-fixture.js';

describe('snapshots with a remote subscription', () => {
  let home: string;
  let paths: EnvironmentPaths;
  const overlayFile = (name: string) => path.join(paths.overlaysDir, `${name}.yaml`);
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const EMPTY_MANIFEST = 'apiVersion: dshenv/v1\nprofiles: {}\n';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-backup-'));
    paths = resolveEnvironmentPaths({ cliDshHome: home });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('saves the manifest, lock and state, and local overlays only aside, without remote.json', async () => {
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, EMPTY_MANIFEST);
    fs.writeFileSync(overlayFile('mine'), LOCAL_OVERLAY);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-plain');
    expect(fs.readdirSync(snapshot.snapshotDir).sort()).toEqual(['existing-overlays', 'manifest.yaml', 'skills-saved']);
    expect(fs.readdirSync(path.join(snapshot.snapshotDir, 'existing-overlays'))).toEqual(['mine.yaml']);
  });

  it('saves remote.json and owned overlays but not local overlays', async () => {
    await writeRemoteOwnedFixture(home);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-remote');
    expect(fs.readdirSync(snapshot.snapshotDir).sort()).toEqual(['existing-overlays', 'lock.json', 'manifest.yaml', 'overlays', 'remote.json', 'skills-saved']);
    expect(fs.readdirSync(path.join(snapshot.snapshotDir, 'overlays'))).toEqual(['team.yaml']);
  });

  it('deletes an overlay the interrupted operation created before remote.json named it', async () => {
    await writeRemoteOwnedFixture(home);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-crash', { overlayKeys: ['overlays/extra.yaml'] });
    // Killed after writing the new overlay but before remote.json recorded it.
    fs.writeFileSync(overlayFile('extra'), OWNED_OVERLAY);

    await restoreEnvironmentSnapshot(snapshot, paths);

    expect(fs.existsSync(overlayFile('extra'))).toBe(false);
    expect(fs.existsSync(overlayFile('team'))).toBe(true);
  });

  it('restores owned files, deletes overlays owned since, and leaves local overlays alone', async () => {
    await writeRemoteOwnedFixture(home);
    const remoteBefore = read(paths.remoteFile);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-sync');

    fs.writeFileSync(overlayFile('team'), 'changed\n');
    fs.writeFileSync(overlayFile('extra'), OWNED_OVERLAY);
    fs.writeFileSync(overlayFile('mine'), `${LOCAL_OVERLAY}# edited\n`);
    const config = readRemoteConfig(paths)!;
    await writeRemoteConfig(paths, {
      ...config,
      commit: 'c'.repeat(40),
      files: { ...config.files, 'overlays/extra.yaml': sha256Hex(OWNED_OVERLAY) }
    });

    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(read(paths.remoteFile)).toBe(remoteBefore);
    expect(read(overlayFile('team'))).toBe(OWNED_OVERLAY);
    expect(fs.existsSync(overlayFile('extra'))).toBe(false);
    expect(read(overlayFile('mine'))).toBe(`${LOCAL_OVERLAY}# edited\n`);
  });

  it('puts back a local overlay that a later subscription took over with --replace', async () => {
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, EMPTY_MANIFEST);
    fs.writeFileSync(overlayFile('team'), `${LOCAL_OVERLAY}# mine\n`);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-before');
    await writeRemoteOwnedFixture(home);
    expect(read(overlayFile('team'))).toBe(OWNED_OVERLAY);

    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(read(overlayFile('team'))).toBe(`${LOCAL_OVERLAY}# mine\n`);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
  });

  // Windows needs extra rights to create symlinks.
  it.skipIf(process.platform === 'win32')('keeps a relative symlink in envctl/skills relative through a snapshot and its restore', async () => {
    const skill = path.join(paths.skillsDir, 'demo');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'demo');
    fs.symlinkSync('SKILL.md', path.join(skill, 'README.md'));
    const snapshot = await createEnvironmentSnapshot(paths, 'op-links');
    expect(fs.readlinkSync(path.join(snapshot.snapshotDir, 'skills', 'demo', 'README.md'))).toBe('SKILL.md');
    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.readlinkSync(path.join(skill, 'README.md'))).toBe('SKILL.md');
  });

  it.skipIf(process.platform === 'win32')('saves a linked envctl/skills by its content and restores it through the link', async () => {
    const target = path.join(home, 'dotfiles', 'skills');
    fs.mkdirSync(path.join(target, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(target, 'demo', 'SKILL.md'), 'v1');
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.symlinkSync(target, paths.skillsDir);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-linked');
    fs.writeFileSync(path.join(target, 'demo', 'SKILL.md'), 'v2');

    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.lstatSync(paths.skillsDir).isSymbolicLink()).toBe(true);
    expect(read(path.join(target, 'demo', 'SKILL.md'))).toBe('v1');
  });

  it.skipIf(process.platform === 'win32').each(['edited', 'deleted'])('saves an individual linked skill independently of its %s target', async (change) => {
    const target = path.join(home, 'dotfiles', 'demo');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'v1');
    fs.symlinkSync('SKILL.md', path.join(target, 'README.md'));
    fs.mkdirSync(paths.skillsDir, { recursive: true });
    const skill = path.join(paths.skillsDir, 'demo');
    fs.symlinkSync(path.relative(paths.skillsDir, target), skill);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-linked-skill');
    if (change === 'edited') fs.writeFileSync(path.join(target, 'SKILL.md'), 'v2');
    else fs.rmSync(target, { recursive: true });

    expect(read(path.join(snapshot.snapshotDir, 'skills', 'demo', 'SKILL.md'))).toBe('v1');
    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.lstatSync(skill).isSymbolicLink()).toBe(false);
    expect(read(path.join(skill, 'SKILL.md'))).toBe('v1');
    expect(fs.readlinkSync(path.join(skill, 'README.md'))).toBe('SKILL.md');
    if (change === 'edited') expect(read(path.join(target, 'SKILL.md'))).toBe('v2');
    else expect(fs.existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('removes only the link, never its target, when the snapshot predates a linked envctl/skills', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    const snapshot = await createEnvironmentSnapshot(paths, 'op-no-skills');
    const target = path.join(home, 'dotfiles', 'skills');
    fs.mkdirSync(path.join(target, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(target, 'demo', 'SKILL.md'), 'mine');
    fs.writeFileSync(path.join(target, 'NOTES.txt'), 'notes');
    fs.symlinkSync(target, paths.skillsDir);

    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.lstatSync(paths.skillsDir, { throwIfNoEntry: false })).toBeUndefined();
    expect(read(path.join(target, 'demo', 'SKILL.md'))).toBe('mine');
    expect(read(path.join(target, 'NOTES.txt'))).toBe('notes');
  });

  it.skipIf(process.platform === 'win32')('restores into the target of a dangling skills link, keeping the link', async () => {
    const target = path.join(home, 'dotfiles', 'skills');
    fs.mkdirSync(path.join(target, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(target, 'demo', 'SKILL.md'), 'v1');
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.symlinkSync(target, paths.skillsDir);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-dangling');
    fs.rmSync(target, { recursive: true });

    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.lstatSync(paths.skillsDir).isSymbolicLink()).toBe(true);
    expect(read(path.join(target, 'demo', 'SKILL.md'))).toBe('v1');
  });

  it('restoring a snapshot from before the subscription removes remote.json and owned overlays', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, EMPTY_MANIFEST);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-before');
    await writeRemoteOwnedFixture(home);

    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(overlayFile('team'))).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    expect(read(paths.manifestFile)).toBe(EMPTY_MANIFEST);
    expect(read(overlayFile('mine'))).toBe(LOCAL_OVERLAY);
  });

  it('saves extra overlay files so a replaced local overlay comes back', async () => {
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, EMPTY_MANIFEST);
    fs.writeFileSync(overlayFile('team'), `${LOCAL_OVERLAY}# local team\n`);
    const snapshot = await createEnvironmentSnapshot(paths, 'op-replace', { overlayKeys: ['overlays/team.yaml', 'overlays/absent.yaml'] });
    expect(fs.readdirSync(path.join(snapshot.snapshotDir, 'overlays'))).toEqual(['team.yaml']);
    await writeRemoteOwnedFixture(home);

    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(read(overlayFile('team'))).toBe(`${LOCAL_OVERLAY}# local team\n`);
    expect(fs.existsSync(overlayFile('absent'))).toBe(false);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
  });

  it('keeps a recorded-absent overlay that became local in the undo backup of a rollback', async () => {
    await writeRemoteOwnedFixture(home);
    await createEnvironmentSnapshot(paths, 'sync-new', { overlayKeys: ['overlays/extra.yaml'] });
    // The sync created extra.yaml; remote remove then left it in place as a local file, which the user edited.
    fs.writeFileSync(overlayFile('extra'), `${OWNED_OVERLAY}# mine\n`);
    fs.rmSync(paths.remoteFile);

    const result = await rollbackEnvironment(paths, { operationId: 'sync-new' });
    expect(fs.existsSync(overlayFile('extra'))).toBe(false);

    await rollbackEnvironment(paths, { operationId: result.backupSnapshotId });
    expect(read(overlayFile('extra'))).toBe(`${OWNED_OVERLAY}# mine\n`);
  });

  it('rollback restores the pinned commit and its undo backup keeps the newer one', async () => {
    await writeRemoteOwnedFixture(home);
    await createEnvironmentSnapshot(paths, 'sync-abc');
    const config = readRemoteConfig(paths)!;
    fs.writeFileSync(paths.manifestFile, `${OWNED_MANIFEST}# v2\n`);
    const lock = loadLock(OWNED_LOCK);
    lock.profiles.web.plugins.shared = { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '2.0.0' } };
    fs.writeFileSync(paths.lockFile, serializeLock(lock));
    await writeRemoteConfig(paths, {
      ...config,
      commit: 'c'.repeat(40),
      files: { ...config.files, 'manifest.yaml': sha256Hex(`${OWNED_MANIFEST}# v2\n`) },
      lockEntries: lockEntryDigests(lock)
    });

    const result = await rollbackEnvironment(paths, { operationId: 'sync-abc' });
    expect(readRemoteConfig(paths)?.commit).toBe('a'.repeat(40));
    expect(read(paths.manifestFile)).toBe(OWNED_MANIFEST);
    // lock.json is restored whole, so it matches the restored lockEntries again.
    expect(read(paths.lockFile)).toBe(OWNED_LOCK);
    expect(findRemoteLockDrift(paths, readRemoteConfig(paths)!)).toEqual([]);
    const backupDir = path.join(paths.backupsDir, result.backupSnapshotId!);
    expect(JSON.parse(read(path.join(backupDir, 'remote.json'))).commit).toBe('c'.repeat(40));
  });
});
