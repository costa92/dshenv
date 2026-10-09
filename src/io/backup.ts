import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { EnvironmentPaths } from '../environment/paths.js';
import { readRemoteConfig, remoteFilePath, remoteOverlayKeys, type RemoteConfig } from '../remote/schema.js';
import { writeAtomic } from './atomic-file.js';
import { retryWhileBusy } from './windows-retry.js';

// Overlay keys the snapshot was asked to save that did not exist at the time.
const ABSENT_FILE = 'absent.json';
// Marks a snapshot that saved envctl/skills, so restoring one taken before skills existed leaves the directory alone.
const SKILLS_MARKER = 'skills-saved';
const SKILLS_DIR = 'skills';
// Every overlay file as it was, so one a later sync takes over (remote add --replace) can be put back, not deleted.
const EXISTING_OVERLAYS_DIR = 'existing-overlays';
// The overlay a rollback deselected as it removed it, kept in the snapshot it took first, so undoing that rollback selects it again.
const CLEARED_SELECTION_FILE = 'cleared-selection.json';
// The order snapshots were taken in: the time in their ids misorders them once the clock is set back.
const SEQUENCE_FILE = 'sequence';

export interface EnvironmentSnapshot {
  snapshotId: string;
  snapshotDir: string;
  timestamp: string;
}

export interface SnapshotOptions {
  // Overlay keys (overlays/<name>.yaml) to save besides the remote-owned ones, e.g. local files a sync will overwrite.
  overlayKeys?: string[];
}

export async function createEnvironmentSnapshot(
  paths: EnvironmentPaths,
  operationId: string,
  options?: SnapshotOptions
): Promise<EnvironmentSnapshot> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotId = `${timestamp}-${operationId}`;
  const snapshotDir = path.join(paths.backupsDir, snapshotId);
  // Built under a dot name and renamed when complete, so rollback never picks a half-copied snapshot.
  const stagingDir = path.join(paths.backupsDir, `.${snapshotId}.partial`);

  await fs.promises.mkdir(stagingDir, { recursive: true });
  try {
    await copySnapshotFiles(paths, stagingDir, options);
    // Taken under the environment lock, so no other snapshot can claim the same number.
    const sequence = Math.max(0, ...(await listEnvironmentSnapshots(paths)).map((snapshot) => snapshotSequence(snapshot.snapshotDir) ?? 0)) + 1;
    await fs.promises.writeFile(path.join(stagingDir, SEQUENCE_FILE), String(sequence));
    // On disk before it is renamed into place, so a crash cannot leave a complete-looking snapshot of empty files.
    await syncTree(stagingDir);
    await retryWhileBusy(() => fs.promises.rename(stagingDir, snapshotDir));
    await syncPath(paths.backupsDir);
  } catch (err) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
    throw err;
  }

  return {
    snapshotId,
    snapshotDir,
    timestamp
  };
}

// Best effort, as in writeAtomic: some platforms and file systems cannot sync a directory or a read-only handle.
async function syncPath(file: string): Promise<void> {
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // ignore
  }
}

async function syncTree(dir: string): Promise<void> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await syncTree(full);
    } else if (entry.isFile()) {
      await syncPath(full);
    }
  }
  await syncPath(dir);
}

function snapshotSequence(snapshotDir: string): number | null {
  try {
    const value = Number(fs.readFileSync(path.join(snapshotDir, SEQUENCE_FILE), 'utf8'));
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

async function copySnapshotFiles(paths: EnvironmentPaths, snapshotDir: string, options?: SnapshotOptions): Promise<void> {
  const filesToBackup = [paths.manifestFile, paths.lockFile, paths.stateFile];
  for (const file of filesToBackup) {
    if (fs.existsSync(file)) {
      const dest = path.join(snapshotDir, path.basename(file));
      await fs.promises.copyFile(file, dest);
    }
  }

  await fs.promises.writeFile(path.join(snapshotDir, SKILLS_MARKER), '');
  if (fs.existsSync(paths.skillsDir)) {
    // verbatimSymlinks: a relative link inside a skill would otherwise come back as an absolute, machine-specific one.
    // A linked skills directory is saved by its content, not as the link, which would follow later edits.
    await fs.promises.cp(await fs.promises.realpath(paths.skillsDir), path.join(snapshotDir, SKILLS_DIR), { recursive: true, verbatimSymlinks: true });
    // Individual linked skill directories are declarations by content too. Materialize only these roots;
    // symlinks inside a skill retain their original meaning. Restore uses a local copy, never writes to their targets.
    for (const entry of await fs.promises.readdir(paths.skillsDir, { withFileTypes: true })) {
      const source = path.join(paths.skillsDir, entry.name);
      if (entry.isSymbolicLink() && fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        const saved = path.join(snapshotDir, SKILLS_DIR, entry.name);
        await fs.promises.unlink(saved);
        await fs.promises.cp(await fs.promises.realpath(source), saved, { recursive: true, verbatimSymlinks: true });
      }
    }
  }

  if (fs.existsSync(paths.overlaysDir)) {
    for (const entry of await fs.promises.readdir(paths.overlaysDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        await fs.promises.mkdir(path.join(snapshotDir, EXISTING_OVERLAYS_DIR), { recursive: true });
        await fs.promises.copyFile(path.join(paths.overlaysDir, entry.name), path.join(snapshotDir, EXISTING_OVERLAYS_DIR, entry.name));
      }
    }
  }

  const remote = readRemoteConfig(paths);
  if (remote) {
    await fs.promises.copyFile(paths.remoteFile, path.join(snapshotDir, 'remote.json'));
  }
  const absent: string[] = [];
  for (const key of new Set([...remoteOverlayKeys(remote), ...(options?.overlayKeys ?? [])])) {
    const file = remoteFilePath(paths, key);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const dest = path.join(snapshotDir, key);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(file, dest);
    } else if (!fs.existsSync(file)) {
      absent.push(key);
    }
  }
  // An operation killed before remote.json names a file it created leaves no other trace of it.
  if (absent.length > 0) {
    await fs.promises.writeFile(path.join(snapshotDir, ABSENT_FILE), JSON.stringify(absent));
  }
}

export function readAbsentKeys(snapshot: EnvironmentSnapshot): string[] {
  const file = path.join(snapshot.snapshotDir, ABSENT_FILE);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]) : [];
}

