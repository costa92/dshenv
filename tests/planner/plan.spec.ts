import { describe, it, expect } from 'vitest';
import { buildPlan, buildStatus } from '../../src/planner/plan.js';
import type { EnvironmentManifest, EnvironmentLock, EnvironmentState } from '../../src/domain.js';
import type { EnvironmentInventory } from '../../src/inventory/profile-reader.js';

describe('buildPlan', () => {
  it('should plan install for expected plugins that are not installed', () => {
    const manifest: EnvironmentManifest = {
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
    };
    const lock: EnvironmentLock = {
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
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy/path',
          plugins: {}
        }
      }
    };

    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.hasChanges).toBe(true);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].kind).toBe('install');
    expect(plan.operations[0]).toMatchObject({ package: '@nanmicoder/dsh-agent-teams' });
  });

  it('should classify unmanaged plugins without generating remove operation', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {}
        }
      }
    };
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: {}
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'unmanaged-pkg': {
              name: 'unmanaged-pkg',
              installed: true,
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.operations.some((op) => op.kind === ('remove' as any))).toBe(false);
    expect(plan.unmanaged).toHaveLength(1);
    expect(plan.unmanaged[0]).toEqual({
      profile: 'web',
      package: 'unmanaged-pkg'
    });
  });

  it("does not count the bundles DSH gives every profile as unmanaged, but still counts a user's undeclared in-box bundle", () => {
    const inBox = (name: string) => ({ name, installed: true, sourceType: 'in-box' as const, isSymlink: false, isExternalSymlink: false, bundle: true, enabled: true });
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            '@deepseek-ai/dsh-base': inBox('@deepseek-ai/dsh-base'),
            '@deepseek-ai/dsh-web-app': inBox('@deepseek-ai/dsh-web-app'),
            '@deepseek-ai/dsh-memory': inBox('@deepseek-ai/dsh-memory')
          }
        },
        headless: {
          name: 'headless',
          path: '/dummy',
          plugins: { '@deepseek-ai/dsh-base': inBox('@deepseek-ai/dsh-base'), '@deepseek-ai/dsh-headless': inBox('@deepseek-ai/dsh-headless') }
        }
      }
    };
    const manifest: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: { web: { plugins: {} }, headless: { plugins: {} } } };
    const plan = buildPlan(manifest, null, inventory);
    expect(plan.unmanaged).toEqual([{ profile: 'web', package: '@deepseek-ai/dsh-memory' }]);
    expect(buildStatus(manifest, null, inventory, plan).plugins).toContainEqual({ profile: 'web', package: '@deepseek-ai/dsh-web-app', status: 'healthy' });
  });

  it('should plan remove only for owned plugins missing from the manifest', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: { web: { plugins: {} } }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'owned-pkg': {
              name: 'owned-pkg',
              installed: true,
              version: '1.0.0',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            },
            'stray-pkg': {
              name: 'stray-pkg',
              installed: true,
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };
    const state: EnvironmentState = {
      apiVersion: 'dshenv-state/v1',
      lastApplied: '2026-01-01T00:00:00.000Z',
      appliedLockHash: '',
      profiles: {},
      resources: {
        plugin: {
          web: {
            'owned-pkg': {
              package: 'owned-pkg',
              alias: 'owned',
              sourceType: 'npm',
              lockedVersion: '1.0.0',
              adoptedAt: '2026-01-01T00:00:00.000Z',
              adoptedBy: 'test'
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, null, inventory, state);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'remove',
        profile: 'web',
        package: 'owned-pkg',
        alias: 'owned'
      })
    ]);
    expect(plan.unmanaged).toEqual([{ profile: 'web', package: 'stray-pkg' }]);
  });

  it('should plan update when installed version differs from target version', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: { type: 'npm', version: '0.1.22' }
            }
          }
        }
      }
    };
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              source: { type: 'npm', resolvedVersion: '0.1.22' }
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            '@nanmicoder/dsh-agent-teams': {
              name: '@nanmicoder/dsh-agent-teams',
              installed: true,
              version: '0.1.21',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.hasChanges).toBe(true);
    expect(plan.operations[0].kind).toBe('update');
    expect(plan.operations[0]).toMatchObject({ currentVersion: '0.1.21', targetVersion: '0.1.22' });
  });

  it('should plan enable and disable from selection mismatch', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            on: {
              package: 'pkg-on',
              enabled: true,
              source: { type: 'npm', version: '1.0.0' }
            },
            off: {
              package: 'pkg-off',
              enabled: false,
              source: { type: 'npm', version: '1.0.0' }
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'pkg-on': {
              name: 'pkg-on',
              installed: true,
              version: '1.0.0',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: false
            },
            'pkg-off': {
              name: 'pkg-off',
              installed: true,
              version: '1.0.0',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, null, inventory);
    expect(plan.operations.map((op) => op.kind).sort()).toEqual(['disable', 'enable']);
  });

  it('should plan configure when managed patch digest is missing', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: { type: 'npm', version: '0.1.21' },
              patches: [{ id: 'agent-teams', config: { taskPlanning: 'captain' } }]
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            '@nanmicoder/dsh-agent-teams': {
              name: '@nanmicoder/dsh-agent-teams',
              installed: true,
              version: '0.1.21',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, null, inventory);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].kind).toBe('configure');
  });

  it('should plan every operation a plugin needs so one apply can converge', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            fresh: {
              package: 'pkg-fresh',
              enabled: false,
              source: { type: 'npm', version: '1.0.0' },
              patches: [{ id: 'fresh', config: { a: 1 } }]
            },
            stale: {
              package: 'pkg-stale',
              enabled: false,
              source: { type: 'npm', version: '2.0.0' },
              patches: [{ id: 'stale', config: { b: 2 } }]
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'pkg-stale': {
              name: 'pkg-stale',
              installed: true,
              version: '1.0.0',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, null, inventory);
    // Neither is configured: a disabled plugin's patches stay declared but out of DSH, which does not load it.
    expect(plan.operations.filter((op) => op.resource === 'plugin').map((op) => [op.package, op.kind])).toEqual([
      ['pkg-fresh', 'install'],
      ['pkg-fresh', 'disable'],
      ['pkg-stale', 'update'],
      ['pkg-stale', 'disable']
    ]);
  });

  it('should block git plugins whose lock has no commit', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'git-plug': {
              package: 'git-plug',
              enabled: true,
              source: { type: 'git', url: 'github:example/git-plug' }
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
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
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, null, inventory);
    expect(plan.operations[0]?.kind).toBe('blocked');
  });

  describe('git commit drift', () => {
    const oldCommit = 'a'.repeat(40);
    const newCommit = 'b'.repeat(40);
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            demo: {
              package: 'demo-plugin',
              enabled: true,
              source: { type: 'git', url: 'https://example.com/demo.git' }
            }
          }
        }
      }
    };
    const lockAt = (commit: string): EnvironmentLock => ({
      apiVersion: 'dshenv-lock/v1',
      profiles: {
        web: {
          plugins: {
            demo: {
              package: 'demo-plugin',
              source: { type: 'git', url: 'https://example.com/demo.git', commit }
            }
          }
        }
      }
    });
    const installedFrom = (spec: string): EnvironmentInventory => ({
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'demo-plugin': {
              name: 'demo-plugin',
              installed: true,
              version: '0.1.0',
              sourceType: 'git',
              resolvedSource: spec,
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    });

    it('should plan update when the installed commit differs from the locked commit', () => {
      const plan = buildPlan(manifest, lockAt(newCommit), installedFrom(`https://example.com/demo.git#${oldCommit}`));
      expect(plan.operations).toEqual([
        expect.objectContaining({ kind: 'update', currentVersion: oldCommit, targetVersion: newCommit })
      ]);
    });

    it('should treat an abbreviated installed commit matching the lock as in sync', () => {
      const plan = buildPlan(manifest, lockAt(newCommit), installedFrom(`git+https://example.com/demo.git#${newCommit.slice(0, 7)}`));
      expect(plan.hasChanges).toBe(false);
    });

    it('should treat a SHA-256 installed commit matching the lock as in sync', () => {
      const sha256 = 'c'.repeat(64);
      const plan = buildPlan(manifest, lockAt(sha256), installedFrom(`git+https://example.com/demo.git#${sha256}`));
      expect(plan.hasChanges).toBe(false);
    });

    it('should reinstall at the locked commit when the installed spec carries no commit', () => {
      const plan = buildPlan(manifest, lockAt(newCommit), installedFrom('github:example/demo#main'));
      expect(plan.operations).toEqual([expect.objectContaining({ kind: 'update', targetVersion: newCommit })]);
    });

    const manifestPinning = (commit: string): EnvironmentManifest => {
      const pinned = structuredClone(manifest);
      pinned.profiles.web.plugins.demo.source = { type: 'git', url: 'https://example.com/demo.git', commit };
      return pinned;
    };

    it('should block with a pointer to the lock when the manifest declares a commit the lock lacks', () => {
      const plan = buildPlan(manifestPinning(newCommit), null, installedFrom(`https://example.com/demo.git#${oldCommit}`));
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: 'blocked',
          blockedReason: expect.stringMatching(new RegExp(`declares commit ${newCommit}.*only lock\\.json pins`))
        })
      ]);
    });

    it('should block instead of silently using the lock when the manifest commit differs', () => {
      const plan = buildPlan(manifestPinning(newCommit), lockAt(oldCommit), installedFrom(`https://example.com/demo.git#${oldCommit}`));
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: 'blocked',
          blockedReason: expect.stringMatching(new RegExp(`declares commit ${newCommit}.*locked commit is ${oldCommit}`))
        })
      ]);
    });

    it('should accept a manifest commit that matches the lock, abbreviated or not', () => {
      const plan = buildPlan(manifestPinning(newCommit.slice(0, 7)), lockAt(newCommit), installedFrom(`https://example.com/demo.git#${newCommit}`));
      expect(plan.hasChanges).toBe(false);
    });
  });

  describe('local source digest drift', () => {
    const manifestFor = (type: 'local-file' | 'local-link'): EnvironmentManifest => ({
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            demo: { package: 'demo-plugin', enabled: true, source: { type, path: '/src/demo' } }
          }
        }
      }
    });
    const lockWith = (type: 'local-file' | 'local-link', digest?: string): EnvironmentLock => ({
      apiVersion: 'dshenv-lock/v1',
      profiles: {
        web: { plugins: { demo: { package: 'demo-plugin', source: { type, path: '/src/demo', digest } } } }
      }
    });
    const inventoryFor = (type: 'local-file' | 'local-link'): EnvironmentInventory => ({
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'demo-plugin': {
              name: 'demo-plugin',
              installed: true,
              version: '0.1.0',
              sourceType: type,
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    });
    const inventory = inventoryFor('local-file');
    const current = { web: { demo: 'new-digest' } };

    it.each(['local-file', 'local-link'] as const)(
      'should plan update when the %s source changed since the last apply',
      (type) => {
        const plan = buildPlan(manifestFor(type), lockWith(type, 'old-digest'), inventoryFor(type), null, current);
        expect(plan.operations).toEqual([
          expect.objectContaining({ kind: 'update', currentVersion: 'old-digest', targetVersion: 'new-digest' })
        ]);
      }
    );

    it('should plan update when no digest was recorded for an installed local source', () => {
      const plan = buildPlan(manifestFor('local-file'), lockWith('local-file'), inventory, null, current);
      expect(plan.operations.map((op) => op.kind)).toEqual(['update']);
    });

    it('should stay in sync when the recorded digest matches the source', () => {
      const plan = buildPlan(manifestFor('local-file'), lockWith('local-file', 'new-digest'), inventory, null, current);
      expect(plan.hasChanges).toBe(false);
    });

    it.each(['local-file', 'local-link'] as const)(
      'should plan update when the %s path moved to an identical checkout',
      (type) => {
        const installedAtOld = inventoryFor(type);
        installedAtOld.profiles.web.plugins['demo-plugin'].resolvedSource = '/old/demo';
        const plan = buildPlan(manifestFor(type), lockWith(type, 'new-digest'), installedAtOld, null, current);
        expect(plan.operations.map((op) => op.kind)).toEqual(['update']);

        const lockAtOld = lockWith(type, 'new-digest');
        const oldSource = lockAtOld.profiles.web.plugins.demo.source;
        if (oldSource.type === type) oldSource.path = '/old/demo';
        expect(buildPlan(manifestFor(type), lockAtOld, inventoryFor(type), null, current).operations.map((op) => op.kind)).toEqual(['update']);
      }
    );

    it('should report an installed local plugin whose source cannot be read as unverified without blocking', () => {
      const disabled = manifestFor('local-file');
      disabled.profiles.web.plugins.demo.enabled = false;
      const plan = buildPlan(disabled, lockWith('local-file', 'old-digest'), inventory, null, {});
      expect(plan.operations.map((op) => op.kind)).toEqual(['disable']);
      expect(plan.unverified).toEqual([
        { profile: 'web', alias: 'demo', package: 'demo-plugin', reason: expect.stringContaining('/src/demo') }
      ]);

      const status = buildStatus(disabled, null, inventory, plan);
      expect(status.status).toBe('degraded');
      expect(status.plugins).toEqual([{ profile: 'web', package: 'demo-plugin', status: 'degraded' }]);
    });
  });
});

