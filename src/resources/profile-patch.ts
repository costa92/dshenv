import type { EnvironmentManifest, ProfilePatch } from '../domain.js';
import { dshCreatesProfile, missingProfileReason } from '../dsh/templates.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import type { HomePatchOperation, PluginOperation, ProfilePatchOperation, ShadowedPatches, UnmanagedPatches } from '../planner/plan.js';
import { isDeepStrictEqual } from 'node:util';
import { readProfilePatchFile, rewriteProfilePatchFile, writeProfilePatches } from '../apply/patches.js';
import { ValidationError } from '../errors.js';
import {
  HOME_PATCH_TARGET,
  describePatchTarget,
  describeProfilePatch,
  digestProfilePatches,
  mergeDshPatches,
  overrideKey,
  readProfilePatchState,
  removeUnmanagedEntries,
  replaceProfileBlock
} from '../profile-patches/entries.js';
import { isPresetPatch } from '../tools/catalog.js';
import { appendBlocks, stringifyWithJs } from '../patch/patch.js';
import { findPlaintextSecrets } from '../security/secrets.js';

export interface ProfilePatchPlan {
  operations: ProfilePatchOperation[];
  unmanaged: UnmanagedPatches[];
  // Agent presets a manifest patch restates whole (dshenv tools); DSH upgrades to them no longer apply.
  pinnedPresets: Array<{ profile: string; id: string }>;
}

// A profile block can only be written once the plugin installs that create its profile have run.
export function planProfilePatches(
  manifest: EnvironmentManifest,
  inventory: EnvironmentInventory,
  pluginOperations: PluginOperation[]
): ProfilePatchPlan {
  const operations: ProfilePatchOperation[] = [];
  for (const [profName, profManifest] of Object.entries(manifest.profiles)) {
    const operation = planProfileBlock(profName, profManifest.patches ?? [], inventory.profiles[profName], pluginOperations);
    if (operation) {
      operations.push(operation);
    }
  }
  // A profile the manifest dropped, e.g. with a deselected overlay, gets its block emptied like dropped entries.
  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    const operation = manifest.profiles[profName] ? null : planProfileBlock(profName, [], profInv, pluginOperations);
    if (operation) {
      operations.push(operation);
    }
  }

  const unmanaged: UnmanagedPatches[] = Object.entries(inventory.profiles)
    .filter(([, profInv]) => (profInv.profilePatches?.unmanaged.length ?? 0) > 0)
    .map(([profName, profInv]) => ({ profile: profName, entries: profInv.profilePatches!.unmanaged.map(describeProfilePatch) }))
    .sort((a, b) => a.profile.localeCompare(b.profile));
  const pinnedPresets = Object.entries(manifest.profiles).flatMap(([profile, profManifest]) =>
    (profManifest.patches ?? []).filter(isPresetPatch).map((entry) => ({ profile, id: String(entry.id) }))
  );
  return { operations, unmanaged, pinnedPresets };
}

function planProfileBlock(
  profile: string,
  expected: ProfilePatch[],
  profInv: EnvironmentInventory['profiles'][string] | undefined,
  pluginOperations: PluginOperation[]
): ProfilePatchOperation | null {
  const base = { resource: 'profile-patch', profile } as const;
  if (!profInv) {
    if (expected.length === 0) {
      return null;
    }
    // DSH creates the profile when it installs a plugin into it, or from its template; otherwise there is nowhere to write.
    if (dshCreatesProfile(profile) || pluginOperations.some((op) => op.profile === profile && op.kind === 'install')) {
      return { ...base, kind: 'configure', reason: 'Profile patches are not written yet' };
    }
    const reason = missingProfileReason(profile);
    return { ...base, kind: 'blocked', reason, blockedReason: reason };
  }
  const block = profInv.profilePatches?.block ?? null;
  if (!block) {
    return expected.length > 0 ? { ...base, kind: 'configure', reason: 'Profile patches are not written yet' } : null;
  }
  if (!block.isDigestValid) {
    const secrets = editedSecrets(profile, block.entries, expected);
    if (secrets.length > 0) {
      const reason = `${describeSecrets(secrets)} was written into the dshenv block in DSH as plaintext, which apply would overwrite and pull cannot take; ` +
        'set it through an *Env key naming an environment variable instead';
      return { ...base, kind: 'blocked', reason, blockedReason: reason };
    }
    return {
      ...base,
      kind: 'configure',
      reason: "Profile patches were edited in DSH; run 'dshenv pull --yes' to keep the edits, or apply to overwrite them"
    };
  }
  if (block.digest === digestProfilePatches(expected)) {
    return null;
  }
  return {
    ...base,
    kind: 'configure',
    reason: expected.length > 0 ? 'Profile patches changed in the manifest' : 'Profile patches are no longer declared'
  };
}

