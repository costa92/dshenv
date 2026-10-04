import type { EnvironmentManifest, EnvironmentLock, EnvironmentState } from '../domain.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import { PROFILE_PATCHES_ALIAS } from '../profile-patches/entries.js';
import { planPlugins } from '../resources/plugin.js';
import { planProfilePatches } from '../resources/profile-patch.js';
import { ownedSkillDigests, planSkills } from '../resources/skill.js';

export type OperationKind =
  | 'install'
  | 'update'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'configure'
  | 'blocked';

export type ResourceKind = 'plugin' | 'profile-patch' | 'skill';

export interface PluginOperation {
  resource: 'plugin';
  kind: OperationKind;
  profile: string;
  alias: string;
  package: string;
  reason: string;
  currentVersion?: string;
  targetVersion?: string;
  currentEnabled?: boolean;
  targetEnabled?: boolean;
  blockedReason?: string;
}

// The profile-level patch entries of one profile, written as a whole.
export interface ProfilePatchOperation {
  resource: 'profile-patch';
  kind: 'configure' | 'blocked';
  profile: string;
  reason: string;
  blockedReason?: string;
}

// A loose skill in $DSH_HOME/skills; skills are home-wide, so it names no profile.
export interface SkillPlanOperation {
  resource: 'skill';
  kind: 'install' | 'update' | 'remove';
  name: string;
  reason: string;
}

export type ProfileOperation = PluginOperation | ProfilePatchOperation;
export type PlanOperation = ProfileOperation | SkillPlanOperation;

export function isProfileOperation(operation: PlanOperation): operation is ProfileOperation {
  return operation.resource !== 'skill';
}

export interface UnmanagedPlugin {
  profile: string;
  package: string;
}

// profile -> alias -> current digest of the plugin's local source directory
export type LocalSourceDigests = Record<string, Record<string, string>>;

// Declared and installed, but without the evidence to tell whether it matches; reported, never blocking.
export interface UnverifiedPlugin {
  profile: string;
  alias: string;
  package: string;
  reason: string;
}

// Patch entries outside dshenv's blocks, e.g. settings changed in DSH; `dshenv pull` takes them over.
export interface UnmanagedPatches {
  profile: string;
  entries: string[];
}

export interface EnvironmentPlan {
  hasChanges: boolean;
  // Per-profile operations in execution order, then the skill operations.
  operations: PlanOperation[];
  unmanaged: UnmanagedPlugin[];
  unverified: UnverifiedPlugin[];
  unmanagedPatches: UnmanagedPatches[];
  unmanagedSkills: string[];
  // Agent presets a manifest patch restates whole (dshenv tools); DSH upgrades to them no longer apply.
  pinnedPresets?: Array<{ profile: string; id: string }>;
}

export type StableStatus =
  | 'healthy'
  | 'disabled'
  | 'restart-required'
  | 'drifted'
  | 'unmanaged'
  | 'incompatible'
  | 'degraded';

export interface PluginStatusEntry {
  profile: string;
  package: string;
  status: StableStatus;
}

export interface EnvironmentStatusSummary {
  status: StableStatus;
  hasChanges: boolean;
  operationCounts: Record<OperationKind, number>;
  unmanagedCount: number;
  profilesCount: number;
  plugins: PluginStatusEntry[];
}

const KIND_ORDER: Record<OperationKind, number> = {
  install: 1,
  update: 2,
  enable: 3,
  disable: 4,
  remove: 5,
  configure: 6,
  blocked: 7
};

// -p narrows plan, status and apply to one profile by reading only that profile; skills live home-wide, so they stay in.
export function onlyProfile<T extends { profiles: Record<string, unknown> }>(value: T, profile: string | undefined): T {
  if (profile === undefined) {
    return value;
  }
  return { ...value, profiles: Object.hasOwn(value.profiles, profile) ? { [profile]: value.profiles[profile] } : {} };
}

