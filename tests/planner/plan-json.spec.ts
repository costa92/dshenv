import { describe, it, expect } from 'vitest';
import { planJson, type EnvironmentPlan } from '../../src/planner/plan.js';

describe('planJson', () => {
  it('keeps the --json shape: profile patches as the @profile alias, global patches and skills in their own lists', () => {
    const plan: EnvironmentPlan = {
      hasChanges: true,
      operations: [
        { resource: 'plugin', kind: 'install', profile: 'web', alias: 'teams', package: 'agent-teams', reason: 'missing', targetVersion: '1.0.0' },
        { resource: 'profile-patch', kind: 'configure', profile: 'web', reason: 'Profile patches are not written yet' },
        { resource: 'home-patch', kind: 'configure', reason: 'Global patches are not written yet' },
        { resource: 'skill', kind: 'install', name: 'wiki', reason: 'Skill is declared but not in DSH_HOME/skills' }
      ],
      unmanaged: [],
      unverified: [],
      unmanagedPatches: [],
      unmanagedHomePatches: ['tool-subagent'],
      shadowedPatches: [{ profile: 'web', ids: ['system-prompt'] }],
      unmanagedSkills: ['mine']
    };

    expect(planJson(plan)).toEqual({
      hasChanges: true,
      operations: [
        { kind: 'install', profile: 'web', alias: 'teams', package: 'agent-teams', reason: 'missing', targetVersion: '1.0.0' },
        { kind: 'configure', profile: 'web', alias: '@profile', package: '@profile', reason: 'Profile patches are not written yet' }
      ],
      unmanaged: [],
      unverified: [],
      unmanagedPatches: [],
      homePatchOperations: [{ kind: 'configure', reason: 'Global patches are not written yet' }],
      unmanagedHomePatches: ['tool-subagent'],
      shadowedPatches: [{ profile: 'web', ids: ['system-prompt'] }],
      skillOperations: [{ kind: 'install', name: 'wiki', reason: 'Skill is declared but not in DSH_HOME/skills' }],
      unmanagedSkills: ['mine']
    });
  });
});
