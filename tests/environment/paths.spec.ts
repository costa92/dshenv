import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

// The paths are written POSIX style; on Windows the same resolution yields a drive and backslashes.
const posix = (p: string) => p.replace(/^[A-Za-z]:/, '').split(path.sep).join('/');

describe('resolveEnvironmentPaths', () => {
  const userHome = '/Users/costalong';

  it('should resolve default path from user home', () => {
    const paths = resolveEnvironmentPaths({ userHome });
    expect(posix(paths.home)).toBe('/Users/costalong/.dsh');
    expect(posix(paths.profilesDir)).toBe('/Users/costalong/.dsh/profiles');
    expect(posix(paths.managerDir)).toBe('/Users/costalong/.dsh/envctl');
    expect(posix(paths.manifestFile)).toBe('/Users/costalong/.dsh/envctl/manifest.yaml');
    expect(posix(paths.lockFile)).toBe('/Users/costalong/.dsh/envctl/lock.json');
    expect(posix(paths.stateFile)).toBe('/Users/costalong/.dsh/envctl/state.json');
    expect(posix(paths.backupsDir)).toBe('/Users/costalong/.dsh/envctl/backups');
    expect(posix(paths.logsDir)).toBe('/Users/costalong/.dsh/envctl/logs');
    expect(posix(paths.trashDir)).toBe('/Users/costalong/.dsh/envctl/trash');
    expect(posix(paths.remoteFile)).toBe('/Users/costalong/.dsh/envctl/remote.json');
    expect(posix(paths.remoteDir)).toBe('/Users/costalong/.dsh/envctl/remote');
  });

  it('should prioritize cliDshHome over env and default', () => {
    const paths = resolveEnvironmentPaths({
      cliDshHome: '/custom/cli-dsh',
      envDshHome: '/custom/env-dsh',
      userHome
    });
    expect(posix(paths.home)).toBe('/custom/cli-dsh');
    expect(posix(paths.profilesDir)).toBe('/custom/cli-dsh/profiles');
    expect(posix(paths.managerDir)).toBe('/custom/cli-dsh/envctl');
  });

  it('should prioritize envDshHome over default when cli is not provided', () => {
    const paths = resolveEnvironmentPaths({
      envDshHome: '/custom/env-dsh',
      userHome
    });
    expect(posix(paths.home)).toBe('/custom/env-dsh');
    expect(posix(paths.profilesDir)).toBe('/custom/env-dsh/profiles');
  });

  it('should resolve relative dsh-home against cwd into an absolute path', () => {
    const paths = resolveEnvironmentPaths({
      cliDshHome: 'relative/path',
      cwd: '/work/dir',
      userHome
    });
    expect(posix(paths.home)).toBe('/work/dir/relative/path');
    expect(posix(paths.profilesDir)).toBe('/work/dir/relative/path/profiles');
  });

  it('should resolve relative DSH_HOME against cwd', () => {
    const paths = resolveEnvironmentPaths({
      envDshHome: './env-dsh',
      cwd: '/work/dir',
      userHome
    });
    expect(posix(paths.home)).toBe('/work/dir/env-dsh');
  });

  it('expands a leading ~ as DSH does, in DSH_HOME and in --dsh-home', () => {
    expect(posix(resolveEnvironmentPaths({ envDshHome: '~/.dsh-work', cwd: '/work/dir', userHome }).home)).toBe(`${posix(userHome)}/.dsh-work`);
    expect(posix(resolveEnvironmentPaths({ envDshHome: '~', cwd: '/work/dir', userHome }).home)).toBe(posix(userHome));
    expect(posix(resolveEnvironmentPaths({ cliDshHome: '~\\alt', cwd: '/work/dir', userHome }).home)).toBe(`${posix(userHome)}/alt`);
    // Only the user's own home: ~other is a plain relative name.
    expect(posix(resolveEnvironmentPaths({ envDshHome: '~other', cwd: '/work/dir', userHome }).home)).toBe('/work/dir/~other');
  });

  it('treats an empty or blank DSH_HOME as unset, as DSH does', () => {
    expect(posix(resolveEnvironmentPaths({ envDshHome: '', userHome }).home)).toBe(`${posix(userHome)}/.dsh`);
    expect(posix(resolveEnvironmentPaths({ envDshHome: '  ', userHome }).home)).toBe(`${posix(userHome)}/.dsh`);
  });

  it('should reject empty explicit path', () => {
    expect(() => {
      resolveEnvironmentPaths({
        cliDshHome: '   ',
        userHome
      });
    }).toThrow();
  });
});
