import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireFileLock } from '../../src/io/lock.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A starved waiter hits its lock timeout and throws, which fails these tests on every platform. The tighter bound
// catches slow starvation too, but Windows file operations (and their busy retries) can stall a fair waiter past it.
const waitBound = (lockTimeoutMs: number) => (process.platform === 'win32' ? lockTimeoutMs : 1_000);

describe('acquireFileLock fairness', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-lock-fairness-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets a waiter in between a holder that releases and at once retakes the lock', async () => {
    const lockFile = path.join(dir, 'x.lock');
    let waiterDone = false;
    const greedy = (async () => {
      const until = Date.now() + 3_000;
      while (!waiterDone && Date.now() < until) {
        const handle = await acquireFileLock(lockFile, 'Test lock', 5_000);
        await sleep(20);
        await handle.release();
      }
    })();
    await sleep(50);

    const started = Date.now();
    try {
      const handle = await acquireFileLock(lockFile, 'Test lock', 1_500);
      await handle.release();
      expect(Date.now() - started).toBeLessThan(waitBound(1_500));
    } finally {
      waiterDone = true;
      await greedy;
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps every waiter within the timeout when several contend', async () => {
    const lockFile = path.join(dir, 'x.lock');
    let maxWait = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let round = 0; round < 40; round++) {
          const started = Date.now();
          const handle = await acquireFileLock(lockFile, 'Test lock', 2_000);
          maxWait = Math.max(maxWait, Date.now() - started);
          await sleep(5);
          await handle.release();
        }
      })
    );
    expect(maxWait).toBeLessThan(waitBound(2_000));
  }, 30_000);

  // Contenders in one process write the same pid, so a lock just created must not look like a former run's.
  it('never lets two holders in one process hold the lock at once', async () => {
    const lockFile = path.join(dir, 'x.lock');
    let holders = 0;
    let maxHolders = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let round = 0; round < 40; round++) {
          const handle = await acquireFileLock(lockFile, 'Test lock', 5_000);
          maxHolders = Math.max(maxHolders, ++holders);
          await sleep(1);
          holders--;
          await handle.release();
        }
      })
    );
    expect(maxHolders).toBe(1);
  }, 30_000);
});
