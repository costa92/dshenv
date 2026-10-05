import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  CaptureDocument,
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentOverlay,
  EnvironmentState,
  PluginLockEntry,
  PluginOwnershipRecord,
  PluginSource
} from '../domain.js';
import { readEnvironmentInventory, type EnvironmentInventory } from '../inventory/profile-reader.js';
import { captureEnvironment } from './capture.js';
import {
  serializeManifest,
  serializeLock,
  serializeState,
  withResources,
  loadManifest,
  loadLock,
  loadState
} from '../manifest/files.js';
import { writeAtomic } from '../io/atomic-file.js';
import { ValidationError } from '../errors.js';
import { withEnvironmentLock } from '../io/lock.js';
import { freeAlias, isSameCommit, pluginOwnershipRecord } from '../resources/plugin.js';

export interface AdoptDetail {
  profile: string;
  alias: string;
  package: string;
  sourceType: string;
  version?: string;
  // Declared, locked and owned exactly as the candidate has it already, so adopting it again changes nothing.
  alreadyAdopted: boolean;
  // A machine-local source stays out of the base; pull takes it into an overlay, as it does any other.
  layer?: 'overlay';
}

// A plugin the base declares that DSH has from a machine-local path here: the base stays, pull sets the path in an overlay.
export interface OverlaySource {
  profile: string;
  alias: string;
  package: string;
  source: PluginSource;
  lock?: PluginLockEntry;
}

export interface AdoptSummary {
  adoptedCount: number;
  profiles: string[];
  details: AdoptDetail[];
  overlaySources: OverlaySource[];
  operationId: string;
}

// A lock entry capture writes has no digest; apply recorded the one of what it installed, which still holds.
function keepDigest(current: PluginLockEntry | undefined, captured: PluginLockEntry): PluginLockEntry {
  if (!current || (current.source.type !== 'local-link' && current.source.type !== 'local-file')) {
    return captured;
  }
  const { digest: _digest, ...source } = current.source;
  return isDeepStrictEqual({ ...current, source }, captured) ? current : captured;
}

export function checkCandidateFreshness(
  candidate: CaptureDocument,
  inventory: EnvironmentInventory
): void {
  for (const [profileName, profileManifest] of Object.entries(candidate.manifest.profiles)) {
    const liveProfile = inventory.profiles[profileName];
    if (!liveProfile) {
      throw new ValidationError(`Candidate refers to profile "${profileName}" which does not exist in live environment`);
    }
    // What capture would write now; the candidate must still say the same about each source.
    const live = captureEnvironment(inventory, { profile: profileName });
    const liveEntries = Object.values(live.manifest.profiles[profileName]?.plugins ?? {});
    const liveLockEntries = Object.values(live.lock.profiles[profileName]?.plugins ?? {});
    const candidateLock = candidate.lock.profiles[profileName]?.plugins ?? {};

    for (const [alias, plugin] of Object.entries(profileManifest.plugins)) {
      const livePlugin = liveProfile.plugins[plugin.package];
      if (!livePlugin || !livePlugin.installed) {
        throw new ValidationError(
          `Candidate is stale: package "${plugin.package}" in profile "${profileName}" is not currently installed in live environment`
        );
      }

      if (plugin.source.type === 'npm' && plugin.source.version && livePlugin.version) {
        if (plugin.source.version !== livePlugin.version) {
          throw new ValidationError(
            `Candidate is stale: package "${plugin.package}" version in candidate (${plugin.source.version}) does not match live installation (${livePlugin.version})`
          );
        }
      }

      const liveSource = liveEntries.find((entry) => entry.package === plugin.package)?.source;
      const liveLockSource = liveLockEntries.find((entry) => entry.package === plugin.package)?.source;
      const lockSource = candidateLock[alias]?.source;
      const lockCommit = lockSource?.type === 'git' ? lockSource.commit : undefined;
      const liveCommit = liveLockSource?.type === 'git' ? liveLockSource.commit : undefined;
      if (!liveSource || !isDeepStrictEqual(plugin.source, liveSource) || (lockCommit !== undefined && lockCommit !== liveCommit)) {
        throw new ValidationError(
          `Candidate is stale: package "${plugin.package}" in profile "${profileName}" is installed from a different source than the candidate records; capture again`
        );
      }
    }
  }
}

