import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  EnvironmentLock,
  EnvironmentManifest,
  EnvironmentOverlay,
  EnvironmentState,
  ProfilePatch,
  SourceType
} from '../domain.js';
import { ValidationError, missingManifestError } from '../errors.js';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { hasInterpolation, loadLock, loadManifest, loadState, serializeLock, serializeManifest, serializeState, withResources } from '../manifest/files.js';
import { captureUnmanagedPlugins, freeAlias, pluginOwnershipRecord, withLinkDigest } from '../resources/plugin.js';
import { importSkill, ownedSkillDigests, planSkillImport, remoteSkillNames, skillOwnership, summarizeSkillImport, type SkillImportChanges } from '../resources/skill.js';
import { readOverlay } from '../overlay/effective.js';
import type { OverlaySource } from './adopt.js';
import { mergeManifest } from '../overlay/merge.js';
import { overlayFilePath, writeSelectionFile, type OverlaySelection } from '../overlay/selection.js';
import { saveOverlay, setOverlayPluginFields } from '../overlay/write.js';
import { readRemoteConfig } from '../remote/schema.js';
import { readLocalLock, remoteOwnedKey } from '../remote/ownership.js';
import { rewriteProfilePatchFile } from '../apply/patches.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withEnvironmentLock } from '../io/lock.js';
import { containsLocalPath, diffProfilePatches, localPatchEntries, mergeProfilePatches, overrideKey } from '../profile-patches/entries.js';
import {
  describeProfilePatchImport,
  importProfilePatchFile,
  planProfilePatchImport,
  type ProfilePatchImport
} from '../resources/profile-patch.js';

// The overlay pull creates for machine-local entries when none is selected.
export const LOCAL_OVERLAY = 'local';

export interface PullOptions {
  profiles?: string[];
  // When both sides changed since the last apply: which one wins.
  prefer?: 'dsh' | 'manifest';
  dryRun?: boolean;
  selection: OverlaySelection | null;
  // False under --no-overlay, where machine-local entries have no overlay to go to.
  allowOverlayCreation: boolean;
  // Loose skills in $DSH_HOME/skills are home-wide; false leaves them out.
  skills?: boolean;
  // False leaves plugins not in the manifest out, e.g. after adopt took only the ones its candidate lists;
  // profile -> packages takes only those.
  plugins?: boolean | Record<string, string[]>;
  // Machine-local paths adopt left out of the base for plugins it declares; set here in the overlay.
  overlaySources?: OverlaySource[];
}

export interface PluginPullChange {
  profile: string;
  alias: string;
  package: string;
  sourceType: SourceType;
  enabled: boolean;
  layer: 'base' | 'overlay';
  overlayName?: string;
}

export interface ProfilePullChange {
  profile: string;
  from: 'dsh' | 'manifest';
  added: string[];
  changed: string[];
  removed: string[];
  // Entries the profile now declares in the base manifest and in the overlay.
  base: number;
  overlay: number;
  overlayName?: string;
}

export interface PullResult {
  dryRun: boolean;
  changes: ProfilePullChange[];
  skills?: SkillImportChanges;
  plugins?: PluginPullChange[];
  // Plugins not in the manifest that could not be taken over, as capture reports them.
  warnings?: string[];
  overlayCreated?: string;
  operationId?: string;
  snapshotId?: string;
}

function effectivePatches(base: EnvironmentManifest, overlay: EnvironmentOverlay | null, name: string | null, profile: string): ProfilePatch[] {
  const manifest = overlay && name ? mergeManifest(base, overlay, name).manifest : base;
  return manifest.profiles[profile]?.patches ?? [];
}

function setBasePatches(manifest: EnvironmentManifest, profile: string, entries: ProfilePatch[]): void {
  const target = (manifest.profiles[profile] ??= { plugins: {} });
  if (entries.length > 0) {
    target.patches = entries;
  } else {
    delete target.patches;
  }
}

function setOverlayPatches(overlay: EnvironmentOverlay, profile: string, entries: ProfilePatch[]): void {
  const profiles = (overlay.profiles ??= {});
  const target = (profiles[profile] ??= {});
  if (entries.length > 0) {
    target.patches = entries;
  } else {
    delete target.patches;
  }
}

