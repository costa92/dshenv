import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { copySkillDir, readSkillDigests } from '../../src/resources/skill.js';

describe('copySkillDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-skill-copy-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A file the digest skips but the copy carried would never be updated, as its change never shows.
  it('leaves out what the digest skips, so the copy digests like its source', async () => {
    const source = path.join(root, 'from', 'review');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# review\n');
    fs.writeFileSync(path.join(source, '.tmp-data'), 'v1\n');
    await copySkillDir(source, path.join(root, 'to', 'review'));
    expect(fs.existsSync(path.join(root, 'to', 'review', '.tmp-data'))).toBe(false);
    expect(await readSkillDigests(path.join(root, 'to'))).toEqual(await readSkillDigests(path.join(root, 'from')));
  });
});
