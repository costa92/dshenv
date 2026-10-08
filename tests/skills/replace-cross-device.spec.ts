import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { replaceSkillDir } from '../../src/resources/skill.js';

// With DSHENV_HOME on another filesystem, trash and DSH's skills directory cannot be renamed into each other.
describe('replaceSkillDir across filesystems', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-skill-exdev-'));
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      const crosses = [from, to].map((p) => String(p).startsWith(path.join(dir, 'trash')));
      if (crosses[0] !== crosses[1]) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
      return rename(from, to);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('moves the old copy to trash by copying, and undo brings it back', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'skills', 'demo');
    const trash = path.join(dir, 'trash', 'op', 'demo');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'new\n');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'old\n');

    const undo = await replaceSkillDir(source, target, trash);
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(trash, 'SKILL.md'), 'utf8')).toBe('old\n');

    await undo();
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('old\n');
    expect(fs.existsSync(trash)).toBe(false);
  });
});