// With an overlay selected, the base takes only what DSH changed in entries the overlay leaves alone; the rest stays
// with the overlay, so what it removes, adds or overrides is not folded into the base every machine shares.
function pullBasePatches(base: ProfilePatch[], overlay: ProfilePatch[], effective: ProfilePatch[], desired: ProfilePatch[]): ProfilePatch[] {
  const overlayKeys = new Set(overlay.map(overrideKey).filter((key) => key !== undefined));
  const local = localPatchEntries(desired);
  const shared = (entry: ProfilePatch) => !local.includes(entry) && !containsLocalPath(entry);
  const result: ProfilePatch[] = [];
  for (const entry of base) {
    const key = overrideKey(entry);
    if (key !== undefined && overlayKeys.has(key)) {
      result.push(entry);
    } else if (desired.some((candidate) => isDeepStrictEqual(candidate, entry))) {
      if (shared(desired.find((candidate) => isDeepStrictEqual(candidate, entry))!)) result.push(entry);
    } else {
      const edited = key === undefined ? undefined : desired.find((candidate) => overrideKey(candidate) === key);
      if (edited && shared(edited)) result.push(edited);
    }
  }
  for (const entry of desired) {
    const key = overrideKey(entry);
    const known = effective.some((candidate) => isDeepStrictEqual(candidate, entry)) ||
      (key !== undefined && (overlayKeys.has(key) || base.some((candidate) => overrideKey(candidate) === key)));
    if (!known && shared(entry)) result.push(entry);
  }
  return result;
}

function sameEntries(left: ProfilePatch[], right: ProfilePatch[]): boolean {
  const unused = [...right];
  return left.length === right.length && left.every((entry) => {
    const index = unused.findIndex((candidate) => isDeepStrictEqual(candidate, entry));
    return index !== -1 && unused.splice(index, 1).length === 1;
  });
}

export async function pullProfilePatches(paths: EnvironmentPaths, options: PullOptions): Promise<PullResult> {
  return withEnvironmentLock(paths, () => pullUnderLock(paths, options));
}

