import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { gcEnvironment } from '../../src/gc/gc.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

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
});
