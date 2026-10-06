import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { releaseProfileLockOfStopped, withProfilePackageLock } from '../../src/io/profile-lock.js';

describe('withProfilePackageLock', () => {
  let dir: string;
  let packageJson: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-profile-lock-'));
    packageJson = path.join(dir, 'package.json');
    lockPath = `${packageJson}.lock`;
    fs.writeFileSync(packageJson, '{}\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('holds a DSH-compatible lock during the operation and removes it afterwards', async () => {
    let seen: { content: string; mode: number } | null = null;
    const result = await withProfilePackageLock(packageJson, async () => {
      seen = { content: fs.readFileSync(lockPath, 'utf8'), mode: fs.statSync(lockPath).mode & 0o777 };
      return 42;
    });
    expect(result).toBe(42);
    // Windows has no POSIX permission bits; a new file there reads back as 0o666.
    expect(seen).toEqual({ content: `${process.pid}\n`, mode: process.platform === 'win32' ? 0o666 : 0o600 });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not leave an empty lock behind when writing the pid fails', async () => {
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      return handle;
    });
    const operation = vi.fn(async () => 1);
    await expect(withProfilePackageLock(packageJson, operation)).rejects.toThrow('disk full');
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('removes its own lock when the operation throws', async () => {
    await expect(
      withProfilePackageLock(packageJson, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('waits for an existing lock and proceeds once it is released', async () => {
    fs.writeFileSync(lockPath, '999999\n', { mode: 0o600 });
    setTimeout(() => fs.rmSync(lockPath, { force: true }), 300);
    const started = Date.now();
    let ranAt = 0;
    await withProfilePackageLock(packageJson, async () => {
      ranAt = Date.now();
    });
    expect(ranAt - started).toBeGreaterThanOrEqual(250);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('times out without touching a lock held by someone else', async () => {
    fs.writeFileSync(lockPath, '999999\n', { mode: 0o600 });
    let ran = false;
    await expect(
      withProfilePackageLock(
        packageJson,
        async () => {
          ran = true;
        },
        { timeoutMs: 200 }
      )
    ).rejects.toThrow(
      `Timed out waiting for the profile lock at ${lockPath}; if no DSH process or dsh plugin command is writing this profile, delete the lock file and retry`
    );
    expect(ran).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('999999\n');
  });

  it('removes a lock left by a process dshenv stopped, and no other', async () => {
    // A process that has exited and been reaped stands for one dshenv stopped; a fixed pid could be running.
    const stopped = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(lockPath, `${stopped}\n`);
    await releaseProfileLockOfStopped(packageJson, [123, stopped]);
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.writeFileSync(lockPath, `${stopped}\n`);
    await releaseProfileLockOfStopped(packageJson, [123]);
    expect(fs.existsSync(lockPath)).toBe(true);

    // A holder that still runs is left alone even if dshenv signalled it.
    fs.writeFileSync(lockPath, `${process.pid}\n`);
    await releaseProfileLockOfStopped(packageJson, [process.pid]);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  // sh execs a sleep that never reaps the background child, as an init-less container's PID 1 would not.
  it.skipIf(process.platform !== 'linux')('removes a lock whose stopped holder is a zombie no one reaps', async () => {
    const parent = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const zombie = Number.parseInt(await new Promise<string>((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk)))), 10);
      await vi.waitFor(() => expect(fs.readFileSync(`/proc/${zombie}/stat`, 'utf8')).toMatch(/\) Z /), { timeout: 3000 });
      fs.writeFileSync(lockPath, `${zombie}\n`);
      await releaseProfileLockOfStopped(packageJson, [zombie]);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      parent.kill('SIGKILL');
    }
  });
});