describe('repairable patch file', () => {
  it('plans a configure that rewrites a broken patch file even when every block matches', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'npm', version: '1.0.0' } } } } }
    };
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'demo-plugin': { name: 'demo-plugin', installed: true, version: '1.0.0', sourceType: 'npm', isSymlink: false, isExternalSymlink: false, enabled: true }
          },
          managedPatches: [],
          patchFileRepairable: true
        }
      }
    };

    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'configure', alias: 'demo', reason: expect.stringContaining('not valid') })
    ]);

    inventory.profiles.web.patchFileRepairable = false;
    expect(buildPlan(manifest, lock, inventory).hasChanges).toBe(false);
  });
});

describe('buildStatus', () => {
  const emptyLock: EnvironmentLock = { apiVersion: 'dshenv-lock/v1', profiles: {} };

  it('should use the seven stable status values', () => {
    const manifest: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: {} };
    const inventory: EnvironmentInventory = { profiles: {} };
    const plan = buildPlan(manifest, emptyLock, inventory);
    const summary = buildStatus(manifest, null, inventory, plan);
    expect(summary.status).toBe('healthy');
  });

  it('should map missing manifest to degraded', () => {
    const inventory: EnvironmentInventory = { profiles: {} };
    const plan = buildPlan(null, null, inventory);
    const summary = buildStatus(null, null, inventory, plan);
    expect(summary.status).toBe('degraded');
  });

  it('should map unmanaged-only inventory to unmanaged', () => {
    const manifest: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: { web: { plugins: {} } } };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            extra: {
              name: 'extra',
              installed: true,
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };
    const plan = buildPlan(manifest, emptyLock, inventory);
    const summary = buildStatus(manifest, null, inventory, plan);
    expect(summary.status).toBe('unmanaged');
    expect(summary.plugins.some((p) => p.status === 'unmanaged' && p.package === 'extra')).toBe(true);
  });

  it('should map configure operations to drifted', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: { type: 'npm', version: '0.1.21' },
              patches: [{ id: 'agent-teams', config: { taskPlanning: 'captain' } }]
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            '@nanmicoder/dsh-agent-teams': {
              name: '@nanmicoder/dsh-agent-teams',
              installed: true,
              version: '0.1.21',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };
    const plan = buildPlan(manifest, emptyLock, inventory);
    const summary = buildStatus(manifest, null, inventory, plan);
    expect(summary.status).toBe('drifted');
  });
});

