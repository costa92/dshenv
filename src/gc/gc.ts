import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { withEnvironmentLock } from '../io/lock.js';
import { appendJournalEntry } from '../io/journal.js';
import { ValidationError } from '../errors.js';
import { listEnvironmentSnapshots, snapshotTime } from '../io/backup.js';
import { retryWhileBusy } from '../io/windows-retry.js';

export interface GcOptions {
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface GcResult {
  dryRun: boolean;
  deleted: string[];
  skipped: string[];
  message: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function collectTrashGcTargets(
  paths: EnvironmentPaths,
  olderThanDays: number
): Promise<{ deleted: string[]; skipped: string[] }> {
  if (olderThanDays < 0) {
    throw new ValidationError('olderThanDays must be >= 0');
  }
  const deleted: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(paths.trashDir)) {
    return { deleted, skipped };
  }

  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(paths.trashDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(paths.trashDir, entry.name);
    if (!isPathInside(paths.trashDir, fullPath)) {
      skipped.push(fullPath);
      continue;
    }
    const stat = await fs.promises.lstat(fullPath);
    if (stat.mtimeMs > cutoff) {
      skipped.push(fullPath);
      continue;
    }
    deleted.push(fullPath);
  }
  return { deleted, skipped };
}

// rollback can only go back to a snapshot gc left, so the newest ones stay whatever their age.
const KEEP_SNAPSHOTS = 10;

export async function collectSnapshotGcTargets(paths: EnvironmentPaths, olderThanDays: number): Promise<string[]> {
  if (!fs.existsSync(paths.backupsDir)) {
    return [];
  }
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const expired = (dir: string, time: string | null) => (time ? Date.parse(time) : fs.statSync(dir).mtimeMs) <= cutoff;
  const targets = (await listEnvironmentSnapshots(paths))
    .slice(KEEP_SNAPSHOTS)
    .filter((snapshot) => expired(snapshot.snapshotDir, snapshotTime(snapshot.snapshotId)))
    .map((snapshot) => snapshot.snapshotDir);
  // A copy a killed operation never renamed into place; no snapshot can still be building one this old.
  // One a killed gc was deleting is no snapshot any more, whatever its age.
  for (const entry of await fs.promises.readdir(paths.backupsDir, { withFileTypes: true })) {
    const dir = path.join(paths.backupsDir, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('.') && ((entry.name.endsWith('.partial') && expired(dir, null)) || entry.name.endsWith(DELETING))) {
      targets.push(dir);
    }
  }
  return targets;
}

const DELETING = '.deleting';

// Staging copies of skills a killed apply left in DSH's skills directory; DSH skips .tmp-* names.
export async function collectSkillStagingGcTargets(paths: EnvironmentPaths, olderThanDays: number): Promise<string[]> {
  if (!fs.existsSync(paths.dshSkillsDir)) {
    return [];
  }
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const targets: string[] = [];
  for (const entry of await fs.promises.readdir(paths.dshSkillsDir, { withFileTypes: true })) {
    const dir = path.join(paths.dshSkillsDir, entry.name);
    if (entry.name.startsWith('.tmp-') && (await fs.promises.lstat(dir)).mtimeMs <= cutoff) {
      targets.push(dir);
    }
  }
  return targets;
}

// Renamed to a dot name first, which no listing takes for a snapshot, so a gc killed halfway leaves no half-deleted
// snapshot that rollback would restore; the next gc finishes it.
async function deleteSnapshot(paths: EnvironmentPaths, dir: string): Promise<void> {
  let doomed = dir;
  if (!path.basename(dir).endsWith(DELETING)) {
    doomed = path.join(paths.backupsDir, `.${path.basename(dir)}${DELETING}`);
    await retryWhileBusy(() => fs.promises.rename(dir, doomed));
  }
  await fs.promises.rm(doomed, { recursive: true, force: true });
}

// Collected under the lock, so a concurrent purge or gc cannot change the trash in between.
export async function gcEnvironment(
  paths: EnvironmentPaths,
  options?: GcOptions
): Promise<GcResult> {
  const gc = () => gcDecided(paths, options);
  return options?.dryRun ? gc() : withEnvironmentLock(paths, gc);
}

async function gcDecided(
  paths: EnvironmentPaths,
  options?: GcOptions
): Promise<GcResult> {
  const olderThanDays = options?.olderThanDays ?? 7;
  const targets = await collectTrashGcTargets(paths, olderThanDays);
  const snapshots = await collectSnapshotGcTargets(paths, olderThanDays);
  const staging = await collectSkillStagingGcTargets(paths, olderThanDays);
  const counts = `${String(targets.deleted.length)} trash item(s)${snapshots.length > 0 ? ` and ${String(snapshots.length)} snapshot(s)` : ''}` +
    (staging.length > 0 ? ` and ${String(staging.length)} skill staging dir(s)` : '');

  if (options?.dryRun) {
    return {
      dryRun: true,
      deleted: [...targets.deleted, ...snapshots, ...staging],
      skipped: targets.skipped,
      message: `Would delete ${counts}`
    };
  }

  const operationId = `gc-${Date.now().toString(16)}`;
  await appendJournalEntry(paths, {
    operationId,
    type: 'gc-started',
    timestamp: new Date().toISOString(),
    details: { olderThanDays, count: targets.deleted.length + snapshots.length + staging.length }
  });

  for (const target of targets.deleted) {
    if (!isPathInside(paths.trashDir, target)) {
      continue;
    }
    await fs.promises.rm(target, { recursive: true, force: true });
  }
  for (const snapshot of snapshots) {
    if (isPathInside(paths.backupsDir, snapshot)) {
      await deleteSnapshot(paths, snapshot);
    }
  }
  // Only here, under the lock, so no apply is filling one of these meanwhile.
  for (const dir of staging) {
    if (isPathInside(paths.dshSkillsDir, dir)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  await appendJournalEntry(paths, {
    operationId,
    type: 'gc-completed',
    timestamp: new Date().toISOString(),
    details: { deleted: [...targets.deleted, ...snapshots, ...staging] }
  });

  return {
    dryRun: false,
    deleted: [...targets.deleted, ...snapshots, ...staging],
    skipped: targets.skipped,
    message: `Deleted ${counts}`
  };
}
