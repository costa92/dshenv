import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  inspectLocalSource,
  calculateSourceDigest
} from '../../src/source/local.js';
import { ValidationError } from '../../src/errors.js';

describe('Local Source Lifecycle and Digest', () => {
  let tempDir: string;
  let pkgDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-local-test-'));
    pkgDir = path.join(tempDir, 'my-local-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });

    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'my-local-pkg',
        version: '1.0.0',
        dsh: { bundle: 'dist/index.js' }
      })
    );
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'console.log("hello");');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should inspect valid local package source', async () => {
    const info = await inspectLocalSource(pkgDir);
    expect(info.isValid).toBe(true);
    expect(info.name).toBe('my-local-pkg');
    expect(info.version).toBe('1.0.0');
    expect(info.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(info.digest).toBe(await calculateSourceDigest(pkgDir));
  });

  it('should calculate stable digest ignoring node_modules and .git', async () => {
    const digest1 = await calculateSourceDigest(pkgDir);

    // Add node_modules file - should not alter source digest
    const nmDir = path.join(pkgDir, 'node_modules', 'foo');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'ignored');

    const digest2 = await calculateSourceDigest(pkgDir);
    expect(digest1).toBe(digest2);

    // Modify source file - should change digest
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'console.log("modified");');
    const digest3 = await calculateSourceDigest(pkgDir);
    expect(digest3).not.toBe(digest1);
  });

  it('separates a file path from its contents and separates successive files', async () => {
    const left = path.join(tempDir, 'left');
    const right = path.join(tempDir, 'right');
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    fs.writeFileSync(path.join(left, 'a'), 'bc');
    fs.writeFileSync(path.join(right, 'ab'), 'c');
    expect(await calculateSourceDigest(left)).not.toBe(await calculateSourceDigest(right));

    fs.rmSync(path.join(right, 'ab'));
    fs.writeFileSync(path.join(right, 'a'), 'b');
    fs.writeFileSync(path.join(right, 'c'), '');
    expect(await calculateSourceDigest(left)).not.toBe(await calculateSourceDigest(right));
  });

  it.skipIf(process.platform === 'win32')('separates symlink metadata and executable flags from file contents', async () => {
    const file = path.join(pkgDir, 'alias.js');
    fs.symlinkSync('index.js', file);
    const linkDigest = await calculateSourceDigest(pkgDir);
    fs.unlinkSync(file);
    fs.writeFileSync(file, '\0symlink\0index.js');
    expect(await calculateSourceDigest(pkgDir)).not.toBe(linkDigest);

    fs.writeFileSync(file, 'payload', { mode: 0o644 });
    fs.chmodSync(file, 0o755);
    const executable = await calculateSourceDigest(pkgDir, { executableBit: true });
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, 'payload\0executable');
    expect(await calculateSourceDigest(pkgDir, { executableBit: true })).not.toBe(executable);
  });

  describe('with a files list in package.json', () => {
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(pkgDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, rel), content);
    };
    const setFiles = (files: string[], extra: Record<string, unknown> = {}) =>
      write('package.json', JSON.stringify({ name: 'my-local-pkg', version: '1.0.0', files, ...extra }));

    it('digests only what npm would publish', async () => {
      setFiles(['lib', './skills/'], { main: 'entry.js' });
      write('lib/index.js', 'v1');
      write('skills/a/SKILL.md', 'skill');
      write('entry.js', 'main');
      write('README.md', 'readme');
      write('LICENSE', 'mit');
      write('docs/image.png', 'png1');
      write('src/index.ts', 'ts1');
      const digest = await calculateSourceDigest(pkgDir);

      write('docs/image.png', 'png2');
      write('src/index.ts', 'ts2');
      write('examples/new.md', 'new');
      expect(await calculateSourceDigest(pkgDir)).toBe(digest);

      for (const rel of ['lib/index.js', 'skills/a/SKILL.md', 'entry.js', 'README.md', 'LICENSE']) {
        const before = await calculateSourceDigest(pkgDir);
        write(rel, `${rel} changed`);
        expect(await calculateSourceDigest(pkgDir), rel).not.toBe(before);
      }
    });

    it('matches globs and leaves out negated entries', async () => {
      setFiles(['dist/**/*.js', '!dist/test']);
      write('dist/a/b.js', 'js');
      write('dist/a/b.js.map', 'map1');
      write('dist/test/t.js', 't1');
      const digest = await calculateSourceDigest(pkgDir);

      write('dist/a/b.js.map', 'map2');
      write('dist/test/t.js', 't2');
      expect(await calculateSourceDigest(pkgDir)).toBe(digest);

      write('dist/a/b.js', 'js2');
      expect(await calculateSourceDigest(pkgDir)).not.toBe(digest);
    });

    it('lets a leading **/ match at the package root too', async () => {
      setFiles(['**/*.yml']);
      write('cordis.patch.yml', 'a');
      write('docs/notes.md', 'n1');
      const digest = await calculateSourceDigest(pkgDir);
      write('docs/notes.md', 'n2');
      expect(await calculateSourceDigest(pkgDir)).toBe(digest);
      write('cordis.patch.yml', 'b');
      expect(await calculateSourceDigest(pkgDir)).not.toBe(digest);
    });

    it('still digests the whole tree when package.json has no files list', async () => {
      const digest = await calculateSourceDigest(pkgDir);
      write('docs/image.png', 'png');
      expect(await calculateSourceDigest(pkgDir)).not.toBe(digest);
    });
  });

  // Windows needs extra rights to create symlinks.
  it.skipIf(process.platform === 'win32')('counts a symlink by its target and keeps the digest of a tree without one', async () => {
    const plain = await calculateSourceDigest(pkgDir);
    fs.symlinkSync('index.js', path.join(pkgDir, 'alias.js'));
    const linked = await calculateSourceDigest(pkgDir);
    expect(linked).not.toBe(plain);
    fs.rmSync(path.join(pkgDir, 'alias.js'));
    fs.symlinkSync('package.json', path.join(pkgDir, 'alias.js'));
    expect(await calculateSourceDigest(pkgDir)).not.toBe(linked);
    fs.rmSync(path.join(pkgDir, 'alias.js'));
    expect(await calculateSourceDigest(pkgDir)).toBe(plain);
  });

  it('should reject non-absolute path', async () => {
    await expect(inspectLocalSource('relative/path')).rejects.toThrow(ValidationError);
  });
});