// Adopt rewrites these files wholesale, so an unreadable one must stop it rather than be replaced.
function readExisting<T>(kind: string, file: string, load: (content: string) => T): T {
  try {
    return load(fs.readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Cannot adopt: the existing ${kind} ${file} is invalid (${message}); fix or move it first`);
  }
}

export interface AdoptOptions {
  // Runs before anything is written; lets callers reject a base that an active overlay cannot merge onto.
  validateManifest?: (manifest: EnvironmentManifest) => void;
  // Works out what would be adopted and writes nothing.
  dryRun?: boolean;
  // The active overlay: a plugin it declares is managed there already and stays out of the base.
  overlay?: EnvironmentOverlay;
  // False when machine-local plugins would have no overlay to go to (--no-overlay with none selected).
  allowOverlay?: boolean;
}

export async function adoptEnvironment(
  paths: EnvironmentPaths,
  candidate: CaptureDocument,
  options?: AdoptOptions
): Promise<AdoptSummary> {
  // Adopt rewrites manifest, lock and state from what it reads, so nothing may change them in between.
  return withEnvironmentLock(paths, () => adoptUnderLock(paths, candidate, options));
}

async function adoptUnderLock(
  paths: EnvironmentPaths,
  candidate: CaptureDocument,
  options?: AdoptOptions
): Promise<AdoptSummary> {
  const inventory = await readEnvironmentInventory(paths);
  checkCandidateFreshness(candidate, inventory);

  const operationId = `adopt-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  let existingManifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    profiles: {}
  };
  let existingLock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: {}
  };
  let existingState: EnvironmentState = {
    apiVersion: 'dshenv-state/v1',
    lastApplied: now,
    appliedLockHash: '',
    profiles: {}
  };

  if (fs.existsSync(paths.manifestFile)) {
    existingManifest = readExisting('manifest', paths.manifestFile, loadManifest);
  }
  if (fs.existsSync(paths.lockFile)) {
    existingLock = readExisting('lock', paths.lockFile, loadLock);
  }
  if (fs.existsSync(paths.stateFile)) {
    existingState = readExisting('state', paths.stateFile, loadState);
  }

  const mergedManifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    environment: candidate.manifest.environment ?? existingManifest.environment,
    profiles: { ...existingManifest.profiles }
  };

  const mergedLock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: { ...existingLock.profiles }
  };

  const ownership: Record<string, Record<string, PluginOwnershipRecord>> = {
    ...(existingState.resources?.plugin ?? {})
  };

  const details: AdoptDetail[] = [];
  const overlaySources: OverlaySource[] = [];
  const profilesSet = new Set<string>();

  for (const [profileName, candProf] of Object.entries(candidate.manifest.profiles)) {
    profilesSet.add(profileName);
    if (!mergedManifest.profiles[profileName]) {
      mergedManifest.profiles[profileName] = { plugins: {} };
    }
    if (!mergedLock.profiles[profileName]) {
      mergedLock.profiles[profileName] = { plugins: {} };
    }
    if (!ownership[profileName]) {
      ownership[profileName] = {};
    }

    const candLockProf = candidate.lock.profiles[profileName]?.plugins ?? {};

    for (const [candidateAlias, plugin] of Object.entries(candProf.plugins)) {
      const overlayAlias = Object.entries(options?.overlay?.profiles?.[profileName]?.plugins ?? {})
        .find(([, entry]) => entry.package === plugin.package && !entry.remove)?.[0];
      if (overlayAlias !== undefined) {
        details.push({ profile: profileName, alias: overlayAlias, package: plugin.package, sourceType: plugin.source.type, alreadyAdopted: true });
        continue;
      }
      // Capture derives its own alias; keep the one the manifest already uses for this package.
      const existingAlias = Object.entries(mergedManifest.profiles[profileName].plugins)
        .find(([, entry]) => entry.package === plugin.package)?.[0];
      // What DSH has installed there is what the overlay says, not what the base says.
      if (existingAlias !== undefined && Object.hasOwn(options?.overlay?.profiles?.[profileName]?.plugins ?? {}, existingAlias)) {
        details.push({ profile: profileName, alias: existingAlias, package: plugin.package, sourceType: plugin.source.type, alreadyAdopted: true });
        continue;
      }
      const existingEntry = existingAlias ? mergedManifest.profiles[profileName].plugins[existingAlias] : undefined;
      // A base that already declares this very path keeps it; any other machine-local path goes to an overlay.
      if ((plugin.source.type === 'local-link' || plugin.source.type === 'local-file') && !isDeepStrictEqual(existingEntry?.source, plugin.source)) {
        if (options?.allowOverlay === false) {
          throw new ValidationError(
            `Plugin '${plugin.package}' of profile '${profileName}' has a machine-local path, which belongs in an overlay; drop --no-overlay, or select one with dshenv overlay use <name>`
          );
        }
        if (existingAlias !== undefined) {
          const lock = candLockProf[candidateAlias];
          overlaySources.push({ profile: profileName, alias: existingAlias, package: plugin.package, source: plugin.source, ...(lock ? { lock } : {}) });
        }
        details.push({ profile: profileName, alias: existingAlias ?? candidateAlias, package: plugin.package, sourceType: plugin.source.type, alreadyAdopted: false, layer: 'overlay' });
        continue;
      }
      // An alias the active overlay adds for another package would make the two collide when merged.
      const alias = existingAlias ?? freeAlias(
        { ...mergedManifest.profiles[profileName].plugins, ...options?.overlay?.profiles?.[profileName]?.plugins },
        candidateAlias
      );
      // Capture cannot see declared patches, so a candidate without any must not erase them.
      const existingPatches = existingEntry?.patches;
      const withPatches = plugin.patches === undefined && existingPatches ? { ...plugin, patches: existingPatches } : plugin;
      // Capture reads only the URL of a git install, so the ref or commit the base pins stays, moved to what is installed.
      const capturedCommit = candLockProf[candidateAlias]?.source;
      const pinned = existingEntry?.source.type === 'git' && plugin.source.type === 'git' && existingEntry.source.url === plugin.source.url
        ? existingEntry.source
        : undefined;
      const liveCommit = capturedCommit?.type === 'git' ? capturedCommit.commit : undefined;
      const entry = pinned
        ? {
            ...withPatches,
            source: pinned.commit !== undefined && liveCommit !== undefined && !isSameCommit(pinned.commit, liveCommit) ? { ...pinned, commit: liveCommit } : pinned
          }
        : withPatches;
      mergedManifest.profiles[profileName].plugins[alias] = entry;

      const capturedLock = candLockProf[candidateAlias];
      const lockEntry = capturedLock && keepDigest(mergedLock.profiles[profileName].plugins[alias], capturedLock);
      const alreadyAdopted =
        existingEntry !== undefined &&
        isDeepStrictEqual(existingEntry, entry) &&
        (!lockEntry || isDeepStrictEqual(mergedLock.profiles[profileName].plugins[alias], lockEntry)) &&
        existingState.resources?.plugin?.[profileName]?.[plugin.package]?.alias === alias;
      if (lockEntry) {
        mergedLock.profiles[profileName].plugins[alias] = lockEntry;
      }

      const record = pluginOwnershipRecord(plugin.package, alias, plugin.source, now, operationId);
      ownership[profileName][plugin.package] = record;

      details.push({
        profile: profileName,
        alias,
        package: plugin.package,
        sourceType: plugin.source.type,
        version: record.lockedVersion,
        alreadyAdopted
      });
    }
    // A profile only the overlay declares plugins for gains no empty entry in the base.
    if (!existingManifest.profiles[profileName] && Object.keys(mergedManifest.profiles[profileName].plugins).length === 0) {
      delete mergedManifest.profiles[profileName];
      delete mergedLock.profiles[profileName];
      delete ownership[profileName];
    }
  }

  const lockSerialized = serializeLock(mergedLock);
  const lockHash = crypto.createHash('sha256').update(lockSerialized).digest('hex');

  const nextState = withResources(
    {
      apiVersion: 'dshenv-state/v1',
      lastApplied: now,
      appliedLockHash: lockHash,
      profiles: existingState.profiles ?? {},
      ...(existingState.appliedOverlay ? { appliedOverlay: existingState.appliedOverlay } : {}),
      ...(existingState.resources ? { resources: existingState.resources } : {})
    },
    { plugin: ownership }
  );

  options?.validateManifest?.(mergedManifest);
  if (options?.dryRun) {
    return { adoptedCount: details.length, profiles: Array.from(profilesSet), details, overlaySources, operationId };
  }

  // Each write is atomic but the three together are not, so a failure puts back the files already written.
  const writes: Array<[string, string]> = [
    [paths.manifestFile, serializeManifest(mergedManifest)],
    [paths.lockFile, lockSerialized],
    [paths.stateFile, serializeState(nextState)]
  ];
  const originals = writes.map(([file]) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
  let written = 0;
  try {
    for (const [file, content] of writes) {
      await writeAtomic(file, content, 'overwrite');
      written++;
    }
  } catch (err) {
    for (let index = written - 1; index >= 0; index--) {
      const original = originals[index];
      await (original ? writeAtomic(writes[index][0], original, 'overwrite') : fs.promises.rm(writes[index][0], { force: true })).catch(() => {});
    }
    throw err;
  }

  return {
    adoptedCount: details.length,
    profiles: Array.from(profilesSet),
    details,
    overlaySources,
    operationId
  };
}
