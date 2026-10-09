import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { ValidationError } from '../../src/errors.js';
import {
  compareRemoteKeys,
  isRemoteFileKey,
  isValidBranchName,
  isValidRemotePath,
  parseRemoteConfig,
  readRemoteConfig,
  remoteFilePath,
  remoteOverlayKeys,
  remoteRepoDir,
  sha256Hex,
  writeRemoteConfig,
  type RemoteConfig
} from '../../src/remote/schema.js';

const valid = (): RemoteConfig => ({
  apiVersion: 'dshenv-remote/v1',
  url: 'git@github.com:team/dsh-config.git',
  branch: 'main',
  path: 'envctl',
  commit: 'a'.repeat(40),
  files: {
    'overlays/team-gpu.yaml': sha256Hex('overlay'),
    'manifest.yaml': sha256Hex('manifest')
  },
  lockEntries: {
    web: { zeta: sha256Hex('zeta'), alpha: sha256Hex('alpha') },
    cli: { tool: sha256Hex('tool') }
  }
});

const parse = (value: unknown) => parseRemoteConfig(JSON.stringify(value), '/x/remote.json');

describe('remote.json schema', () => {
  let home: string;
  let paths: EnvironmentPaths;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-schema-'));
    paths = resolveEnvironmentPaths({ cliDshHome: home });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('round-trips a valid file with a stable key order', async () => {
    expect(readRemoteConfig(paths)).toBeNull();
    await writeRemoteConfig(paths, valid());
    const raw = JSON.parse(fs.readFileSync(paths.remoteFile, 'utf8'));
    expect(Object.keys(raw)).toEqual(['apiVersion', 'url', 'branch', 'path', 'commit', 'files', 'lockEntries']);
    expect(Object.keys(raw.files)).toEqual(['manifest.yaml', 'overlays/team-gpu.yaml']);
    expect(Object.keys(raw.lockEntries)).toEqual(['cli', 'web']);
    expect(Object.keys(raw.lockEntries.web)).toEqual(['alpha', 'zeta']);
    expect(readRemoteConfig(paths)).toEqual(valid());
  });

  it.each([
    ['a short commit', { commit: 'abc123' }, /commit: Commit must be a 40-character lowercase hex SHA-1/],
    ['an uppercase commit', { commit: 'A'.repeat(40) }, /commit: Commit must be a 40-character lowercase hex SHA-1/],
    ['a credential URL', { url: 'https://user:token@example.com/team.git' }, /url: Git URL must not embed credentials/],
    ['an option-like URL', { url: '--upload-pack=evil' }, /url: Git URL must not start with -/],
    ['a path with ..', { path: '../envctl' }, /path: Path must be '\.' or a relative directory/],
    ['an option-like branch', { branch: '-main' }, /branch: Invalid branch name/],
    ['an unknown file key', { files: { 'manifest.yaml': sha256Hex('m'), 'state.json': sha256Hex('s') } }, /files\.state\.json: File must be manifest\.yaml or overlays\/<name>\.yaml/],
    ['lock.json as a file key', { files: { 'manifest.yaml': sha256Hex('m'), 'lock.json': sha256Hex('l') } }, /files\.lock\.json: File must be manifest\.yaml or overlays/],
    ['a nested overlay key', { files: { 'manifest.yaml': sha256Hex('m'), 'overlays/a/b.yaml': sha256Hex('o') } }, /File must be manifest\.yaml or overlays/],
    ['a bad digest', { files: { 'manifest.yaml': 'xyz' } }, /Digest must be a 64-character lowercase hex SHA-256/],
    ['no manifest', { files: { 'overlays/a.yaml': sha256Hex('o') } }, /files: files must include manifest\.yaml/],
    ['a bad lock entry digest', { lockEntries: { web: { shared: 'xyz' } } }, /lockEntries\.web\.shared: Digest must be a 64-character lowercase hex SHA-256/],
    ['an empty alias', { lockEntries: { web: { '': sha256Hex('e') } } }, /lockEntries/],
    ['no lockEntries', { lockEntries: undefined }, /lockEntries/],
    ['an extra field', { extra: true }, /Invalid remote file \/x\/remote\.json: /]
  ])('rejects %s', (_label, patch, message) => {
    expect(() => parse({ ...valid(), ...patch })).toThrow(message);
  });

  it('raises ValidationError for invalid JSON and names the file', () => {
    expect(() => parseRemoteConfig('{', '/x/remote.json')).toThrow(ValidationError);
    expect(() => parseRemoteConfig('{', '/x/remote.json')).toThrow(/Invalid JSON in remote file \/x\/remote\.json/);
  });

  it('validates remote paths, branch names and file keys', () => {
    for (const ok of ['envctl', '.', 'config/envctl', 'a.b_c-d']) {
      expect(isValidRemotePath(ok)).toBe(true);
    }
    for (const bad of ['', '/envctl', '../envctl', 'a/../b', 'a/', './a', 'a//b', 'a\\b']) {
      expect(isValidRemotePath(bad)).toBe(false);
    }
    expect(isValidBranchName('release/1.x')).toBe(true);
    expect(isValidBranchName('-x')).toBe(false);
    expect(isValidBranchName('bad branch')).toBe(false);
    for (const bad of ['', 'a..b', 'main/', 'x.lock', 'a@{1}']) {
      expect(isValidBranchName(bad)).toBe(false);
    }
    expect(isRemoteFileKey('overlays/team.yaml')).toBe(true);
    expect(isRemoteFileKey('lock.json')).toBe(false);
    expect(isRemoteFileKey('overlays/..yaml')).toBe(false);
    expect(isRemoteFileKey('overlays.yaml')).toBe(false);
    expect(isRemoteFileKey('skills/wiki/SKILL.md')).toBe(true);
    expect(isRemoteFileKey('skills/wiki/refs/a.md')).toBe(true);
    expect(isRemoteFileKey('skills/wiki')).toBe(false);
    expect(isRemoteFileKey('skills/../x/SKILL.md')).toBe(false);
    expect(isRemoteFileKey('skills/wiki/../SKILL.md')).toBe(false);
    expect(isRemoteFileKey('skills/.hidden/SKILL.md')).toBe(false);
  });

  it('maps file keys to envctl paths and orders them', () => {
    expect(paths.remoteFile).toBe(path.join(home, 'envctl', 'remote.json'));
    expect(paths.remoteDir).toBe(path.join(home, 'envctl', 'remote'));
    expect(remoteRepoDir(paths)).toBe(path.join(home, 'envctl', 'remote', 'repo.git'));
    expect(remoteFilePath(paths, 'manifest.yaml')).toBe(paths.manifestFile);
    expect(remoteFilePath(paths, 'overlays/team.yaml')).toBe(path.join(paths.overlaysDir, 'team.yaml'));
    expect(remoteFilePath(paths, 'skills/wiki/refs/a.md')).toBe(path.join(paths.skillsDir, 'wiki', 'refs', 'a.md'));
    expect(() => remoteFilePath(paths, 'state.json')).toThrow('Invalid remote file key: state.json');
    // lock.json is owned per entry, never as a whole file.
    expect(() => remoteFilePath(paths, 'lock.json')).toThrow('Invalid remote file key: lock.json');
    expect(['overlays/b.yaml', 'overlays/a.yaml', 'manifest.yaml'].sort(compareRemoteKeys))
      .toEqual(['manifest.yaml', 'overlays/a.yaml', 'overlays/b.yaml']);
    expect(remoteOverlayKeys(valid())).toEqual(['overlays/team-gpu.yaml']);
    expect(remoteOverlayKeys(null)).toEqual([]);
  });
});
