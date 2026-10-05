import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { adoptEnvironment } from '../../src/import/adopt.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { loadManifest, loadState } from '../../src/manifest/files.js';
import type { CaptureDocument } from '../../src/domain.js';

describe('adoptEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-adopt-test-'));
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams'), { recursive: true });

    fs.writeFileSync(
      path.join(webProfile, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@nanmicoder/dsh-agent-teams': '^0.1.21'
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

  it('should adopt valid candidate and record ownership in state.json', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': {
                package: '@nanmicoder/dsh-agent-teams',
                enabled: true,
                source: { type: 'npm', version: '0.1.21' }
              }
            }
          }
        }
      },
      lock: {
        apiVersion: 'dshenv-lock/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': {
                package: '@nanmicoder/dsh-agent-teams',
                source: { type: 'npm', resolvedVersion: '0.1.21' }
              }
            }
          }
        }
      },
      warnings: []
    };

    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '2026-01-01T00:00:00.000Z', appliedLockHash: '', profiles: {}, resources: { skill: { wiki: { digest: 'd1' } } } })
    );
    const summary = await adoptEnvironment(paths, candidate);
    expect(summary.adoptedCount).toBe(1);

    // Verify manifest, lock, state written
    expect(fs.existsSync(paths.manifestFile)).toBe(true);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(fs.existsSync(paths.stateFile)).toBe(true);

    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.resources?.plugin?.web?.['@nanmicoder/dsh-agent-teams']).toBeDefined();
    expect(state.resources?.plugin?.web?.['@nanmicoder/dsh-agent-teams'].package).toBe('@nanmicoder/dsh-agent-teams');
    expect(state.resources?.plugin?.web?.['@nanmicoder/dsh-agent-teams'].lockedVersion).toBe('0.1.21');
    expect(state.resources?.skill).toEqual({ wiki: { digest: 'd1' } });
  });

  it('puts the manifest and lock back when writing state.json fails', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(path.dirname(paths.manifestFile), { recursive: true });
    const manifestBefore = 'apiVersion: dshenv/v1\nprofiles: {}\n';
    fs.writeFileSync(paths.manifestFile, manifestBefore);
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': { package: '@nanmicoder/dsh-agent-teams', enabled: true, source: { type: 'npm', version: '0.1.21' } }
            }
          }
        }
      },
      lock: { apiVersion: 'dshenv-lock/v1', profiles: {} },
      warnings: []
    };
    const realRename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // By name: macOS (/private/var) and Windows (RUNNER~1) can spell the temp directory differently.
      if (path.basename(String(to)) === path.basename(paths.stateFile)) {
        throw new Error('disk full');
      }
      return realRename(from, to);
    });
    try {
      await expect(adoptEnvironment(paths, candidate)).rejects.toThrow(/disk full/);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(manifestBefore);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it('keeps the declared patches of a plugin the manifest already has', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(path.dirname(paths.manifestFile), { recursive: true });
    fs.writeFileSync(
      paths.manifestFile,
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source: { type: npm, version: "0.1.20" }
        patches:
          - id: teams
            config: { taskPlanning: captain }
`
    );
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': {
                package: '@nanmicoder/dsh-agent-teams',
                enabled: true,
                source: { type: 'npm', version: '0.1.21' }
              }
            }
          }
        }
      },
      lock: { apiVersion: 'dshenv-lock/v1', profiles: {} },
      warnings: []
    };

    await adoptEnvironment(paths, candidate);

    const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
    expect(manifest.profiles.web.plugins).toEqual({
      teams: {
        package: '@nanmicoder/dsh-agent-teams',
        enabled: true,
        source: { type: 'npm', version: '0.1.21' },
        patches: [{ id: 'teams', config: { taskPlanning: 'captain' } }]
      }
    });
  });

  it('should reject stale candidate when live inventory differs from candidate facts', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': {
                package: '@nanmicoder/dsh-agent-teams',
                enabled: true,
                source: { type: 'npm', version: '0.9.99' } // Mismatched version!
              }
            }
          }
        }
      },
      lock: {
        apiVersion: 'dshenv-lock/v1',
        profiles: {}
      },
      warnings: []
    };

    await expect(adoptEnvironment(paths, candidate)).rejects.toThrow(/stale|mismatch/i);
  });

  describe('rejects a candidate whose source no longer matches the live install', () => {
    const setLiveSpec = (spec: string): void => {
      const file = path.join(tempHome, 'profiles', 'web', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { dependencies: Record<string, string> };
      pkg.dependencies['@nanmicoder/dsh-agent-teams'] = spec;
      fs.writeFileSync(file, JSON.stringify(pkg));
    };
    const candidateWith = (source: CaptureDocument['manifest']['profiles'][string]['plugins'][string]['source'], lockCommit?: string): CaptureDocument => ({
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: { web: { plugins: { 'agent-teams': { package: '@nanmicoder/dsh-agent-teams', enabled: true, source } } } }
      },
      lock: {
        apiVersion: 'dshenv-lock/v1',
        profiles: lockCommit && source.type === 'git'
          ? { web: { plugins: { 'agent-teams': { package: '@nanmicoder/dsh-agent-teams', source: { type: 'git', url: source.url, commit: lockCommit } } } } }
          : {}
      },
      warnings: []
    });

    it('when the git commit moved since capture', async () => {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      setLiveSpec('git+https://github.com/x/y.git#bbbbbbb');
      const candidate = candidateWith({ type: 'git', url: 'git+https://github.com/x/y.git' }, 'aaaaaaa');
      await expect(adoptEnvironment(paths, candidate)).rejects.toThrow(/stale/);
      expect(fs.existsSync(paths.lockFile)).toBe(false);
    });

    it('when the source type changed since capture', async () => {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      setLiveSpec('link:/src/agent-teams');
      await expect(adoptEnvironment(paths, candidateWith({ type: 'npm', version: '0.1.21' }))).rejects.toThrow(/stale/);
    });

    it('when the local path changed since capture', async () => {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      setLiveSpec('link:/src/agent-teams-v2');
      await expect(adoptEnvironment(paths, candidateWith({ type: 'local-link', path: '/src/agent-teams' }))).rejects.toThrow(/stale/);
    });

    it('keeps the ref or commit the base declares for a git plugin it adopts again', async () => {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      setLiveSpec('git+https://github.com/x/y.git#aaaaaaa');
      for (const pin of [{ ref: 'main' }, { commit: 'aaaaaaa' }]) {
        fs.mkdirSync(paths.managerDir, { recursive: true });
        fs.writeFileSync(
          paths.manifestFile,
          `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams:\n        package: "@nanmicoder/dsh-agent-teams"\n        source: ${JSON.stringify({ type: 'git', url: 'git+https://github.com/x/y.git', ...pin })}\n`
        );
        await adoptEnvironment(paths, candidateWith({ type: 'git', url: 'git+https://github.com/x/y.git' }, 'aaaaaaa'));
        expect(loadManifest(fs.readFileSync(paths.manifestFile, 'utf8')).profiles.web.plugins['agent-teams'].source).toEqual({ type: 'git', url: 'git+https://github.com/x/y.git', ...pin });
        const again = await adoptEnvironment(paths, candidateWith({ type: 'git', url: 'git+https://github.com/x/y.git' }, 'aaaaaaa'), { dryRun: true });
        expect(again.details.every((detail) => detail.alreadyAdopted)).toBe(true);
      }
    });

    it('but adopts a git candidate that still matches', async () => {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      setLiveSpec('git+https://github.com/x/y.git#aaaaaaa');
      await adoptEnvironment(paths, candidateWith({ type: 'git', url: 'git+https://github.com/x/y.git' }, 'aaaaaaa'));
      expect(loadManifest(fs.readFileSync(paths.manifestFile, 'utf8')).profiles.web.plugins['agent-teams'].source.type).toBe('git');
    });
  });

  it('leaves the base entry alone for a plugin the active overlay overrides', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    const baseManifest = 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      teams:\n        package: "@nanmicoder/dsh-agent-teams"\n        source: { type: npm, version: "0.1.20" }\n';
    fs.writeFileSync(paths.manifestFile, baseManifest);
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: { apiVersion: 'dshenv/v1', profiles: { web: { plugins: { 'agent-teams': { package: '@nanmicoder/dsh-agent-teams', enabled: true, source: { type: 'npm', version: '0.1.21' } } } } } },
      lock: { apiVersion: 'dshenv-lock/v1', profiles: {} },
      warnings: []
    };
    const overlay = { apiVersion: 'dshenv-overlay/v1' as const, profiles: { web: { plugins: { teams: { source: { type: 'npm' as const, version: '0.1.21' } } } } } };

    const summary = await adoptEnvironment(paths, candidate, { overlay });
    expect(summary.details).toMatchObject([{ alias: 'teams', alreadyAdopted: true }]);
    expect(loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'))).toEqual(loadManifest(baseManifest));
  });

  it('adopts a package under a free alias when its captured alias names another declared package', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@acme', 'agent-teams'), { recursive: true });
    fs.writeFileSync(path.join(webProfile, 'node_modules', '@acme', 'agent-teams', 'package.json'), JSON.stringify({ name: '@acme/agent-teams', version: '2.0.0' }));
    const profilePackage = JSON.parse(fs.readFileSync(path.join(webProfile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    profilePackage.dependencies['@acme/agent-teams'] = '2.0.0';
    fs.writeFileSync(path.join(webProfile, 'package.json'), JSON.stringify(profilePackage));
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(
      paths.manifestFile,
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        source: { type: npm, version: "0.1.21" }
        patches:
          - id: agent-teams
            config: { important: true }
`
    );
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': { package: '@acme/agent-teams', enabled: true, source: { type: 'npm', version: '2.0.0' } }
            }
          }
        }
      },
      lock: { apiVersion: 'dshenv-lock/v1', profiles: {} },
      warnings: []
    };

    const summary = await adoptEnvironment(paths, candidate);

    const plugins = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8')).profiles.web.plugins;
    expect(plugins['agent-teams']).toEqual(expect.objectContaining({ package: '@nanmicoder/dsh-agent-teams', patches: [expect.objectContaining({ id: 'agent-teams' })] }));
    expect(plugins['agent-teams-1']).toEqual(expect.objectContaining({ package: '@acme/agent-teams' }));
    expect(summary.details).toEqual([expect.objectContaining({ alias: 'agent-teams-1', package: '@acme/agent-teams' })]);
    const ownership = loadState(fs.readFileSync(paths.stateFile, 'utf8')).resources?.plugin?.web ?? {};
    expect(Object.keys(ownership)).toEqual(['@acme/agent-teams']);
    expect(ownership['@acme/agent-teams'].alias).toBe('agent-teams-1');
  });
});
