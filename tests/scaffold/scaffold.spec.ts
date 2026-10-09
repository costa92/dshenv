import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scaffoldComponent } from '../../src/scaffold/scaffold.js';

describe('scaffoldComponent', () => {
  let work: string;
  let dshHome: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-scaffold-'));
    dshHome = path.join(work, 'home');
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  const opts = (extra: Record<string, unknown>) => ({ dshHome, cwd: work, ...extra }) as Parameters<typeof scaffoldComponent>[0];

  it('writes a tool package into ./<name> by default', () => {
    const result = scaffoldComponent(opts({ kind: 'tool', name: 'echo-text' }));
    expect(result.dir).toBe(path.join(work, 'echo-text'));
    expect(result.packageName).toBe('echo-text');
    expect(result.files).toEqual(['README.md', 'cordis.patch.yml', 'index.js', 'package.json']);
    expect(fs.readFileSync(path.join(result.dir, 'index.js'), 'utf8')).toContain("name: 'echo_text'");
  });

  it('uses --dir relative to cwd, --package and the TypeScript variant', () => {
    const result = scaffoldComponent(opts({ kind: 'tool', name: 'echo', dir: 'pkgs/e', packageName: '@me/echo', typescript: true }));
    expect(result.dir).toBe(path.join(work, 'pkgs', 'e'));
    expect(result.files).toContain(path.join('src', 'index.ts'));
    expect(JSON.parse(fs.readFileSync(path.join(result.dir, 'package.json'), 'utf8')).name).toBe('@me/echo');
  });

  it('writes a loose skill into DSH_HOME/skills without a package', () => {
    const result = scaffoldComponent(opts({ kind: 'skill', name: 'review', loose: true }));
    expect(result.dir).toBe(path.join(dshHome, 'skills', 'review'));
    expect(result.packageName).toBeUndefined();
    expect(result.files).toEqual(['SKILL.md']);
    expect(fs.readFileSync(path.join(result.dir, 'SKILL.md'), 'utf8')).toContain("name: 'review'");
  });

  it.each([
    [{ kind: 'tool', name: 'Bad_Name' }, "Component name 'Bad_Name' must be kebab-case"],
    [{ kind: 'widget', name: 'x' }, "Unknown component kind 'widget'; expected skill, agent, tool or mcp"],
    [{ kind: 'tool', name: 'x', packageName: 'Bad Pkg' }, "Invalid package name 'Bad Pkg'"],
    [{ kind: 'skill', name: 'x', typescript: true }, '--typescript only applies to tool'],
    [{ kind: 'tool', name: 'x', loose: true }, '--loose only applies to skill'],
    [{ kind: 'skill', name: 'x', loose: true, dir: 'd' }, '--loose cannot be combined with --dir or --package']
  ])('rejects %j', (extra, message) => {
    expect(() => scaffoldComponent(opts(extra))).toThrow(message);
    expect(fs.readdirSync(work)).toEqual([]);
  });

  it('refuses a non-empty target and an existing loose skill', () => {
    fs.mkdirSync(path.join(work, 'taken'));
    fs.writeFileSync(path.join(work, 'taken', 'keep.txt'), 'x');
    expect(() => scaffoldComponent(opts({ kind: 'mcp', name: 'taken' }))).toThrow(`Target directory is not empty: ${path.join(work, 'taken')}`);
    expect(fs.readdirSync(path.join(work, 'taken'))).toEqual(['keep.txt']);

    fs.mkdirSync(path.join(dshHome, 'skills', 'review'), { recursive: true });
    expect(() => scaffoldComponent(opts({ kind: 'skill', name: 'review', loose: true }))).toThrow(
      `Skill directory already exists: ${path.join(dshHome, 'skills', 'review')}`
    );
  });

  it('fills an existing empty directory and cleanup() keeps that directory', () => {
    fs.mkdirSync(path.join(work, 'empty'));
    const result = scaffoldComponent(opts({ kind: 'skill', name: 'empty' }));
    expect(result.files).toContain(path.join('skills', 'empty', 'SKILL.md'));
    result.cleanup();
    expect(fs.readdirSync(path.join(work, 'empty'))).toEqual([]);
  });

  it('cleanup() removes a directory it created, including new parent directories', () => {
    const result = scaffoldComponent(opts({ kind: 'agent', name: 'helper', dir: 'a/b/helper' }));
    result.cleanup();
    expect(fs.existsSync(path.join(work, 'a'))).toBe(false);
  });

  it('cleanup() removes a newly created skills parent directory for --loose', () => {
    const result = scaffoldComponent(opts({ kind: 'skill', name: 'review', loose: true }));
    result.cleanup();
    expect(fs.existsSync(path.join(dshHome, 'skills'))).toBe(false);
  });

  it('rejects a dangling symlink as --dir without deleting it on cleanup failure', () => {
    const target = path.join(work, 'echo');
    fs.symlinkSync(path.join(work, 'nonexistent-target'), target);
    expect(() => scaffoldComponent(opts({ kind: 'tool', name: 'echo', dir: 'echo' }))).toThrow(
      `Target is a symbolic link; pass the real directory path: ${target}`
    );
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('rejects a symlink to a real directory without writing through it', () => {
    const real = path.join(work, 'real');
    fs.mkdirSync(real);
    const target = path.join(work, 'echo');
    fs.symlinkSync(real, target);
    expect(() => scaffoldComponent(opts({ kind: 'tool', name: 'echo', dir: 'echo' }))).toThrow(
      `Target is a symbolic link; pass the real directory path: ${target}`
    );
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it('rejects an existing file as --dir', () => {
    const target = path.join(work, 'echo');
    fs.writeFileSync(target, 'x');
    expect(() => scaffoldComponent(opts({ kind: 'tool', name: 'echo', dir: 'echo' }))).toThrow(`Target is not a directory: ${target}`);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it.each(['', '  '])('refuses an empty --dir %j instead of writing into cwd', (dir) => {
    expect(() => scaffoldComponent(opts({ kind: 'skill', name: 'abc', dir }))).toThrow('--dir must not be empty');
    expect(fs.readdirSync(work)).toEqual([]);
  });
});
