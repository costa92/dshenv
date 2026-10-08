import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { captureEnvironment, initEnvironment } from '../../src/import/capture.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';

describe('captureEnvironment and initEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capture-test-'));
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams'), { recursive: true });

    fs.writeFileSync(
      path.join(webProfile, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@nanmicoder/dsh-agent-teams': '0.1.21'
        },
        dsh: {
          profile: {
            bundles: ['@nanmicoder/dsh-agent-teams']
          }
        }
      })
    );

    fs.writeFileSync(
      path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'),
      JSON.stringify({
        name: '@nanmicoder/dsh-agent-teams',
        version: '0.1.21',
        _resolved: 'https://registry.npmjs.org/@nanmicoder/dsh-agent-teams/-/dsh-agent-teams-0.1.21.tgz'
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should capture environment accurately without creating state.json', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const inventory = await readEnvironmentInventory(paths);
    const doc = captureEnvironment(inventory);

    expect(doc.apiVersion).toBe('dshenv-capture/v1');
    expect(doc.manifest.apiVersion).toBe('dshenv/v1');
    expect(doc.lock.apiVersion).toBe('dshenv-lock/v1');
    expect(doc.manifest.profiles.web.plugins['agent-teams']).toBeDefined();
    expect(doc.manifest.profiles.web.plugins['agent-teams'].package).toBe('@nanmicoder/dsh-agent-teams');
    expect(doc.manifest.profiles.web.plugins['agent-teams'].source).toEqual({
      type: 'npm',
      version: '0.1.21'
    });

    // Ensure state.json was not created
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it('should initialize empty environment when files do not exist', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await initEnvironment(paths);

    expect(fs.existsSync(paths.manifestFile)).toBe(true);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(fs.existsSync(paths.stateFile)).toBe(true);

    // Re-running init should fail
    await expect(initEnvironment(paths)).rejects.toThrow();
  });

  it('should warn on unknown sources instead of inventing npm@0.0.0', () => {
    const doc = captureEnvironment({
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            mystery: {
              name: 'mystery',
              installed: true,
              sourceType: 'unknown',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    });
    expect(doc.manifest.profiles.web.plugins.mystery).toBeUndefined();
    expect(doc.lock.profiles.web.plugins.mystery).toBeUndefined();
    expect(doc.warnings.some((w) => w.includes('mystery'))).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('0.0.0');
  });

  it.each([
    ['a tarball URL that is not installed', 'https://example.com/pkg-1.0.0.tgz', false, undefined],
    ['an installed tarball URL', 'https://example.com/pkg-1.0.0.tgz', true, '1.0.0'],
    ['an npm: alias', 'npm:other-pkg@2.0.0', true, '2.0.0']
  ])('skips %s instead of recording a registry version', (_label, spec, installed, version) => {
    const doc = captureEnvironment({
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            odd: { name: 'odd', installed, ...(version ? { version } : {}), sourceType: 'npm', resolvedSource: spec, isSymlink: false, isExternalSymlink: false, enabled: true }
          }
        }
      }
    });
    expect(doc.manifest.profiles.web.plugins).toEqual({});
    expect(doc.lock.profiles.web.plugins).toEqual({});
    expect(doc.warnings.some((w) => w.includes('odd') && w.includes(spec))).toBe(true);
  });

  it('names an official DSH bundle by what it adds, without the experimental prefix and the -profile or -bundle suffix', () => {
    const plugin = (name: string) => ({ name, installed: true, sourceType: 'in-box' as const, isSymlink: false, isExternalSymlink: false, enabled: true });
    const doc = captureEnvironment({
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            '@deepseek-ai/dsh-experimental-agent-team-profile': plugin('@deepseek-ai/dsh-experimental-agent-team-profile'),
            '@deepseek-ai/dsh-experimental-voice-input-bundle': plugin('@deepseek-ai/dsh-experimental-voice-input-bundle'),
            '@deepseek-ai/dsh-experimental-auto-review': plugin('@deepseek-ai/dsh-experimental-auto-review')
          }
        }
      }
    });
    expect(Object.keys(doc.manifest.profiles.web.plugins).sort()).toEqual(['agent-team', 'auto-review', 'voice-input']);
  });

  it('keeps an installed range as the exact installed version', () => {
    const doc = captureEnvironment({
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            ranged: { name: 'ranged', installed: true, version: '1.2.3', sourceType: 'npm', resolvedSource: '^1.2.0', isSymlink: false, isExternalSymlink: false, enabled: true }
          }
        }
      }
    });
    expect(doc.manifest.profiles.web.plugins.ranged.source).toEqual({ type: 'npm', version: '1.2.3' });
  });

  it.each([
    ['a branch', 'git+https://github.com/x/y.git#main', { type: 'git', url: 'git+https://github.com/x/y.git', ref: 'main' }],
    ['a tag path', 'git+https://github.com/x/y.git#release/v1', { type: 'git', url: 'git+https://github.com/x/y.git', ref: 'release/v1' }],
    ['a commit', 'git+https://github.com/x/y.git#abcdef1', { type: 'git', url: 'git+https://github.com/x/y.git' }]
  ])('takes %s from the spec fragment out of the git URL', (_label, spec, source) => {
    const doc = captureEnvironment({
      profiles: {
        web: { name: 'web', path: '/dummy', plugins: { g: { name: 'g', installed: true, sourceType: 'git', resolvedSource: spec, isSymlink: false, isExternalSymlink: false, enabled: true } } }
      }
    });
    expect(doc.manifest.profiles.web.plugins.g.source).toEqual(source);
  });

  it('skips a git spec whose fragment is no ref git can take', () => {
    const spec = 'git+https://github.com/x/y.git#semver:^1.0.0';
    const doc = captureEnvironment({
      profiles: {
        web: { name: 'web', path: '/dummy', plugins: { g: { name: 'g', installed: true, sourceType: 'git', resolvedSource: spec, isSymlink: false, isExternalSymlink: false, enabled: true } } }
      }
    });
    expect(doc.manifest.profiles.web.plugins).toEqual({});
    expect(doc.warnings.some((w) => w.includes('g') && w.includes('semver:^1.0.0'))).toBe(true);
  });

  it('should lock a git commit from the spec and not invent HEAD', () => {
    const doc = captureEnvironment({
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'git-plug': {
              name: 'git-plug',
              installed: true,
              version: '0.0.0',
              sourceType: 'git',
              resolvedSource: 'github:example/git-plug#abcdef1234567',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            },
            'git-float': {
              name: 'git-float',
              installed: true,
              version: '1.2.3',
              sourceType: 'git',
              resolvedSource: 'github:example/git-float',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    });
    const locked = doc.lock.profiles.web.plugins['git-plug'].source;
    expect(locked).toEqual({
      type: 'git',
      url: 'github:example/git-plug',
      commit: 'abcdef1234567'
    });
    expect(doc.lock.profiles.web.plugins['git-float']).toBeUndefined();
    expect(doc.manifest.profiles.web.plugins['git-float']?.source).toEqual({
      type: 'git',
      url: 'github:example/git-float'
    });
    expect(doc.warnings.some((w) => w.includes('git-float'))).toBe(true);
    expect(JSON.stringify(doc.lock)).not.toContain('HEAD');
  });

  it('should capture only the requested profile', async () => {
    const tuiDir = path.join(tempHome, 'profiles', 'tui');
    fs.mkdirSync(tuiDir, { recursive: true });
    fs.writeFileSync(
      path.join(tuiDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-tui',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
      })
    );
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const inventory = await readEnvironmentInventory(paths);
    const doc = captureEnvironment(inventory, { profile: 'web' });
    expect(Object.keys(doc.manifest.profiles)).toEqual(['web']);
    expect(doc.manifest.profiles.tui).toBeUndefined();
  });
});
