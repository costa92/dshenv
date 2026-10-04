import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { withEnvironmentLock } from '../io/lock.js';
import { appendJournalEntry } from '../io/journal.js';
import { ValidationError } from '../errors.js';
import { listEnvironmentSnapshots, snapshotTime } from '../io/backup.js';

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
  for (const entry of await fs.promises.readdir(paths.backupsDir, { withFileTypes: true })) {
    const dir = path.join(paths.backupsDir, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('.') && entry.name.endsWith('.partial') && expired(dir, null)) {
      targets.push(dir);
    }
  }
  return targets;
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
  const counts = `${String(targets.deleted.length)} trash item(s)${snapshots.length > 0 ? ` and ${String(snapshots.length)} snapshot(s)` : ''}`;

  if (options?.dryRun) {
    return {
      dryRun: true,
      deleted: [...targets.deleted, ...snapshots],
      skipped: targets.skipped,
      message: `Would delete ${counts}`
    };
  }

  const operationId = `gc-${Date.now().toString(16)}`;
  await appendJournalEntry(paths, {
    operationId,
    type: 'gc-started',
    timestamp: new Date().toISOString(),
    details: { olderThanDays, count: targets.deleted.length + snapshots.length }
  });

  for (const target of targets.deleted) {
    if (!isPathInside(paths.trashDir, target)) {
      continue;
    }
    await fs.promises.rm(target, { recursive: true, force: true });
  }
  for (const snapshot of snapshots) {
    if (isPathInside(paths.backupsDir, snapshot)) {
      await fs.promises.rm(snapshot, { recursive: true, force: true });
    }
  }

  await appendJournalEntry(paths, {
    operationId,
    type: 'gc-completed',
    timestamp: new Date().toISOString(),
    details: { deleted: [...targets.deleted, ...snapshots] }
  });

  return {
    dryRun: false,
    deleted: [...targets.deleted, ...snapshots],
    skipped: targets.skipped,
    message: `Deleted ${counts}`
  };
}