export function buildPlan(
  manifest: EnvironmentManifest | null,
  lock: EnvironmentLock | null,
  inventory: EnvironmentInventory,
  state?: EnvironmentState | null,
  localDigests?: LocalSourceDigests
): EnvironmentPlan {
  const plugins = planPlugins(manifest, lock, inventory, state, localDigests);
  if (!manifest) {
    return {
      hasChanges: false,
      operations: [],
      unmanaged: plugins.unmanaged,
      unverified: plugins.unverified,
      unmanagedPatches: [],
      unmanagedSkills: []
    };
  }
  const patches = planProfilePatches(manifest, inventory, plugins.operations);
  const operations: ProfileOperation[] = [...plugins.operations, ...patches.operations];

  // Blocks that all match still leave the file unreadable to DSH; rewriting one plugin's blocks repairs the whole file.
  for (const [profName, profManifest] of Object.entries(manifest.profiles)) {
    const repairAlias = Object.keys(profManifest.plugins).sort()[0];
    if (inventory.profiles[profName]?.patchFileRepairable && repairAlias && !operations.some((op) => op.kind === 'configure' && op.profile === profName)) {
      operations.push({
        resource: 'plugin',
        kind: 'configure',
        profile: profName,
        alias: repairAlias,
        package: profManifest.plugins[repairAlias].package,
        reason: 'cordis.patch.yml is not valid YAML; rewriting the managed blocks repairs it'
      });
    }
  }

  // Sort operations deterministically: profile -> package -> kind; profile patches go last, after the installs that create the profile.
  // Removes run first, as they clear their alias's patches and mount, which a new package under that alias may already use;
  // installs run next, as they create a profile that an in-box enable of another package writes to.
  operations.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    if (a.resource !== b.resource) return a.resource === 'profile-patch' ? 1 : -1;
    if (a.resource === 'profile-patch' || b.resource === 'profile-patch') return 0;
    const stage = (op: PluginOperation): number => (op.kind === 'remove' ? 0 : op.kind === 'install' ? 1 : 2);
    if (stage(a) !== stage(b)) return stage(a) - stage(b);
    if (a.package !== b.package) return a.package.localeCompare(b.package);
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });

  const unmanaged = [...plugins.unmanaged].sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.package.localeCompare(b.package);
  });

  const skills = inventory.skills ? planSkills(inventory.skills, ownedSkillDigests(state)) : { operations: [], unmanaged: [] };
  const { pinnedPresets } = patches;

  return {
    hasChanges: operations.length > 0 || skills.operations.length > 0,
    operations: [...operations, ...skills.operations],
    unmanaged,
    unverified: plugins.unverified,
    unmanagedPatches: patches.unmanaged,
    unmanagedSkills: skills.unmanaged,
    ...(pinnedPresets.length > 0 ? { pinnedPresets } : {})
  };
}

export function buildStatus(
  manifest: EnvironmentManifest | null,
  state: EnvironmentState | null,
  inventory: EnvironmentInventory,
  plan: EnvironmentPlan
): EnvironmentStatusSummary {
  const operationCounts: Record<OperationKind, number> = {
    install: 0,
    update: 0,
    enable: 0,
    disable: 0,
    remove: 0,
    configure: 0,
    blocked: 0
  };

  for (const op of plan.operations.filter(isProfileOperation)) {
    operationCounts[op.kind] = (operationCounts[op.kind] || 0) + 1;
  }

  const plugins = collectPluginStatuses(manifest, state, inventory, plan);

  let status: StableStatus = 'healthy';
  if (!manifest || operationCounts.blocked > 0 || plugins.some((p) => p.status === 'degraded')) {
    status = 'degraded';
  } else if (plugins.some((p) => p.status === 'incompatible')) {
    status = 'incompatible';
  } else if (
    operationCounts.install +
      operationCounts.update +
      operationCounts.enable +
      operationCounts.disable +
      operationCounts.remove +
      operationCounts.configure >
    0
  ) {
    status = 'drifted';
  } else if (plan.operations.some((op) => op.resource === 'skill')) {
    status = 'drifted';
  } else if (plan.unmanaged.length > 0 || plan.unmanagedPatches.length > 0 || plan.unmanagedSkills.length > 0) {
    status = 'unmanaged';
  } else if (plugins.some((p) => p.status === 'restart-required')) {
    status = 'restart-required';
  }

  return {
    status,
    hasChanges: plan.hasChanges,
    operationCounts,
    unmanagedCount: plan.unmanaged.length,
    // A declared profile DSH has not created yet is still one this environment manages.
    profilesCount: new Set([...Object.keys(inventory.profiles), ...Object.keys(manifest?.profiles ?? {})]).size,
    plugins
  };
}

