import * as fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DshError } from '../errors.js';
import { processAlive } from './process-tree.js';

export interface ProfileLockOptions {
  timeoutMs?: number;
}

export const PROFILE_LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_INITIAL_MS = 25;
const LOCK_RETRY_MAX_MS = 1_000;

async function tryCreate(lockPath: string, content: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(lockPath, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    } catch (writeErr: unknown) {
      // This lock is ours; left behind it would block DSH until someone deletes it by hand.
      await fs.promises.rm(lockPath, { force: true });
      throw writeErr;
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

// Same protocol as DSH's atomic-write `<file>.lock`, so dshenv and DSH never write package.json at once.
// Neither DSH nor dshenv ever takes over an existing lock; a leftover one must be removed by hand.
export async function withProfilePackageLock<T>(
  packageJsonPath: string,
  operation: () => Promise<T>,
  options?: ProfileLockOptions
): Promise<T> {
  const lockPath = `${packageJsonPath}.lock`;
  const content = `${process.pid}\n`;
  const deadline = Date.now() + (options?.timeoutMs ?? PROFILE_LOCK_TIMEOUT_MS);
  let wait = LOCK_RETRY_INITIAL_MS;
  while (!(await tryCreate(lockPath, content))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DshError(
        `Timed out waiting for the profile lock at ${lockPath}; ` +
          'if no DSH process or dsh plugin command is writing this profile, delete the lock file and retry',
        1
      );
    }
    await delay(Math.min(wait, remaining));
    wait = Math.min(wait * 2, LOCK_RETRY_MAX_MS);
  }
  try {
    return await operation();
  } finally {
    await fs.promises.rm(lockPath, { force: true });
  }
}

// A DSH that dshenv had to kill leaves its lock behind, as nothing ends it gracefully mid-write. Removed only when a
// process dshenv stopped holds it and is gone, so a lock another DSH took meanwhile stays.
export async function releaseProfileLockOfStopped(packageJsonPath: string, stopped: number[]): Promise<void> {
  const lockPath = `${packageJsonPath}.lock`;
  let holder: number;
  try {
    holder = Number.parseInt(await fs.promises.readFile(lockPath, 'utf8'), 10);
  } catch {
    return;
  }
  if (!stopped.includes(holder)) {
    return;
  }
  if (!processAlive(holder)) {
    await fs.promises.rm(lockPath, { force: true });
  }
}