describe('lock versus effective manifest', () => {
  const npmManifest = (version: string): EnvironmentManifest => ({
    apiVersion: 'dshenv/v1',
    profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'npm', version } } } } }
  });
  const npmLock = (resolvedVersion: string): EnvironmentLock => ({
    apiVersion: 'dshenv-lock/v1',
    profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'npm', resolvedVersion } } } } }
  });
  const installedAt = (version: string): EnvironmentInventory => ({
    profiles: {
      web: {
        name: 'web',
        path: '/dummy',
        plugins: {
          'demo-plugin': {
            name: 'demo-plugin',
            installed: true,
            version,
            sourceType: 'npm',
            isSymlink: false,
            isExternalSymlink: false,
            enabled: true
          }
        }
      }
    }
  });

  it('targets an exact manifest version that disagrees with the lock', () => {
    const plan = buildPlan(npmManifest('1.5.0'), npmLock('1.0.0'), installedAt('1.0.0'));
    expect(plan.operations).toEqual([expect.objectContaining({ kind: 'update', targetVersion: '1.5.0' })]);
  });

  it('disables again after updating a plugin that is and stays disabled, since DSH plugin add selects it', () => {
    const manifest = npmManifest('1.5.0');
    manifest.profiles.web.plugins.demo.enabled = false;
    const inventory = installedAt('1.0.0');
    inventory.profiles.web.plugins['demo-plugin'].enabled = false;
    const plan = buildPlan(manifest, npmLock('1.0.0'), inventory);
    expect(plan.operations.map((op) => op.kind)).toEqual(['update', 'disable']);
  });

  it('reinstalls when the installed npm package reports no version', () => {
    const inventory = installedAt('1.0.0');
    delete inventory.profiles.web.plugins['demo-plugin'].version;
    const plan = buildPlan(npmManifest('1.0.0'), npmLock('1.0.0'), inventory);
    expect(plan.operations).toEqual([expect.objectContaining({ kind: 'update', targetVersion: '1.0.0', reason: expect.stringContaining('no version') })]);
  });

  it('keeps using the lock when it matches the exact manifest version', () => {
    const plan = buildPlan(npmManifest('1.0.0'), npmLock('1.0.0'), installedAt('1.0.0'));
    expect(plan.hasChanges).toBe(false);
  });

  it('blocks a git plugin whose locked commit belongs to another url', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'git', url: 'https://example.com/fork.git' } } } } }
    };
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: {
        web: {
          plugins: {
            demo: { package: 'demo-plugin', source: { type: 'git', url: 'https://example.com/demo.git', commit: 'abcdef1' } }
          }
        }
      }
    };
    const plan = buildPlan(manifest, lock, { profiles: { web: { name: 'web', path: '/dummy', plugins: {} } } });
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'blocked', blockedReason: 'Git source has no locked commit; refusing to invent HEAD' })
    ]);
  });
});