export async function recordClearedSelection(snapshot: EnvironmentSnapshot, overlay: string): Promise<void> {
  await fs.promises.writeFile(path.join(snapshot.snapshotDir, CLEARED_SELECTION_FILE), JSON.stringify({ overlay }));
}

export function readClearedSelection(snapshot: EnvironmentSnapshot): string | null {
  try {
    const { overlay } = JSON.parse(fs.readFileSync(path.join(snapshot.snapshotDir, CLEARED_SELECTION_FILE), 'utf8')) as { overlay?: unknown };
    return typeof overlay === 'string' ? overlay : null;
  } catch {
    return null;
  }
}

// Overlay keys a restore of this snapshot writes or deletes, so a backup taken before it can hold what they replace.
export function snapshotOverlayKeys(snapshot: EnvironmentSnapshot): string[] {
  const saved = path.join(snapshot.snapshotDir, 'overlays');
  const held = fs.existsSync(saved) ? fs.readdirSync(saved).map((name) => `overlays/${name}`) : [];
  return [...new Set([...held, ...readAbsentKeys(snapshot)])];
}

function currentRemoteConfig(paths: EnvironmentPaths): RemoteConfig | null {
  try {
    return readRemoteConfig(paths);
  } catch {
    // A corrupt remote.json names no files to clean up; it is replaced or removed below.
    return null;
  }
}

async function restoreRemoteFiles(snapshot: EnvironmentSnapshot, paths: EnvironmentPaths): Promise<void> {
  // Overlays the remote owns now, or that were recorded absent, but the snapshot does not hold: a local file that existed
  // then is put back, any other did not exist, so it goes.
  const absent = readAbsentKeys(snapshot);
  for (const key of new Set([...remoteOverlayKeys(currentRemoteConfig(paths)), ...absent])) {
    if (fs.existsSync(path.join(snapshot.snapshotDir, key))) {
      continue;
    }
    const existing = path.join(snapshot.snapshotDir, EXISTING_OVERLAYS_DIR, path.basename(key));
    if (!absent.includes(key) && fs.existsSync(existing)) {
      await writeAtomic(remoteFilePath(paths, key), await fs.promises.readFile(existing), 'overwrite');
    } else {
      await fs.promises.rm(remoteFilePath(paths, key), { force: true });
    }
  }
  const savedOverlays = path.join(snapshot.snapshotDir, 'overlays');
  if (fs.existsSync(savedOverlays)) {
    for (const name of await fs.promises.readdir(savedOverlays)) {
      await writeAtomic(path.join(paths.overlaysDir, name), await fs.promises.readFile(path.join(savedOverlays, name)), 'overwrite');
    }
  }
  const savedRemote = path.join(snapshot.snapshotDir, 'remote.json');
  if (fs.existsSync(savedRemote)) {
    await writeAtomic(paths.remoteFile, await fs.promises.readFile(savedRemote), 'overwrite');
  } else {
    await fs.promises.rm(paths.remoteFile, { force: true });
  }
}

// Restores only these envctl files (manifest, lock or state) as the snapshot saved them.
export async function restoreSnapshotFiles(snapshot: EnvironmentSnapshot, files: string[]): Promise<void> {
  // A file absent from the snapshot did not exist then, so it must not survive the restore either.
  for (const file of files) {
    const saved = path.join(snapshot.snapshotDir, path.basename(file));
    if (fs.existsSync(saved)) {
      await writeAtomic(file, await fs.promises.readFile(saved), 'overwrite');
    } else {
      await fs.promises.rm(file, { force: true });
    }
  }
}