// The global file may not exist; DSH reads it when it does, so writing the block creates it.
export function planHomePatches(
  manifest: EnvironmentManifest,
  inventory: EnvironmentInventory
): { operations: HomePatchOperation[]; unmanaged: string[]; shadowed: ShadowedPatches[] } {
  const expected = manifest.patches ?? [];
  const state = inventory.homePatches;
  const unmanaged = (state?.unmanaged ?? []).map(describeProfilePatch);
  const shadowed = findShadowedPatches(manifest, [...expected, ...(state?.unmanaged ?? [])]);
  const op = (kind: HomePatchOperation['kind'], reason: string): HomePatchOperation =>
    kind === 'blocked' ? { resource: 'home-patch', kind, reason, blockedReason: reason } : { resource: 'home-patch', kind, reason };
  if (inventory.homePatchesError !== undefined) {
    // Rewriting a file dshenv cannot parse would lose what is in it; DSH cannot boot with it either.
    const operations = expected.length > 0 ? [op('blocked', `Cannot read ${inventory.homePatchesError}; fix it by hand`)] : [];
    return { operations, unmanaged, shadowed };
  }
  const block = state?.block ?? null;
  let operation: HomePatchOperation | null = null;
  if (!block) {
    operation = expected.length > 0 ? op('configure', 'Global patches are not written yet') : null;
  } else if (!block.isDigestValid) {
    const secrets = editedSecrets(HOME_PATCH_TARGET, block.entries, expected);
    operation = secrets.length > 0
      ? op('blocked', `${describeSecrets(secrets)} was written into the dshenv block by hand as plaintext, which apply would overwrite and pull cannot take; ` +
        'set it through an *Env key naming an environment variable instead')
      : op('configure', "Global patches were edited by hand; run 'dshenv pull --yes' to keep the edits, or apply to overwrite them");
  } else if (block.digest !== digestProfilePatches(expected)) {
    operation = op('configure', expected.length > 0 ? 'Global patches changed in the manifest' : 'Global patches are no longer declared');
  }
  return { operations: operation ? [operation] : [], unmanaged, shadowed };
}

// DSH applies the global file after a profile's own and assigns each field over the profile entry's, so an id both set
// loses the fields the global entry writes. DSH's plugin page toggles a row through the profile layer's `disabled`, which
// a global `disabled` always wins over, so that id is reported whatever the profile entry writes.
export function findShadowedPatches(manifest: EnvironmentManifest, globalEntries: ProfilePatch[]): ShadowedPatches[] {
  const global = new Map<string, Set<string>>();
  for (const entry of globalEntries) {
    const key = overrideKey(entry);
    if (key === undefined) continue;
    const fields = global.get(key) ?? new Set<string>();
    Object.keys(entry).filter((field) => field !== 'id').forEach((field) => fields.add(field));
    global.set(key, fields);
  }
  if (global.size === 0) return [];
  return Object.entries(manifest.profiles)
    .map(([profile, entry]) => {
      const own: Array<[string, string[]]> = [
        ...(entry.patches ?? []).flatMap((patch): Array<[string, string[]]> => {
          const key = overrideKey(patch);
          return key === undefined ? [] : [[key, Object.keys(patch).filter((field) => field !== 'id')]];
        }),
        // A disabled plugin's patches are not written, so they shadow nothing; the rest are written as their config.
        ...Object.values(entry.plugins)
          .filter((plugin) => plugin.enabled !== false)
          .flatMap((plugin) => (plugin.patches ?? []).filter((patch) => patch.enabled !== false).map((patch): [string, string[]] => [patch.id, ['config']]))
      ];
      const ids = new Set<string>();
      const disabled = new Set<string>();
      for (const [key, fields] of own) {
        const overridden = global.get(key);
        if (!overridden) continue;
        if (overridden.has('disabled')) disabled.add(key);
        if (overridden.has('disabled') || fields.some((field) => overridden.has(field))) ids.add(key);
      }
      return { profile, ids: [...ids].sort(), ...(disabled.size > 0 ? { disabled: [...disabled].sort() } : {}) };
    })
    .filter((item) => item.ids.length > 0)
    .sort((a, b) => a.profile.localeCompare(b.profile));
}

export async function applyHomePatchOperation(paths: EnvironmentPaths, manifest: EnvironmentManifest): Promise<() => Promise<void>> {
  return writeProfilePatches(paths, HOME_PATCH_TARGET, manifest.patches ?? []);
}

export async function applyProfilePatchOperation(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  operation: ProfilePatchOperation
): Promise<() => Promise<void>> {
  return writeProfilePatches(paths, operation.profile, manifest.profiles[operation.profile]?.patches ?? []);
}

// A plaintext credential in a patch entry; the value itself is never kept.
export interface PatchSecret {
  profile: string;
  entry: string;
  path: string;
  // In the dshenv block, edited in place, rather than an entry outside it.
  managed: boolean;
}