describe('source kinds the inventory reports differently', () => {
  const manifestWith = (source: EnvironmentManifest['profiles'][string]['plugins'][string]['source'], enabled: boolean): EnvironmentManifest => ({
    apiVersion: 'dshenv/v1',
    profiles: { web: { plugins: { demo: { package: 'demo-plugin', enabled, source } } } }
  });
  const inventoryWith = (plugins: EnvironmentInventory['profiles'][string]['plugins']): EnvironmentInventory => ({
    profiles: { web: { name: 'web', path: '/dummy', plugins } }
  });

  it('treats an in-box plugin outside the bundles as disabled rather than missing', () => {
    expect(buildPlan(manifestWith({ type: 'in-box' }, false), null, inventoryWith({})).hasChanges).toBe(false);
    expect(buildPlan(manifestWith({ type: 'in-box' }, true), null, inventoryWith({})).operations).toEqual([
      expect.objectContaining({ kind: 'enable', alias: 'demo' })
    ]);
  });

  it('reinstalls when the declared source type differs from the installed one', () => {
    const url = 'https://example.com/demo.git';
    const commit = 'c'.repeat(40);
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'git', url, commit } } } } }
    };
    const installedFromNpm = inventoryWith({
      'demo-plugin': {
        name: 'demo-plugin', installed: true, version: '1.0.0', sourceType: 'npm', resolvedSource: '1.0.0',
        isSymlink: false, isExternalSymlink: false, enabled: true
      }
    });
    expect(buildPlan(manifestWith({ type: 'git', url }, true), lock, installedFromNpm).operations).toEqual([
      expect.objectContaining({ kind: 'update', reason: 'Source type changed: installed npm != declared git' })
    ]);

    const installedFromGit = inventoryWith({
      'demo-plugin': {
        name: 'demo-plugin', installed: true, version: '1.0.0', sourceType: 'git', resolvedSource: `${url}#${commit}`,
        isSymlink: false, isExternalSymlink: false, enabled: true
      }
    });
    expect(buildPlan(manifestWith({ type: 'npm', version: '1.0.0' }, true), null, installedFromGit).operations).toEqual([
      expect.objectContaining({ kind: 'update', reason: 'Source type changed: installed git != declared npm' })
    ]);
  });
});