export async function restoreEnvironmentSnapshot(
  snapshot: EnvironmentSnapshot,
  paths: EnvironmentPaths
): Promise<void> {
  await restoreSnapshotFiles(snapshot, [paths.manifestFile, paths.lockFile, paths.stateFile]);
  await restoreRemoteFiles(snapshot, paths);
  if (fs.existsSync(path.join(snapshot.snapshotDir, SKILLS_MARKER))) {
    const saved = path.join(snapshot.snapshotDir, SKILLS_DIR);
    if (fs.lstatSync(paths.skillsDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      // A linked skills directory is the user's, outside envctl: a snapshot without skills drops only the link, and one
      // with skills puts its content back into the target, created again if it is gone, so the link stays.
      if (!fs.existsSync(saved)) {
        await fs.promises.unlink(paths.skillsDir);
        return;
      }
      await replaceDir(saved, await linkTarget(paths.skillsDir));
      return;
    }
    if (fs.existsSync(saved)) {
      await replaceDir(saved, paths.skillsDir);
    } else {
      await fs.promises.rm(paths.skillsDir, { recursive: true, force: true });
    }
  }
}

// Where a chain of links ends, never a link along it; resolved from the real directory each link is in, as the link
// text is relative to that, not to the path it was reached by (envctl itself may be a link).
async function linkTarget(link: string): Promise<string> {
  try {
    return await fs.promises.realpath(link);
  } catch {
    // The chain ends at nothing, which the restore creates.
  }
  let current = link;
  for (let hops = 0; hops < 40; hops++) {
    current = path.resolve(await fs.promises.realpath(path.dirname(current)), await fs.promises.readlink(current));
    if (!fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return current;
    }
  }
  throw new Error(`Too many levels of symbolic links at ${link}`);
}

// Copied beside the target and swapped in by rename, so an interrupted restore leaves the old content, never an empty
// or half-copied directory.
async function replaceDir(saved: string, target: string): Promise<void> {
  const staging = path.join(path.dirname(target), `.tmp-${path.basename(target)}-${crypto.randomBytes(6).toString('hex')}`);
  const aside = `${staging}-old`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.cp(saved, staging, { recursive: true, verbatimSymlinks: true });
    const existed = fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
    if (existed) {
      await retryWhileBusy(() => fs.promises.rename(target, aside));
    }
    try {
      await retryWhileBusy(() => fs.promises.rename(staging, target));
    } catch (err) {
      if (existed) {
        await fs.promises.rename(aside, target).catch(() => {});
      }
      throw err;
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  await fs.promises.rm(aside, { recursive: true, force: true });
}

// The time in a snapshot id, `<ISO time with ':' and '.' as '-'>-<operation id>`.
export function snapshotTime(snapshotId: unknown): string | null {
  const match = typeof snapshotId === 'string' ? snapshotId.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/) : null;
  return match ? `${match[1]}:${match[2]}:${match[3]}.${match[4]}Z` : null;
}

export async function listEnvironmentSnapshots(paths: EnvironmentPaths): Promise<EnvironmentSnapshot[]> {
  if (!fs.existsSync(paths.backupsDir)) {
    return [];
  }

  const entries = await fs.promises.readdir(paths.backupsDir, { withFileTypes: true });
  const snapshots: EnvironmentSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    snapshots.push({
      snapshotId: entry.name,
      snapshotDir: path.join(paths.backupsDir, entry.name),
      timestamp: entry.name
    });
  }
  // Newest first; one taken before snapshots were numbered is older than every numbered one.
  const sequences = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshotSequence(snapshot.snapshotDir) ?? 0]));
  snapshots.sort((a, b) => sequences.get(b.snapshotId)! - sequences.get(a.snapshotId)! || b.snapshotId.localeCompare(a.snapshotId));
  return snapshots;
}

// A snapshot id is `<timestamp>-<operation id>`, the timestamp an ISO time with ':' and '.' replaced by '-'.
export function snapshotOperationId(snapshotId: string): string {
  return snapshotId.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, '');
}

export async function findEnvironmentSnapshot(
  paths: EnvironmentPaths,
  operationId?: string
): Promise<EnvironmentSnapshot> {
  const snapshots = await listEnvironmentSnapshots(paths);
  if (snapshots.length === 0) {
    throw new Error('No environment snapshots found');
  }

  if (!operationId) {
    return snapshots[0];
  }

  const match = snapshots.find(
    (snapshot) => snapshot.snapshotId === operationId || snapshotOperationId(snapshot.snapshotId) === operationId
  );
  if (!match) {
    throw new Error(`Snapshot not found for operation: ${operationId}`);
  }
  return match;
}
