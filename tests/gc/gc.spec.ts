import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { gcEnvironment } from '../../src/gc/gc.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { createEnvironmentSnapshot, listEnvironmentSnapshots } from '../../src/io/backup.js';

describe('gcEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-gc-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should delete expired trash entries and keep recent ones', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.trashDir, { recursive: true });
    const oldDir = path.join(paths.trashDir, 'old-item');
    const newDir = path.join(paths.trashDir, 'new-item');
    fs.mkdirSync(oldDir);
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(oldDir, 'note.txt'), 'old');
    fs.writeFileSync(path.join(newDir, 'note.txt'), 'new');
    const nineDaysAgo = Date.now() - 9 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldDir, nineDaysAgo / 1000, nineDaysAgo / 1000);

    const result = await gcEnvironment(paths, { olderThanDays: 7 });
    expect(result.deleted.some((item) => item.endsWith('old-item'))).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('should not delete trash on dry-run', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.trashDir, { recursive: true });
    const oldDir = path.join(paths.trashDir, 'old-item');
    fs.mkdirSync(oldDir);
    const nineDaysAgo = Date.now() - 9 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldDir, nineDaysAgo / 1000, nineDaysAgo / 1000);

    const result = await gcEnvironment(paths, { olderThanDays: 7, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(true);
  });

  it('deletes expired snapshots and stale staging copies but keeps the newest ten', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const snapshot = (daysAgo: number, index: number) => {
      const time = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000 + index * 1000).toISOString().replace(/[:.]/g, '-');
      const dir = path.join(paths.backupsDir, `${time}-apply-${String(index).padStart(4, '0')}`);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const old = Array.from({ length: 12 }, (_, index) => snapshot(30, index));
    const recent = snapshot(1, 0);
    const staging = path.join(paths.backupsDir, '.2026-01-01T00-00-00-000Z-apply-x.partial');
    fs.mkdirSync(staging);
    const nineDaysAgo = (Date.now() - 9 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staging, nineDaysAgo, nineDaysAgo);

    const preview = await gcEnvironment(paths, { olderThanDays: 7, dryRun: true });
    expect(preview.message).toBe('Would delete 0 trash item(s) and 4 snapshot(s)');
    expect(fs.readdirSync(paths.backupsDir)).toHaveLength(14);

    const result = await gcEnvironment(paths, { olderThanDays: 7 });
    expect(result.deleted.sort()).toEqual([...old.slice(0, 3), staging].sort());
    expect(fs.existsSync(recent)).toBe(true);
    expect(old.slice(3).every((dir) => fs.existsSync(dir))).toBe(true);
  });

  it('keeps the snapshot taken last although the clock went back before it was taken', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\n');
    vi.useFakeTimers({ toFake: ['Date'] });
    let last: string;
    try {
      vi.setSystemTime(Date.now() - 30 * 24 * 60 * 60 * 1000);
      for (let index = 0; index < 10; index++) {
        await createEnvironmentSnapshot(paths, `apply-${index}`);
      }
      vi.setSystemTime(Date.now() - 60 * 24 * 60 * 60 * 1000);
      last = (await createEnvironmentSnapshot(paths, 'apply-last')).snapshotDir;
    } finally {
      vi.useRealTimers();
    }

    const result = await gcEnvironment(paths, { olderThanDays: 7 });
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toContain('apply-0');
    expect(fs.existsSync(last)).toBe(true);
  });

  it('takes a snapshot out of the list before deleting it, so a gc killed halfway leaves none half-deleted', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const dirs = Array.from({ length: 11 }, (_, index) => {
      const dir = path.join(paths.backupsDir, `2020-01-01T00-00-${String(index).padStart(2, '0')}-000Z-apply-${index}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'apiVersion: dshenv/v1\n');
      return dir;
    });
    const rm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (String(target).startsWith(paths.backupsDir)) {
        await rm(path.join(String(target), 'manifest.yaml'), { force: true });
        throw new Error('killed');
      }
      return rm(target, options);
    });
    try {
      await expect(gcEnvironment(paths, { olderThanDays: 7 })).rejects.toThrow(/killed/);
    } finally {
      spy.mockRestore();
    }
    expect((await listEnvironmentSnapshots(paths)).map((snapshot) => snapshot.snapshotDir)).not.toContain(dirs[0]);

    await gcEnvironment(paths, { olderThanDays: 7 });
    expect(fs.readdirSync(paths.backupsDir).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('deletes skill staging copies a killed apply left in the DSH skills directory once they are old', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const stale = path.join(paths.dshSkillsDir, '.tmp-alpha-1234');
    const fresh = path.join(paths.dshSkillsDir, '.tmp-beta-5678');
    const skill = path.join(paths.dshSkillsDir, 'gamma');
    for (const dir of [stale, fresh, skill]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const nineDaysAgo = (Date.now() - 9 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, nineDaysAgo, nineDaysAgo);
    fs.utimesSync(skill, nineDaysAgo, nineDaysAgo);

    const preview = await gcEnvironment(paths, { olderThanDays: 7, dryRun: true });
    expect(preview.deleted).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(true);

    const result = await gcEnvironment(paths, { olderThanDays: 7 });
    expect(result.deleted).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(skill)).toBe(true);
  });
});
