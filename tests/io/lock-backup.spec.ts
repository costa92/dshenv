import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireEnvironmentLock } from '../../src/io/lock.js';
import { createEnvironmentSnapshot, listEnvironmentSnapshots, restoreEnvironmentSnapshot } from '../../src/io/backup.js';
import { appendJournalEntry, readJournalEntries } from '../../src/io/journal.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('Lock, Backup and Journal IO', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-lock-test-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should acquire and release exclusive environment lock', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockHandle = await acquireEnvironmentLock(paths);
    expect(lockHandle).toBeDefined();

    // Trying to acquire second lock should fail
    await expect(acquireEnvironmentLock(paths, 50)).rejects.toThrow(/already held/i);

    // Release lock
    await lockHandle.release();

    // Now acquiring should succeed again
    const lockHandle2 = await acquireEnvironmentLock(paths);
    await lockHandle2.release();
  });

  it('should wait for a held lock to be released within the timeout', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const holder = await acquireEnvironmentLock(paths);
    setTimeout(() => void holder.release(), 150);

    const waiter = await acquireEnvironmentLock(paths, 2000);
    await waiter.release();
  });

  it('should give up once the timeout elapses', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const holder = await acquireEnvironmentLock(paths);
    const started = Date.now();

    await expect(acquireEnvironmentLock(paths, 300)).rejects.toThrow(/already held/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await holder.release();
  });

  it('should not steal a lock whose holder has not written its content yet', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, '');

    await expect(acquireEnvironmentLock(paths, 200)).rejects.toThrow(/already held/i);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('');
  });

  // Simulates EPERM from process.kill, which only POSIX returns for another user's process.
  it.skipIf(process.platform === 'win32')('should not treat a lock held by another user\'s live process as stale', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.mkdirSync(paths.managerDir, { recursive: true });
    // pid 1 is alive and, for an unprivileged test run, signalling it fails with EPERM rather than ESRCH.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, hostname: os.hostname() }));
    await expect(acquireEnvironmentLock(paths, 200)).rejects.toThrow(/already held/);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(1);
  });

  it('takes over a lock naming its own pid that this process does not hold, as a restarted container leaves', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: '2026-01-01T00:00:00.000Z' }));
    const handle = await acquireEnvironmentLock(paths, 200);
    expect(fs.readFileSync(lockFile, 'utf8')).not.toContain('2026-01-01');
    await handle.release();
  });

  it.skipIf(process.platform !== 'linux')('takes over a lock whose holder is a zombie no one reaps', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    const parent = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const zombie = Number.parseInt(await new Promise<string>((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk)))), 10);
      await vi.waitFor(() => expect(fs.readFileSync(`/proc/${zombie}/stat`, 'utf8')).toMatch(/\) Z /), { timeout: 3000 });
      fs.writeFileSync(lockFile, JSON.stringify({ pid: zombie, hostname: os.hostname() }));
      const handle = await acquireEnvironmentLock(paths, 200);
      await handle.release();
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it('names the holder of a lock it cannot take over, and how to clear it', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, hostname: 'old-name.local', createdAt: '2026-01-01T00:00:00.000Z' }));
    await expect(acquireEnvironmentLock(paths, 100)).rejects.toThrow(
      `Environment lock is already held at ${lockFile} by pid 999999 on host old-name.local since 2026-01-01T00:00:00.000Z; if no dshenv process holds it any more (its pid was reused, or the host name changed), delete that file`
    );
  });

  it('should not judge a lock replaced between reading its age and its content by the old one\'s age', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    // An old lock whose holder is alive, so it is not stale itself; this process's own pid would read as a former run's.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, hostname: os.hostname() }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
    // Its holder releases and another process creates a new lock it has not written yet.
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
      if (file === lockFile) {
        fs.rmSync(lockFile);
        fs.writeFileSync(lockFile, '');
      }
      return readFile(file, options as BufferEncoding);
    });
    try {
      await expect(acquireEnvironmentLock(paths, 200)).rejects.toThrow(/already held/i);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('should let only one of several concurrent waiters reclaim a stale lock', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    for (let round = 0; round < 200; round++) {
      // A pid that cannot belong to a live process marks the lock as stale.
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 31 - 1, hostname: os.hostname() }));
      const results = await Promise.allSettled(
        Array.from({ length: 32 }, () => acquireEnvironmentLock(paths, 0))
      );
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      fs.rmSync(lockFile, { force: true });
    }
  });

  it('should point at a reclaim marker left by a crashed reclaimer instead of removing it', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 31 - 1, hostname: os.hostname() }));
    const guard = `${lockFile}.reclaim`;
    fs.mkdirSync(guard);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(guard, past, past);

    await expect(acquireEnvironmentLock(paths, 0)).rejects.toThrow(/stale reclaim marker/);
    expect(fs.existsSync(guard)).toBe(true);
  });

  it('should reclaim an unreadable lock left behind long ago', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, '');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, past, past);

    const handle = await acquireEnvironmentLock(paths, 200);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
    await handle.release();
  });

  it('should create and restore snapshot', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\n');

    const snapshot = await createEnvironmentSnapshot(paths, 'test-op-1');
    expect(snapshot.snapshotDir).toContain('test-op-1');
    expect(fs.existsSync(path.join(snapshot.snapshotDir, 'manifest.yaml'))).toBe(true);

    // Modify original
    fs.writeFileSync(paths.manifestFile, 'modified\n');

    // Restore
    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe('apiVersion: dshenv/v1\n');
  });

  it('should not leave a partial snapshot behind when a copy fails', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\n');
    fs.writeFileSync(paths.lockFile, '{}\n');
    const realCopy = fs.promises.copyFile;
    const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dest, mode) => {
      if (String(src) === paths.lockFile) {
        throw new Error('disk full');
      }
      return realCopy(src, dest, mode);
    });
    try {
      await expect(createEnvironmentSnapshot(paths, 'test-op-2')).rejects.toThrow(/disk full/);
    } finally {
      spy.mockRestore();
    }

    expect(await listEnvironmentSnapshots(paths)).toEqual([]);
    expect(fs.readdirSync(paths.backupsDir)).toEqual([]);
  });

  it('should append and read journal entries', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await appendJournalEntry(paths, {
      operationId: 'op-123',
      type: 'apply-started',
      timestamp: new Date().toISOString(),
      details: { foo: 'bar' }
    });

    const entries = await readJournalEntries(paths);
    expect(entries).toHaveLength(1);
    expect(entries[0].operationId).toBe('op-123');
    expect(entries[0].type).toBe('apply-started');
  });
});
