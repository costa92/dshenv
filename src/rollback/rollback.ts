import * as crypto from 'node:crypto';
import type { EnvironmentPaths } from '../environment/paths.js';
import { withEnvironmentLock } from '../io/lock.js';
import {
  createEnvironmentSnapshot,
  findEnvironmentSnapshot,
  listEnvironmentSnapshots,
  readAbsentKeys,
  restoreEnvironmentSnapshot,
  snapshotOverlayKeys,
  type EnvironmentSnapshot
} from '../io/backup.js';
import { appendJournalEntry, readJournalEntries } from '../io/journal.js';
import { ValidationError } from '../errors.js';
import { overlayFilePath, readSelectionFile, writeSelectionFile } from '../overlay/selection.js';
import { loadLock, loadManifest, loadState, parseOverlay, serializeLock, serializeState, withResources } from '../manifest/files.js';
import * as path from 'node:path';
import { writeAtomic } from '../io/atomic-file.js';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { readSkillDigests } from '../resources/skill.js';
import { dropUninstalledOwnership } from '../resources/plugin.js';
import { isDeepStrictEqual } from 'node:util';
import type { EnvironmentLock, EnvironmentState } from '../domain.js';
import * as fs from 'node:fs';

export interface RollbackOptions {
  operationId?: string;
  dryRun?: boolean;
}

export interface RollbackResult {
  rolledBack: boolean;
  dryRun: boolean;
  snapshotId: string;
  operationId?: string;
  // Snapshot of the files the rollback replaced; rolling back to it undoes the rollback.
  backupSnapshotId?: string;
  message: string;
}

function readState(paths: EnvironmentPaths): EnvironmentState | null {
  try {
    return fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
  } catch {
    return null;
  }
}

// Rollback leaves the profiles alone, so what the restored state.json says about them must still match them: a plugin
// an apply installed and that is still installed stays dshenv's to remove, one no longer installed is not, and a
// restart owed before the rollback is still owed. Skills in DSH_HOME/skills stay too: one still as dshenv last synced
// it keeps that baseline, so apply converges it. Restarts follow the state from before the rollback both ways.
async function keepLiveState(paths: EnvironmentPaths, before: EnvironmentState | null): Promise<void> {
  const restored = readState(paths);
  if (fs.existsSync(paths.stateFile) && !restored) {
    return;
  }
  const next: EnvironmentState = restored ?? { apiVersion: 'dshenv-state/v1', lastApplied: '', appliedLockHash: '', profiles: {} };
  let plugin = structuredClone(next.resources?.plugin ?? {});
  const skill = structuredClone(next.resources?.skill ?? {});
  const profiles = structuredClone(next.profiles);
  if (before?.resources?.plugin || next.resources?.plugin) {
    const inventory = await readEnvironmentInventory(paths);
    for (const [profile, packages] of Object.entries(before?.resources?.plugin ?? {})) {
      for (const [packageName, record] of Object.entries(packages)) {
        // Adopted plugins were DSH's before; rolling back an adopt gives them back.
        if (record.adoptedBy.startsWith('apply-') && !plugin[profile]?.[packageName]) {
          (plugin[profile] ??= {})[packageName] = record;
        }
      }
    }
    plugin = dropUninstalledOwnership(plugin, inventory);
  }
  for (const [profile, { plugins }] of Object.entries(before?.profiles ?? {})) {
    for (const [packageName, record] of Object.entries(plugins)) {
      if (record.status === 'restart-required') {
        (profiles[profile] ??= { plugins: {} }).plugins[packageName] = record;
      }
    }
  }
  // A restart the restored state still owes but DSH has had since (mark-restarted) is not owed again.
  if (before) {
    for (const [profile, { plugins }] of Object.entries(profiles)) {
      for (const [packageName, record] of Object.entries(plugins)) {
        const live = before.profiles[profile]?.plugins[packageName];
        if (record.status === 'restart-required' && live?.status !== 'restart-required') {
          if (live) plugins[packageName] = live;
          else delete plugins[packageName];
        }
      }
    }
  }
  if (before?.resources?.skill) {
    const live = await readSkillDigests(paths.dshSkillsDir);
    for (const [name, record] of Object.entries(before.resources.skill)) {
      if (live[name] === record.digest && skill[name]?.digest !== record.digest) {
        skill[name] = record;
      }
    }
  }
  const changed = !isDeepStrictEqual(plugin, next.resources?.plugin ?? {}) ||
    !isDeepStrictEqual(skill, next.resources?.skill ?? {}) ||
    !isDeepStrictEqual(profiles, next.profiles);
  if (changed) {
    await writeAtomic(paths.stateFile, serializeState(withResources({ ...next, profiles }, { plugin, skill })), 'overwrite');
  }
}