describe('plan edge cases around profiles and in-box listings', () => {
  const npmPlugin = (pkg: string) => ({ package: pkg, source: { type: 'npm' as const, version: '1.0.0' } });

  it('installs a declared npm plugin that only a leftover bundle entry lists', () => {
    const manifest: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: { web: { plugins: { foo: npmPlugin('@acme/foo') } } } };
    // What the inventory reports for a bundle entry with no dependency and nothing in node_modules.
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            '@acme/foo': { name: '@acme/foo', installed: true, sourceType: 'in-box', isSymlink: false, isExternalSymlink: false, bundle: true, enabled: true }
          }
        }
      }
    };
    expect(buildPlan(manifest, null, inventory).operations).toEqual([expect.objectContaining({ kind: 'install', package: '@acme/foo' })]);
  });

  it('blocks enabling an in-box plugin in a profile that does not exist and nothing will create', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: { fresh: { plugins: { teams: { package: '@nanmicoder/dsh-agent-teams', source: { type: 'in-box' } } } } }
    };
    expect(buildPlan(manifest, null, { profiles: {} }).operations).toEqual([
      expect.objectContaining({ kind: 'blocked', blockedReason: expect.stringMatching(/Profile 'fresh' does not exist yet/) })
    ]);
  });

  it('installs into a new profile before enabling an in-box plugin there, whatever the package names sort as', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: { fresh: { plugins: { a: { package: 'a-inbox', source: { type: 'in-box' } }, z: npmPlugin('z-npm') } } }
    };
    expect(buildPlan(manifest, null, { profiles: {} }).operations.filter((op) => op.resource === 'plugin').map((op) => `${op.kind}:${op.package}`)).toEqual([
      'install:z-npm',
      'enable:a-inbox'
    ]);
  });

  it('removes the old package behind an alias before installing the new one', () => {
    const manifest: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: { web: { plugins: { foo: npmPlugin('aa-new') } } } };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'zz-old': { name: 'zz-old', installed: true, version: '1.0.0', sourceType: 'npm', isSymlink: false, isExternalSymlink: false, enabled: true }
          }
        }
      }
    };
    const state: EnvironmentState = {
      apiVersion: 'dshenv-state/v1',
      lastApplied: '',
      appliedLockHash: '',
      profiles: {},
      resources: { plugin: { web: { 'zz-old': { package: 'zz-old', alias: 'foo', sourceType: 'npm', adoptedAt: '', adoptedBy: 'apply-1' } } } }
    };
    expect(buildPlan(manifest, null, inventory, state).operations.filter((op) => op.resource === 'plugin').map((op) => `${op.kind}:${op.package}`)).toEqual([
      'remove:zz-old',
      'install:aa-new'
    ]);
  });
});
