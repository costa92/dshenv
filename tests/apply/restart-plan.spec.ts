import { describe, it, expect } from 'vitest';
import type { EnvironmentPlan, OperationKind, PluginOperation } from '../../src/planner/plan.js';
import type { HmrStatus } from '../../src/dsh/hmr.js';
import {
  buildRestartSummary,
  describeRestartReason,
  profilesToProbe,
  restartItemFor
} from '../../src/apply/restart-plan.js';

const op = (kind: OperationKind, profile = 'web', pkg = 'demo-plugin'): PluginOperation => ({
  resource: 'plugin',
  kind,
  profile,
  alias: 'demo',
  package: pkg,
  reason: 'test'
});

const on: HmrStatus = { state: 'on' };
const off: HmrStatus = { state: 'off' };
const unknown: HmrStatus = { state: 'unknown', reason: 'DSH CLI was not found' };

describe('restartItemFor', () => {
  for (const kind of ['install', 'enable', 'disable', 'configure', 'remove'] as const) {
    it(`needs no restart for ${kind} when hot reload is on`, () => {
      expect(restartItemFor(op(kind), on)).toEqual({ profile: 'web', package: 'demo-plugin', kind, reason: 'hmr-on' });
    });

    it(`needs a restart for ${kind} when hot reload is off`, () => {
      expect(restartItemFor(op(kind), off)).toEqual({ profile: 'web', package: 'demo-plugin', kind, reason: 'hmr-off' });
    });

    it(`needs a restart for ${kind} when hot reload is unknown`, () => {
      expect(restartItemFor(op(kind), unknown)).toEqual({
        profile: 'web',
        package: 'demo-plugin',
        kind,
        reason: 'hmr-unknown',
        detail: 'DSH CLI was not found'
      });
    });
  }

  for (const hmr of [on, off, unknown]) {
    it(`always needs a restart for update when hot reload is ${hmr.state}`, () => {
      expect(restartItemFor(op('update'), hmr)).toEqual({
        profile: 'web',
        package: 'demo-plugin',
        kind: 'update',
        reason: 'package-update'
      });
    });
  }

  it('ignores blocked operations', () => {
    expect(restartItemFor(op('blocked'), on)).toBeNull();
  });
});

describe('buildRestartSummary', () => {
  it('groups operations by profile verdict in plan order', () => {
    const plan: EnvironmentPlan = {
      hasChanges: true,
      operations: [op('enable', 'web', 'a'), op('update', 'web', 'b'), op('install', 'cli', 'c'), op('blocked', 'web', 'd')],
      unmanaged: [],
      unverified: [],
      unmanagedPatches: [],
      unmanagedSkills: []
    };
    const summary = buildRestartSummary(plan, new Map<string, HmrStatus>([['web', on], ['cli', off]]));
    expect(summary).toEqual({
      notRequired: [{ profile: 'web', package: 'a', kind: 'enable', reason: 'hmr-on' }],
      required: [
        { profile: 'web', package: 'b', kind: 'update', reason: 'package-update' },
        { profile: 'cli', package: 'c', kind: 'install', reason: 'hmr-off' }
      ]
    });
  });

  it('treats a profile without a probe result as unknown', () => {
    const plan: EnvironmentPlan = { hasChanges: true, operations: [op('enable')], unmanaged: [],
      unverified: [],
      unmanagedPatches: [],
      unmanagedSkills: [] };
    expect(buildRestartSummary(plan, new Map()).required).toEqual([
      { profile: 'web', package: 'demo-plugin', kind: 'enable', reason: 'hmr-unknown', detail: 'hot reload was not probed' }
    ]);
  });
});

describe('profilesToProbe', () => {
  it('lists each profile with a restart-relevant operation once', () => {
    const plan: EnvironmentPlan = {
      hasChanges: true,
      operations: [op('enable', 'web'), op('configure', 'web'), op('blocked', 'api'), op('install', 'cli')],
      unmanaged: [],
      unverified: [],
      unmanagedPatches: [],
      unmanagedSkills: []
    };
    expect(profilesToProbe(plan)).toEqual(['web', 'cli']);
  });
});

describe('describeRestartReason', () => {
  it('uses the fixed English texts', () => {
    expect(describeRestartReason({ profile: 'web', package: 'p', kind: 'update', reason: 'package-update' })).toBe(
      'package updates are not hot-reloaded'
    );
    expect(describeRestartReason({ profile: 'cli', package: 'p', kind: 'install', reason: 'hmr-off' })).toBe(
      'hot reload is off for profile cli'
    );
    expect(
      describeRestartReason({ profile: 'cli', package: 'p', kind: 'install', reason: 'hmr-unknown', detail: 'DSH CLI was not found' })
    ).toBe('hot reload state of profile cli is unknown: DSH CLI was not found');
  });
});

describe('global patch changes', () => {
  const plan = (operations: EnvironmentPlan['operations']): EnvironmentPlan => ({
    hasChanges: true,
    operations,
    unmanaged: [],
    unverified: [],
    unmanagedPatches: [],
    unmanagedSkills: []
  });
  const home = { resource: 'home-patch' as const, kind: 'configure' as const, reason: 'Global patches changed in the manifest' };

  it('probe every existing profile and need a restart where hot reload is off', () => {
    const changed = plan([op('install', 'web'), home]);
    expect(profilesToProbe(changed, ['headless', 'web'])).toEqual(['web', 'headless']);
    const summary = buildRestartSummary(changed, new Map<string, HmrStatus>([['web', on], ['headless', off]]), ['headless', 'web']);
    expect(summary.required).toEqual([{ profile: 'headless', package: '@home', kind: 'configure', reason: 'hmr-off' }]);
    expect(summary.notRequired).toContainEqual({ profile: 'web', package: '@home', kind: 'configure', reason: 'hmr-on' });
  });

  it('leave the profiles alone when the global patches do not change or cannot be written', () => {
    const blocked = plan([{ ...home, kind: 'blocked', blockedReason: 'x' }]);
    expect(profilesToProbe(blocked, ['web'])).toEqual([]);
    expect(buildRestartSummary(blocked, new Map<string, HmrStatus>([['web', off]]), ['web'])).toEqual({ notRequired: [], required: [] });
  });
});