// Credentials in these entries whose values the manifest does not already hold, so taking them would spread them.
function newSecrets(profile: string, entries: ProfilePatch[], expected: ProfilePatch[], managed: boolean): PatchSecret[] {
  const known = new Set(expected.flatMap((entry) => findPlaintextSecrets(entry).map((secret) => secret.digest)));
  return entries.flatMap((entry) =>
    findPlaintextSecrets(entry)
      .filter((secret) => !known.has(secret.digest))
      .map(({ path }) => ({ profile, entry: describeProfilePatch(entry), path, managed }))
  );
}

// A credential written into the block in DSH; one the manifest already declares is only warned about.
function editedSecrets(profile: string, block: ProfilePatch[], expected: ProfilePatch[]): PatchSecret[] {
  return newSecrets(profile, block, expected, true);
}

export function describeSecrets(secrets: PatchSecret[]): string {
  return secrets.map((secret) => `${describePatchTarget(secret.profile)} / ${secret.entry} / ${secret.path}`).join(', ');
}

// A profile whose patch entries changed in DSH, and the entries pull makes it declare.
export interface ProfilePatchImport {
  profile: string;
  content: string;
  desired: ProfilePatch[];
  expected: ProfilePatch[];
  from: 'dsh' | 'manifest';
  // Entries outside the block that hold plaintext credentials: left in the file, not taken.
  held: ProfilePatch[];
}

// Profiles changed only in DSH are read; one the manifest changed too is a conflict unless prefer settles it.
export async function planProfilePatchImport(
  paths: EnvironmentPaths,
  profiles: string[],
  expectedFor: (profile: string) => ProfilePatch[],
  prefer: 'dsh' | 'manifest' | undefined
): Promise<{ reads: ProfilePatchImport[]; conflicts: string[]; secrets: PatchSecret[] }> {
  const reads: ProfilePatchImport[] = [];
  const conflicts: string[] = [];
  const secrets: PatchSecret[] = [];
  for (const profile of profiles) {
    const content = await readProfilePatchFile(paths, profile);
    const state = readProfilePatchState(content, profile);
    const expected = expectedFor(profile);
    const blockSecrets = state.block && !state.block.isDigestValid ? editedSecrets(profile, state.block.entries, expected) : [];
    if (blockSecrets.length > 0) {
      // Taking the rest of the block would rewrite it without the edit; apply is blocked until it is fixed in DSH.
      secrets.push(...blockSecrets);
      continue;
    }
    const held = state.unmanaged.filter((entry) => newSecrets(profile, [entry], expected, false).length > 0);
    secrets.push(...newSecrets(profile, held, expected, false));
    const unmanaged = state.unmanaged.filter((entry) => !held.includes(entry));
    const dshChanged = unmanaged.length > 0 || (state.block !== null && !state.block.isDigestValid);
    if (!dshChanged) {
      continue;
    }
    const manifestChanged = state.block ? state.block.digest !== digestProfilePatches(expected) : expected.length > 0;
    if (manifestChanged && !prefer) {
      conflicts.push(profile);
      continue;
    }
    const from = manifestChanged && prefer === 'manifest' ? 'manifest' : 'dsh';
    const desired = from === 'manifest' ? expected : mergeDshPatches(state.block?.entries ?? [], unmanaged);
    reads.push({ profile, content, desired, expected, from, held });
  }
  return { reads, conflicts, secrets };
}

export function describeProfilePatchImport(expected: ProfilePatch[], desired: ProfilePatch[]): { added: string[]; changed: string[]; removed: string[] } {
  const keyed = (entries: ProfilePatch[]) => new Map(entries.map((entry) => [overrideKey(entry) ?? JSON.stringify(entry), entry]));
  const before = keyed(expected);
  const after = keyed(desired);
  return {
    added: desired.filter((entry) => !before.has(overrideKey(entry) ?? JSON.stringify(entry))).map(describeProfilePatch),
    changed: desired
      .filter((entry) => {
        const previous = before.get(overrideKey(entry) ?? JSON.stringify(entry));
        return previous !== undefined && !isDeepStrictEqual(previous, entry);
      })
      .map(describeProfilePatch),
    removed: expected.filter((entry) => !after.has(overrideKey(entry) ?? JSON.stringify(entry))).map(describeProfilePatch)
  };
}

// Rewrites the profile's block to the entries it now declares and drops the entries outside it; returns what it wrote.
export async function importProfilePatchFile(paths: EnvironmentPaths, read: ProfilePatchImport, entries: ProfilePatch[]): Promise<string> {
  let written = '';
  await rewriteProfilePatchFile(paths, read.profile, (current) => {
    if (current !== read.content) {
      throw new ValidationError(`cordis.patch.yml of ${describePatchTarget(read.profile)} changed during pull; run dshenv pull --yes again`);
    }
    const replaced = replaceProfileBlock(removeUnmanagedEntries(current), read.profile, entries);
    // Entries left out go after the block, as one may override an id an entry now in the block inserts.
    written = read.held.length > 0 ? appendBlocks(replaced, `${stringifyWithJs(read.held)}\n`) : replaced;
    return written;
  });
  return written;
}
