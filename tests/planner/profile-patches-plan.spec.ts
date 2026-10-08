import { describe, it, expect } from 'vitest';
import { buildPlan, buildStatus } from '../../src/planner/plan.js';
import type { EnvironmentManifest, ProfilePatch } from '../../src/domain.js';
import type { EnvironmentInventory, ProfileInventory } from '../../src/inventory/profile-reader.js';
import { digestProfilePatches } from '../../src/profile-patches/entries.js';
import { renderPlan } from '../../src/output/render.js';

const locale: ProfilePatch = { id: 'locale', config: { preference: 'zh' } };

const manifest = (patches?: ProfilePatch[], plugins: EnvironmentManifest['profiles'][string]['plugins'] = {}): EnvironmentManifest => ({
  apiVersion: 'dshenv/v1',
  profiles: { web: { plugins, ...(patches ? { patches } : {}) } }
});

const inventory = (profilePatches?: ProfileInventory['profilePatches']): EnvironmentInventory => ({
  profiles: { web: { name: 'web', path: '/p/web', plugins: {}, managedPatches: [], ...(profilePatches ? { profilePatches } : {}) } }
});

const block = (entries: ProfilePatch[], digest = digestProfilePatches(entries)) => ({
  entries,
  digest,
  isDigestValid: digest === digestProfilePatches(entries)
});

describe('buildPlan with profile patches', () => {
  it('is clean when the profile block holds exactly the declared entries', () => {
    const plan = buildPlan(manifest([locale]), null, inventory({ block: block([locale]), unmanaged: [] }));
    expect(plan.hasChanges).toBe(false);
    expect(plan.unmanagedPatches).toEqual([]);
  });

  it('configures the profile block when it is missing, changed in the manifest, or no longer declared', () => {
    const missing = buildPlan(manifest([locale]), null, inventory({ block: null, unmanaged: [] }));
    expect(missing.operations).toMatchObject([{ kind: 'configure', profile: 'web', resource: 'profile-patch' }]);
    expect(missing.operations[0].reason).toMatch(/not written/);

    const changed = buildPlan(manifest([{ id: 'locale', config: { preference: 'en' } }]), null, inventory({ block: block([locale]), unmanaged: [] }));
    expect(changed.operations[0].reason).toMatch(/changed in the manifest/);

    const dropped = buildPlan(manifest(), null, inventory({ block: block([locale]), unmanaged: [] }));
    expect(dropped.operations).toMatchObject([{ kind: 'configure', resource: 'profile-patch' }]);
  });

  it('clears the block of a profile the manifest no longer declares', () => {
    const undeclared: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: {} };
    const plan = buildPlan(undeclared, null, inventory({ block: block([locale]), unmanaged: [] }));
    expect(plan.operations).toMatchObject([{ kind: 'configure', profile: 'web', resource: 'profile-patch', reason: expect.stringMatching(/no longer declared/) }]);
  });

  it('tells a DSH edit of the block apart and points to pull', () => {
    const edited = { id: 'locale', config: { preference: 'en' } };
    const plan = buildPlan(manifest([locale]), null, inventory({ block: block([edited], digestProfilePatches([locale])), unmanaged: [] }));
    expect(plan.operations[0].reason).toMatch(/edited in DSH.*dshenv pull --yes/);
  });

  it('reports entries outside the managed blocks without planning a change', () => {
    const plan = buildPlan(manifest(), null, inventory({ block: null, unmanaged: [locale, { insert: [] }] }));
    expect(plan.hasChanges).toBe(false);
    expect(plan.unmanagedPatches).toEqual([{ profile: 'web', entries: ['locale', 'insert'] }]);
    expect(renderPlan(plan)).toMatch(/Patch entries not in the manifest.*\n {2}\? \[web\] locale, insert/);
    expect(buildStatus(manifest(), null, inventory({ block: null, unmanaged: [locale] }), plan).status).toBe('unmanaged');
  });

  it('writes the block of a profile that does not exist yet only after the installs that create it', () => {
    const empty: EnvironmentInventory = { profiles: {} };
    const plugins = { z: { package: 'a-plugin', enabled: true, source: { type: 'npm' as const, version: '1.0.0' } } };
    const plan = buildPlan(manifest([locale], plugins), null, empty);
    expect(plan.operations.map((op) => [op.resource, op.kind])).toEqual([['plugin', 'install'], ['profile-patch', 'configure']]);

    // web is a template profile, which DSH creates itself; a name it has no template for has nowhere to go.
    const created = buildPlan(manifest([locale]), null, empty);
    expect(created.operations).toMatchObject([{ kind: 'configure', resource: 'profile-patch' }]);
    expect(created.createdProfiles).toEqual(['web']);
    expect(plan.createdProfiles).toBeUndefined();

    const mine = manifest([locale]);
    mine.profiles = { mine: mine.profiles.web };
    const blocked = buildPlan(mine, null, empty);
    expect(blocked.operations).toMatchObject([{ kind: 'blocked', resource: 'profile-patch' }]);
    expect(blocked.createdProfiles).toBeUndefined();
  });

  it('renders the profile block operation without a package name', () => {
    const plan = buildPlan(manifest([locale]), null, inventory({ block: null, unmanaged: [] }));
    expect(renderPlan(plan)).toContain('* [web] profile patches');
  });
});