function readLock(paths: EnvironmentPaths): EnvironmentLock | null {
  try {
    return fs.existsSync(paths.lockFile) ? loadLock(fs.readFileSync(paths.lockFile, 'utf8')) : null;
  } catch {
    return null;
  }
}

// The local paths any layer declares, by profile and alias; null when a layer cannot be read.
function declaredLocalPaths(paths: EnvironmentPaths): Map<string, string> | null {
  const declared = new Map<string, string>();
  try {
    const layers: Array<{ profiles?: Record<string, { plugins?: Record<string, { source?: { type: string; path?: string } }> }> }> = [
      loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'))
    ];
    for (const name of fs.existsSync(paths.overlaysDir) ? fs.readdirSync(paths.overlaysDir) : []) {
      if (name.endsWith('.yaml')) {
        const file = path.join(paths.overlaysDir, name);
        layers.push(parseOverlay(fs.readFileSync(file, 'utf8'), file));
      }
    }
    for (const layer of layers) {
      for (const [profile, { plugins }] of Object.entries(layer.profiles ?? {})) {
        for (const [alias, plugin] of Object.entries(plugins ?? {})) {
          if (plugin.source?.path !== undefined) declared.set(`${profile}\0${alias}\0${plugin.source.type}`, path.normalize(plugin.source.path));
        }
      }
    }
  } catch {
    return null;
  }
  return declared;
}

// The restored lock.json predates the install of a local plugin that is still installed; without the digest recorded
// when it was installed, the next plan reinstalls it although nothing changed.
async function keepLiveLocalDigests(paths: EnvironmentPaths, before: EnvironmentLock | null): Promise<void> {
  const live = Object.entries(before?.profiles ?? {}).flatMap(([profile, { plugins }]) =>
    Object.entries(plugins)
      .filter(([, entry]) => entry.source.type === 'local-link' || entry.source.type === 'local-file')
      .map(([alias, entry]) => ({ profile, alias, entry }))
  );
  if (live.length === 0) {
    return;
  }
  const declared = declaredLocalPaths(paths);
  if (!declared) {
    return;
  }
  const inventory = await readEnvironmentInventory(paths);
  const restored = readLock(paths);
  if (fs.existsSync(paths.lockFile) && !restored) {
    return;
  }
  const next: EnvironmentLock = structuredClone(restored ?? { apiVersion: 'dshenv-lock/v1', profiles: {} });
  let changed = false;
  for (const { profile, alias, entry } of live) {
    const source = entry.source as { type: string; path: string };
    if (declared.get(`${profile}\0${alias}\0${source.type}`) !== path.normalize(source.path)) continue;
    if (!inventory.profiles[profile]?.plugins[entry.package]?.installed) continue;
    if (isDeepStrictEqual(next.profiles[profile]?.plugins[alias], entry)) continue;
    ((next.profiles[profile] ??= { plugins: {} }).plugins)[alias] = entry;
    changed = true;
  }
  if (changed) {
    await writeAtomic(paths.lockFile, serializeLock(next), 'overwrite');
  }
}