function collectPluginStatuses(
  manifest: EnvironmentManifest | null,
  state: EnvironmentState | null,
  inventory: EnvironmentInventory,
  plan: EnvironmentPlan
): PluginStatusEntry[] {
  const entries: PluginStatusEntry[] = [];
  const pluginOperations = plan.operations.filter((op): op is PluginOperation => op.resource === 'plugin');
  const blocked = new Set(pluginOperations.filter((op) => op.kind === 'blocked').map((op) => `${op.profile}\0${op.package}`));
  const drifted = new Set(
    pluginOperations
      .filter(
        (op) =>
          op.kind === 'install' ||
          op.kind === 'update' ||
          op.kind === 'enable' ||
          op.kind === 'disable' ||
          op.kind === 'remove' ||
          op.kind === 'configure'
      )
      .map((op) => `${op.profile}\0${op.package}`)
  );
  const unmanaged = new Set(plan.unmanaged.map((u) => `${u.profile}\0${u.package}`));
  const unverified = new Set(plan.unverified.map((u) => `${u.profile}\0${u.package}`));

  const seen = new Set<string>();
  const push = (profile: string, pkg: string, status: StableStatus) => {
    const key = `${profile}\0${pkg}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ profile, package: pkg, status });
  };

  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    for (const pkgName of Object.keys(profInv.plugins)) {
      const key = `${profName}\0${pkgName}`;
      const stateStatus = state?.profiles?.[profName]?.plugins?.[pkgName]?.status;
      if (unmanaged.has(key)) {
        push(profName, pkgName, 'unmanaged');
      } else if (blocked.has(key) || unverified.has(key)) {
        push(profName, pkgName, 'degraded');
      } else if (drifted.has(key)) {
        push(profName, pkgName, 'drifted');
      } else if (stateStatus === 'restart-required' || stateStatus === 'incompatible' || stateStatus === 'degraded') {
        push(profName, pkgName, stateStatus);
      } else if (profInv.plugins[pkgName].enabled === false) {
        push(profName, pkgName, 'disabled');
      } else {
        push(profName, pkgName, 'healthy');
      }
    }
  }

  if (manifest) {
    for (const [profName, profManifest] of Object.entries(manifest.profiles)) {
      for (const plugin of Object.values(profManifest.plugins)) {
        const key = `${profName}\0${plugin.package}`;
        if (blocked.has(key) || unverified.has(key)) {
          push(profName, plugin.package, 'degraded');
        } else if (drifted.has(key)) {
          push(profName, plugin.package, 'drifted');
        } else {
          const stateStatus = state?.profiles?.[profName]?.plugins?.[plugin.package]?.status;
          push(profName, plugin.package, stateStatus === 'restart-required' ? stateStatus : 'healthy');
        }
      }
    }
  }

  // A plugin apply removed or that DSH no longer lists can still be running until DSH restarts.
  const profiles = new Set([...Object.keys(inventory.profiles), ...Object.keys(manifest?.profiles ?? {})]);
  for (const [profName, profState] of Object.entries(state?.profiles ?? {})) {
    for (const [pkgName, record] of Object.entries(profState.plugins)) {
      if (profiles.has(profName) && record.status === 'restart-required') {
        push(profName, pkgName, 'restart-required');
      }
    }
  }

  entries.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.package.localeCompare(b.package);
  });
  return entries;
}

// The --json shape: profile patches under the '@profile' alias, skills in skillOperations.
export function planJson(plan: EnvironmentPlan): Record<string, unknown> {
  const { hasChanges, unmanaged, unverified, unmanagedPatches, unmanagedSkills, pinnedPresets } = plan;
  const operations = plan.operations.filter(isProfileOperation).map(({ resource, ...op }) => {
    if (resource !== 'profile-patch') {
      return op;
    }
    const { profile, ...rest } = op;
    return { profile, alias: PROFILE_PATCHES_ALIAS, package: PROFILE_PATCHES_ALIAS, ...rest };
  });
  const skillOperations = plan.operations.flatMap((op) => (op.resource === 'skill' ? [{ kind: op.kind, name: op.name, reason: op.reason }] : []));
  return {
    hasChanges,
    operations,
    unmanaged,
    unverified,
    unmanagedPatches,
    skillOperations,
    unmanagedSkills,
    ...(pinnedPresets ? { pinnedPresets } : {})
  };
}

export function planExitCode(plan: { hasChanges: boolean; operations: { kind: OperationKind }[] }): number {
  if (plan.operations.some((op) => op.kind === 'blocked')) {
    return 5;
  }
  if (plan.hasChanges) {
    return 2;
  }
  return 0;
}
