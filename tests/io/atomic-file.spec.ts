import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeAtomic } from '../../src/io/atomic-file.js';

describe('writeAtomic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write file atomically in create mode', async () => {
    const targetFile = path.join(tempDir, 'sub', 'test.txt');
    await writeAtomic(targetFile, 'hello world', 'create');

    expect(fs.readFileSync(targetFile, 'utf8')).toBe('hello world');
    const stat = fs.statSync(targetFile);
    // mode includes permissions
    expect(stat.isFile()).toBe(true);
  });

  it('should not overwrite a file created concurrently when hardlinks are unsupported', async () => {
    const targetFile = path.join(tempDir, 'race.txt');
    const spy = vi.spyOn(fs.promises, 'link').mockImplementation(async () => {
      // Another process creates the target just as the filesystem refuses the hardlink.
      fs.writeFileSync(targetFile, 'theirs');
      throw Object.assign(new Error('hardlinks unsupported'), { code: 'EPERM' });
    });
    const access = vi.spyOn(fs.promises, 'access').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    try {
      await expect(writeAtomic(targetFile, 'ours', 'create')).rejects.toThrow();
    } finally {
      spy.mockRestore();
      access.mockRestore();
    }
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('theirs');
    expect(fs.readdirSync(tempDir)).toEqual(['race.txt']);
  });

  it('should not leave a partial target when the fallback copy fails', async () => {
    const targetFile = path.join(tempDir, 'partial.txt');
    const link = vi.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('hardlinks unsupported'), { code: 'EPERM' }));
    const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (_src, dest) => {
      fs.writeFileSync(String(dest), 'half');
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });
    try {
      await expect(writeAtomic(targetFile, 'whole', 'create')).rejects.toThrow(/no space/);
    } finally {
      link.mockRestore();
      copy.mockRestore();
    }
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('should refuse to overwrite existing file in create mode and preserve original bytes', async () => {
    const targetFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(targetFile, 'original content', 'utf8');

    await expect(writeAtomic(targetFile, 'new content', 'create')).rejects.toThrow();

    // Verify original content is intact
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('original content');

    // Verify no stray temp files left behind
    const files = fs.readdirSync(tempDir);
    expect(files).toEqual(['test.txt']);
  });

  it('should overwrite existing file in overwrite mode', async () => {
    const targetFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(targetFile, 'original content', 'utf8');

    await writeAtomic(targetFile, 'new content', 'overwrite');

    expect(fs.readFileSync(targetFile, 'utf8')).toBe('new content');
  });

  it('writes through a symlink to its target, keeping the link', async () => {
    const realFile = path.join(tempDir, 'dotfiles', 'package.json');
    fs.mkdirSync(path.dirname(realFile));
    fs.writeFileSync(realFile, 'old');
    const link = path.join(tempDir, 'package.json');
    fs.symlinkSync(realFile, link);

    await writeAtomic(link, 'new', 'overwrite');

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(realFile, 'utf8')).toBe('new');
  });

  // Windows has no POSIX permission bits to keep or restrict.
  it.skipIf(process.platform === 'win32')('keeps the permissions of the file it overwrites', async () => {
    const targetFile = path.join(tempDir, 'shared.yml');
    fs.writeFileSync(targetFile, 'old');
    fs.chmodSync(targetFile, 0o644);

    await writeAtomic(targetFile, 'new', 'overwrite');

    expect(fs.statSync(targetFile).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('still creates new files private to the owner', async () => {
    const targetFile = path.join(tempDir, 'fresh.json');
    await writeAtomic(targetFile, '{}', 'overwrite');
    expect(fs.statSync(targetFile).mode & 0o777).toBe(0o600);
  });

  // Windows needs extra rights to create symlinks.
  it.skipIf(process.platform === 'win32')('refuses to replace a dangling symlink with a plain file', async () => {
    const link = path.join(tempDir, 'state.json');
    fs.symlinkSync(path.join(tempDir, 'dotfiles', 'state.json'), link);
    await expect(writeAtomic(link, 'new')).rejects.toThrow(/symlink to .*dotfiles.*state\.json, which does not exist/);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(tempDir)).toEqual(['state.json']);
  });

  it.skipIf(process.platform === 'win32')('keeps the owner of a file it replaces when running as root', async () => {
    const target = path.join(tempDir, 'state.json');
    fs.writeFileSync(target, 'old');
    const { uid, gid } = fs.statSync(target);
    const chown = vi.spyOn(fs.promises, 'chown');
    try {
      await writeAtomic(target, 'as user');
      expect(chown).not.toHaveBeenCalled();
      // Pretend to be root: the file's owner is then another user.
      const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
      try {
        await writeAtomic(target, 'as root');
      } finally {
        getuid.mockRestore();
      }
      expect(chown).toHaveBeenCalledWith(expect.stringContaining('.tmp-state.json-'), uid, gid);
      expect(fs.readFileSync(target, 'utf8')).toBe('as root');
    } finally {
      chown.mockRestore();
    }
  });
});