// Restoring a file that does not parse would leave every later command failing on it.
function assertSnapshotReadable(snapshotId: string, snapshotDir: string): void {
  const loaders: Array<[string, (content: string) => unknown]> = [
    ['manifest.yaml', loadManifest],
    ['lock.json', loadLock],
    ['state.json', loadState]
  ];
  for (const [file, load] of loaders) {
    const saved = path.join(snapshotDir, file);
    if (!fs.existsSync(saved)) {
      continue;
    }
    try {
      load(fs.readFileSync(saved, 'utf8'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Snapshot ${snapshotId} cannot be restored: its ${file} is invalid (${message})`);
    }
  }
}

// A snapshot id is `<timestamp>-<operation id>`, the timestamp an ISO time with ':' and '.' replaced by '-'.
function snapshotOperationId(snapshotId: string): string {
  return snapshotId.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, '');
}

// Applies that failed and put their own lock.json and state.json back; restoring their snapshot changes nothing.
async function selfUndoneApplies(paths: EnvironmentPaths): Promise<Set<string>> {
  return new Set((await readJournalEntries(paths)).filter((entry) => entry.type === 'apply-rollback').map((entry) => entry.operationId));
}

// The latest apply that completed and whose snapshot still exists: its snapshot holds the manifest it applied.
export async function lastSuccessfulApply(paths: EnvironmentPaths): Promise<string | null> {
  const snapshots = new Set((await listEnvironmentSnapshots(paths)).map((snapshot) => snapshotOperationId(snapshot.snapshotId)));
  const completed = (await readJournalEntries(paths)).filter((entry) => entry.type === 'apply-completed' && snapshots.has(entry.operationId));
  return completed.at(-1)?.operationId ?? null;
}

// Without an id, the latest snapshot that is not from a failed apply: that one already undid itself.
async function pickSnapshot(paths: EnvironmentPaths, operationId: string | undefined): Promise<{ snapshot: EnvironmentSnapshot; skipped: string[] }> {
  if (operationId) {
    return { snapshot: await findEnvironmentSnapshot(paths, operationId), skipped: [] };
  }
  const snapshots = await listEnvironmentSnapshots(paths);
  if (snapshots.length === 0) {
    throw new Error('No environment snapshots found');
  }
  const undone = await selfUndoneApplies(paths);
  const skipped: string[] = [];
  for (const snapshot of snapshots) {
    const id = snapshotOperationId(snapshot.snapshotId);
    if (!undone.has(id)) {
      return { snapshot, skipped };
    }
    skipped.push(id);
  }
  throw new Error(
    `Every snapshot left is from a failed apply that already undid itself (${skipped.join(', ')}); name one to restore it anyway: dshenv rollback <operation-id> --yes`
  );
}

// Picked under the lock, so a concurrent apply cannot add or undo a snapshot between the choice and the restore.
export async function rollbackEnvironment(
  paths: EnvironmentPaths,
  options?: RollbackOptions
): Promise<RollbackResult> {
  const rollback = () => rollbackDecided(paths, options);
  return options?.dryRun ? rollback() : withEnvironmentLock(paths, rollback);
}

async function rollbackDecided(
  paths: EnvironmentPaths,
  options?: RollbackOptions
): Promise<RollbackResult> {
  let picked;
  try {
    picked = await pickSnapshot(paths, options?.operationId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(message);
  }
  const { snapshot, skipped } = picked;
  assertSnapshotReadable(snapshot.snapshotId, snapshot.snapshotDir);
  // "As they were before apply-X" read as undoing apply-X; the snapshot holds the manifest it applied.
  const snapshotOf = snapshotOperationId(snapshot.snapshotId);
  const target = snapshotOf.startsWith('apply-')
    ? `saved when ${snapshotOf} started (snapshot ${snapshot.snapshotId}): the manifest it applied, with lock.json and state.json from before it ran`
    : `saved when ${snapshotOf} started (snapshot ${snapshot.snapshotId})`;
  const skippedNote =
    skipped.length > 0 ? `; skipped ${skipped.join(', ')}, which failed and had already undone its own changes` : '';

  if (options?.dryRun) {
    return {
      rolledBack: false,
      dryRun: true,
      snapshotId: snapshot.snapshotId,
      operationId: options.operationId,
      message: `Would restore the envctl files ${target}${skippedNote}`
    };
  }

  const operationId = `rollback-${snapshot.snapshotId}`;
  await appendJournalEntry(paths, {
    operationId,
    type: 'rollback-started',
    timestamp: new Date().toISOString(),
    details: { snapshotId: snapshot.snapshotId, targetOperationId: options?.operationId }
  });
  // A fresh id, so lookups by the restored snapshot's operation id never match this backup.
  // Overlays the restore overwrites or deletes may hold local edits by now, so the backup must hold them too.
  const backup = await createEnvironmentSnapshot(paths, `pre-rollback-${crypto.randomBytes(6).toString('hex')}`, {
    overlayKeys: snapshotOverlayKeys(snapshot)
  });
  const before = readState(paths);
  const lockBefore = readLock(paths);
  // A pull or remote add may have created the selected overlay the restore removes; a selection of nothing breaks every command.
  const selected = readSelectionFile(paths);
  const selectedExisted = selected !== null && fs.existsSync(overlayFilePath(paths, selected));
  await restoreEnvironmentSnapshot(snapshot, paths);
  await keepLiveState(paths, before);
  await keepLiveLocalDigests(paths, lockBefore);
  let selectionNote = '';
  if (selected && !fs.existsSync(overlayFilePath(paths, selected)) && (selectedExisted || readAbsentKeys(snapshot).includes(`overlays/${selected}.yaml`))) {
    await writeSelectionFile(paths, null);
    selectionNote = `; overlay '${selected}' it removed was selected; no overlay is selected now`;
  }
  await appendJournalEntry(paths, {
    operationId,
    type: 'rollback-completed',
    timestamp: new Date().toISOString(),
    details: { snapshotId: snapshot.snapshotId }
  });
  return {
    rolledBack: true,
    dryRun: false,
    snapshotId: snapshot.snapshotId,
    operationId: options?.operationId,
    backupSnapshotId: backup.snapshotId,
    message: `Restored the envctl files ${target}; the files it replaced are saved as snapshot ${backup.snapshotId}${skippedNote}${selectionNote}`
  };
}
