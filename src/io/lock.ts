import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EnvironmentPaths } from '../environment/paths.js';
import { assertEnvctlNotMoved } from '../environment/moved.js';
import { DshError } from '../errors.js';
import { retryWhileBusy } from './windows-retry.js';
import { isZombie } from './process-tree.js';

export interface LockHandle {
  lockPath: string;
  release: () => Promise<void>;
}

const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 40;
const WANTED_FRESH_MS = 3 * LOCK_RETRY_MAX_MS;
const LOCK_WRITE_GRACE_MS = 5000;

// The content of each lock this process holds now, so a lock naming its own pid is told apart from a former run's;
// by content, not path, as contenders in one process take the same path in turn.
const heldLocks = new Set<string>();

async function createLockFile(lockFilePath: string, lockContent: string): Promise<boolean> {
  try {
    const handle = await retryWhileBusy(() => fs.promises.open(lockFilePath, 'wx', 0o600));
    // Held before the pid is written: a waiter in this process would otherwise take its own pid for a former run's.
    heldLocks.add(lockContent);
    try {
      await handle.writeFile(lockContent);
      await handle.close();
    } catch (err) {
      heldLocks.delete(lockContent);
      throw err;
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    return false;
  }
}

// The inode of the lock when it is stale, read through one handle so its age and content belong to the same file.
async function staleLockInode(lockFilePath: string): Promise<number | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockFilePath, 'r');
  } catch {
    // The lock vanished while being inspected; retry.
    return null;
  }
  try {
    const stat = await handle.stat();
    const raw = await handle.readFile('utf8');
    let info: { pid?: number; hostname?: string };
    try {
      info = JSON.parse(raw);
    } catch {
      // The holder creates the file before writing it; only an old unreadable lock is abandoned.
      return Date.now() - stat.mtimeMs > LOCK_WRITE_GRACE_MS ? stat.ino : null;
    }
    if (info?.pid && info.hostname === os.hostname()) {
      // Our own pid on a lock this process does not hold is a former run's (a restarted container reuses its pids).
      if (info.pid === process.pid) {
        return heldLocks.has(raw) ? null : stat.ino;
      }
      try {
        process.kill(info.pid, 0);
      } catch (err: unknown) {
        // EPERM means the process exists but belongs to another user; only ESRCH proves it is gone.
        return (err as NodeJS.ErrnoException).code === 'ESRCH' ? stat.ino : null;
      }
      return isZombie(info.pid) ? stat.ino : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// Deleting someone else's lock is serialized by an atomic mkdir guard, so two waiters can never both
// judge the same stale lock and then remove the lock the other one just created.
async function reclaimStaleLock(lockFilePath: string, guardPath: string): Promise<void> {
  try {
    await fs.promises.mkdir(guardPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // On Windows a guard another waiter has just removed stays "delete pending" (EPERM) until its handle closes:
    // someone else is reclaiming, exactly as with EEXIST.
    if (code === 'EEXIST' || (process.platform === 'win32' && code === 'EPERM')) {
      return;
    }
    throw err;
  }
  try {
    const stale = await staleLockInode(lockFilePath);
    // A lock released and created anew since it was judged is another file, and stays.
    if (stale !== null && (await fs.promises.stat(lockFilePath).catch(() => null))?.ino === stale) {
      await retryWhileBusy(() => fs.promises.rm(lockFilePath, { force: true }));
    }
  } finally {
    await retryWhileBusy(() => fs.promises.rmdir(guardPath));
  }
}

async function tryCreateLock(lockFilePath: string, guardPath: string, lockContent: string): Promise<boolean> {
  if (await createLockFile(lockFilePath, lockContent)) {
    return true;
  }
  await reclaimStaleLock(lockFilePath, guardPath);
  return createLockFile(lockFilePath, lockContent);
}

// Waiters touch the marker on every retry, so one that stopped waiting (or was killed) goes stale on its own.
async function othersWaiting(wantedPath: string): Promise<boolean> {
  try {
    return Date.now() - (await fs.promises.stat(wantedPath)).mtimeMs < WANTED_FRESH_MS;
  } catch {
    return false;
  }
}

async function markWaiting(wantedPath: string): Promise<void> {
  const now = new Date();
  await fs.promises.utimes(wantedPath, now, now).catch(() => fs.promises.writeFile(wantedPath, '', { mode: 0o600 }).catch(() => {}));
}

// Only a holder on this host that has exited is taken over, so the user is told who holds it and how to clear it.
async function holderHint(lockFilePath: string): Promise<string> {
  let info: { pid?: unknown; hostname?: unknown; createdAt?: unknown };
  try {
    info = JSON.parse(await fs.promises.readFile(lockFilePath, 'utf8'));
  } catch {
    return '';
  }
  if (typeof info?.pid !== 'number') {
    return '';
  }
  const host = typeof info.hostname === 'string' ? ` on host ${info.hostname}` : '';
  const since = typeof info.createdAt === 'string' ? ` since ${info.createdAt}` : '';
  return ` by pid ${info.pid}${host}${since}; if no dshenv process holds it any more (its pid was reused, or the host name changed), delete that file`;
}

async function staleGuardHint(guardPath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(guardPath);
    if (Date.now() - stat.mtimeMs > LOCK_WRITE_GRACE_MS) {
      return `; a stale reclaim marker remains at ${guardPath}, remove it once no dshenv process is running`;
    }
  } catch {
    // no guard
  }
  return '';
}

export async function acquireEnvironmentLock(
  paths: EnvironmentPaths,
  timeoutMs = 5000
): Promise<LockHandle> {
  await fs.promises.mkdir(paths.managerDir, { recursive: true });
  const handle = await acquireFileLock(path.join(paths.managerDir, 'dshenv.lock'), 'Environment lock', timeoutMs);
  // A command that waited for migrate resolved its paths before the move.
  try {
    assertEnvctlNotMoved(paths.managerDir);
  } catch (err) {
    await handle.release();
    throw err;
  }
  return handle;
}

// A lock held by a dshenv process through lockFilePath; one whose holder died is taken over.
export async function acquireFileLock(lockFilePath: string, label: string, timeoutMs: number): Promise<LockHandle> {
  const guardPath = `${lockFilePath}.reclaim`;

  const lockContent = JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    nonce: randomUUID()
  });

  const wantedPath = `${lockFilePath}.wanted`;
  const deadline = Date.now() + timeoutMs;
  // A holder that releases and at once retakes the lock would otherwise win every time: it defers its first try to
  // anyone who has been waiting, and waiters retry often, so they get the gaps between holders.
  for (let attempt = 0; ; attempt++) {
    const defer = attempt === 0 && (await othersWaiting(wantedPath));
    if (!defer && (await tryCreateLock(lockFilePath, guardPath, lockContent))) {
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DshError(`${label} is already held at ${lockFilePath}${await holderHint(lockFilePath)}${await staleGuardHint(guardPath)}`, 1);
    }
    await markWaiting(wantedPath);
    const ceiling = Math.min(LOCK_RETRY_MAX_MS, LOCK_RETRY_MIN_MS * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_RETRY_MIN_MS + Math.random() * ceiling, remaining)));
  }
  await fs.promises.rm(wantedPath, { force: true }).catch(() => {});

  return {
    lockPath: lockFilePath,
    release: async () => {
      try {
        await retryWhileBusy(() => fs.promises.unlink(lockFilePath));
      } catch {
        // ignore
      } finally {
        heldLocks.delete(lockContent);
      }
    }
  };
}

export async function withEnvironmentLock<T>(paths: EnvironmentPaths, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireEnvironmentLock(paths);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