async function pullUnderLock(paths: EnvironmentPaths, options: PullOptions): Promise<PullResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
  }
  const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const selectedName = options.selection?.name ?? null;
  const selectedOverlay = selectedName ? readOverlay(paths, selectedName) : null;
  const remote = readRemoteConfig(paths);
  const baseOwnedByRemote = remote !== null && remoteOwnedKey(paths, remote, paths.manifestFile) !== null;

  const inventory = await readEnvironmentInventory(paths);
  for (const profile of options.profiles ?? []) {
    if (!inventory.profiles[profile]) {
      throw new ValidationError(`Profile not found: ${profile}`);
    }
  }
  const profiles = options.profiles ?? Object.keys(inventory.profiles).sort();

  const { reads: allReads, conflicts } = await planProfilePatchImport(
    paths,
    profiles,
    (profile) => effectivePatches(base, selectedOverlay, selectedName, profile),
    options.prefer
  );
  // The manifest refuses ${...}; such a profile stays as DSH has it, so the rest of the pull still goes ahead.
  const interpolated = allReads.filter((read) => read.from === 'dsh' && hasInterpolation(JSON.stringify(read.desired)));
  const reads = allReads.filter((read) => !interpolated.includes(read));
  const patchWarnings = interpolated.map(
    (read) => `Patch entries of profile '${read.profile}' hold \${...}, which the manifest does not allow; left in its cordis.patch.yml, not pulled`
  );
  const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
  const skills = options.skills === false ? null : planSkillImport(inventory.skills ?? { declared: {}, live: {} }, ownedSkillDigests(state), options.prefer);
  const conflictNames = [
    ...(conflicts.length > 0 ? [`Profile patches of ${conflicts.join(', ')}`] : []),
    ...(skills && skills.conflicts.length > 0 ? [`skill ${skills.conflicts.join(', ')}`] : [])
  ];
  if (conflictNames.length > 0) {
    throw new ValidationError(
      `${conflictNames.join(' and ')} changed both in DSH and in the manifest since the last apply; ` +
        "pass --prefer dsh to keep DSH's version, or --prefer manifest to keep the manifest's"
    );
  }
  const remoteSkills = remoteSkillNames(remote?.files ?? {});
  for (const action of skills?.actions ?? []) {
    if (remoteSkills.has(action.name)) {
      throw new ValidationError(
        `Skill '${action.name}' is owned by remote ${remote!.url}; change it in the team repository, or run dshenv apply to restore the team copy`
      );
    }
  }

  const lock = readLocalLock(paths);
  const captured = options.plugins === false
    ? null
    : captureUnmanagedPlugins(
      inventory,
      profiles,
      selectedOverlay && selectedName ? mergeManifest(base, selectedOverlay, selectedName).manifest : base,
      lock,
      state,
      typeof options.plugins === 'object' ? options.plugins : undefined
    );

  const nextBase = structuredClone(base);
  let overlayName = selectedName;
  let nextOverlay = selectedOverlay ? structuredClone(selectedOverlay) : null;
  let overlayCreated: string | undefined;
  const overlayFor = (refusal: string): EnvironmentOverlay => {
    if (nextOverlay) {
      return nextOverlay;
    }
    if (!options.allowOverlayCreation) {
      throw new ValidationError(`${refusal} in an overlay; drop --no-overlay, or select one with dshenv overlay use <name>`);
    }
    overlayName = LOCAL_OVERLAY;
    nextOverlay = fs.existsSync(overlayFilePath(paths, LOCAL_OVERLAY))
      ? readOverlay(paths, LOCAL_OVERLAY)
      : { apiVersion: 'dshenv-overlay/v1' };
    overlayCreated = LOCAL_OVERLAY;
    return nextOverlay;
  };
  const counts = new Map<string, { base: number; overlay: number }>();
  for (const read of reads.filter((entry) => entry.from === 'dsh')) {
    const local = localPatchEntries(read.desired);
    const basePatches = base.profiles[read.profile]?.patches ?? [];
    const selectedPatches = selectedOverlay?.profiles?.[read.profile]?.patches;
    const baseEntries = baseOwnedByRemote
      ? basePatches
      : selectedPatches
        ? pullBasePatches(basePatches, selectedPatches, read.expected, read.desired)
        : read.desired.filter((entry) => !local.includes(entry));
    // An overlay that still yields what DSH has is kept as written, rather than rebuilt in another order.
    const overlayEntries = selectedPatches && sameEntries(mergeProfilePatches(baseEntries, selectedPatches), read.desired)
      ? selectedPatches
      : diffProfilePatches(baseEntries, read.desired);
    if (!baseOwnedByRemote) {
      setBasePatches(nextBase, read.profile, baseEntries);
    }
    if (overlayEntries.length > 0) {
      overlayFor(`Profile '${read.profile}' has patch entries with machine-local paths${baseOwnedByRemote ? ' or a team-owned base' : ''}, which belong`);
    }
    if (nextOverlay) {
      setOverlayPatches(nextOverlay, read.profile, overlayEntries);
    }
    counts.set(read.profile, { base: baseEntries.length, overlay: overlayEntries.length });
  }

  const operationId = `pull-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const nextLock: EnvironmentLock = structuredClone(lock ?? { apiVersion: 'dshenv-lock/v1', profiles: {} });
  const ownership = structuredClone(state?.resources?.plugin ?? {});
  const plugins: PluginPullChange[] = [];
  const pluginWarnings: string[] = [];
  for (const [profile, { plugins: capturedPlugins }] of Object.entries(captured?.manifest.profiles ?? {})) {
    for (const [capturedAlias, entry] of Object.entries(capturedPlugins)) {
      // Unmanaged only because the overlay removes it here; the base entry already describes it.
      const baseAlias = Object.entries(base.profiles[profile]?.plugins ?? {}).find(([, declared]) => declared.package === entry.package)?.[0];
      if (baseAlias !== undefined) {
        pluginWarnings.push(
          `Plugin '${entry.package}' of profile '${profile}' is in the base manifest as '${baseAlias}', which overlay '${selectedName}' removes; ` +
            `uninstall it with dsh, or drop the remove from the overlay`
        );
        continue;
      }
      const machineLocal = entry.source.type === 'local-link' || entry.source.type === 'local-file';
      const layer = machineLocal || baseOwnedByRemote ? 'overlay' : 'base';
      const overlay = layer === 'overlay'
        ? overlayFor(`Plugin '${entry.package}' of profile '${profile}' has ${machineLocal ? 'a machine-local path' : 'a team-owned base'}, which belongs`)
        : null;
      // An alias the lock or the team already holds would pin another package's entry onto this one.
      const alias = freeAlias(
        {
          ...nextBase.profiles[profile]?.plugins,
          // The selected overlay's aliases too: one it adds for another package would collide with this one when merged.
          ...(overlay ?? nextOverlay)?.profiles?.[profile]?.plugins,
          ...nextLock.profiles[profile]?.plugins,
          ...remote?.lockEntries[profile]
        },
        capturedAlias
      );
      if (overlay) {
        setOverlayPluginFields(overlay, profile, alias, { package: entry.package, enabled: entry.enabled, source: entry.source });
      } else {
        (nextBase.profiles[profile] ??= { plugins: {} }).plugins[alias] = entry;
      }
      const lockEntry = captured!.lock.profiles[profile]?.plugins[capturedAlias];
      if (lockEntry) {
        (nextLock.profiles[profile] ??= { plugins: {} }).plugins[alias] = await withLinkDigest(lockEntry, inventory.profiles[profile].plugins[entry.package]);
      }
      (ownership[profile] ??= {})[entry.package] = pluginOwnershipRecord(entry.package, alias, entry.source, now, operationId);
      plugins.push({
        profile,
        alias,
        package: entry.package,
        sourceType: entry.source.type,
        enabled: entry.enabled ?? true,
        layer,
        ...(overlay ? { overlayName: overlayName! } : {})
      });
    }
  }

  for (const local of options.overlaySources ?? []) {
    const overlay = overlayFor(`Plugin '${local.package}' of profile '${local.profile}' has a machine-local path, which belongs`);
    setOverlayPluginFields(overlay, local.profile, local.alias, { source: local.source });
    if (local.lock) {
      (nextLock.profiles[local.profile] ??= { plugins: {} }).plugins[local.alias] =
        await withLinkDigest(local.lock, inventory.profiles[local.profile]?.plugins[local.package]);
    }
    (ownership[local.profile] ??= {})[local.package] = pluginOwnershipRecord(local.package, local.alias, local.source, now, operationId);
    plugins.push({
      profile: local.profile,
      alias: local.alias,
      package: local.package,
      sourceType: local.source.type,
      enabled: nextBase.profiles[local.profile]?.plugins[local.alias]?.enabled ?? true,
      layer: 'overlay',
      overlayName: overlayName!
    });
  }

  // Validates both files the way every later command will load them.
  loadManifest(serializeManifest(nextBase));
  loadLock(serializeLock(nextLock));
  const merged = nextOverlay && overlayName ? mergeManifest(nextBase, nextOverlay, overlayName).manifest : nextBase;

  const changes: ProfilePullChange[] = reads.map((read) => ({
    profile: read.profile,
    from: read.from,
    ...describeProfilePatchImport(read.expected, read.desired),
    base: counts.get(read.profile)?.base ?? (nextBase.profiles[read.profile]?.patches ?? []).length,
    overlay: counts.get(read.profile)?.overlay ?? (nextOverlay?.profiles?.[read.profile]?.patches ?? []).length,
    ...(overlayName ? { overlayName } : {})
  }));
  const warnings = [...patchWarnings, ...pluginWarnings, ...(captured?.warnings ?? [])];
  const skillChanges = skills && skills.actions.length > 0 ? summarizeSkillImport(skills.actions) : undefined;
  const reported = {
    changes,
    ...(skillChanges ? { skills: skillChanges } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(overlayCreated ? { overlayCreated } : {})
  };
  if (options.dryRun || (reads.length === 0 && !skillChanges && plugins.length === 0)) {
    return { dryRun: Boolean(options.dryRun), ...reported };
  }

  const snapshot = await createEnvironmentSnapshot(paths, operationId, {
    overlayKeys: overlayName ? [`overlays/${overlayName}.yaml`] : []
  });
  const selectionBefore = fs.existsSync(paths.overlaySelectionFile) ? fs.readFileSync(paths.overlaySelectionFile) : null;
  // Snapshots hold only envctl files, so patch files already rewritten are put back from what was read.
  const rewritten: { read: ProfilePatchImport; written: string }[] = [];
  try {
    if (!isDeepStrictEqual(nextBase, base)) {
      await writeAtomic(paths.manifestFile, serializeManifest(nextBase), 'overwrite');
    }
    if (nextOverlay && overlayName && !isDeepStrictEqual(nextOverlay, selectedOverlay)) {
      await saveOverlay(paths, overlayName, nextBase, nextOverlay);
    }
    if (overlayCreated && !selectedName) {
      await writeSelectionFile(paths, overlayCreated);
    }
    for (const action of skills?.actions ?? []) {
      await importSkill(paths, action, operationId);
    }
    if (plugins.length > 0) {
      await writeAtomic(paths.lockFile, serializeLock(nextLock), 'overwrite');
    }
    if ((skills && skills.actions.length > 0) || plugins.length > 0) {
      const base: EnvironmentState = state ?? { apiVersion: 'dshenv-state/v1', lastApplied: now, appliedLockHash: '', profiles: {} };
      const skill = skills && skills.actions.length > 0 ? skillOwnership(skills.owned) : base.resources?.skill;
      await writeAtomic(paths.stateFile, serializeState(withResources(base, { plugin: ownership, skill })), 'overwrite');
    }
    for (const read of reads) {
      rewritten.push({ read, written: await importProfilePatchFile(paths, read, merged.profiles[read.profile]?.patches ?? []) });
    }
  } catch (err) {
    // DSH may have edited a rewritten file since; its edits win over the undo.
    for (const { read, written } of rewritten) {
      await rewriteProfilePatchFile(paths, read.profile, (current) => (current === written ? read.content : current)).catch(() => {});
    }
    await restoreEnvironmentSnapshot(snapshot, paths).catch(() => {});
    await (selectionBefore ? writeAtomic(paths.overlaySelectionFile, selectionBefore, 'overwrite') : writeSelectionFile(paths, null)).catch(() => {});
    throw err;
  }
  await appendJournalEntry(paths, {
    operationId,
    type: 'pull-completed',
    timestamp: new Date().toISOString(),
    details: { profiles: reads.map((read) => read.profile), plugins: plugins.map((plugin) => `${plugin.profile}/${plugin.alias}`) }
  });
  return {
    dryRun: false,
    ...reported,
    operationId,
    snapshotId: snapshot.snapshotId
  };
}
