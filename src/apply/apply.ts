import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState,
  PluginOwnership
} from '../domain.js';
import { readEnvironmentInventory, type EnvironmentInventory } from '../inventory/profile-reader.js';
import { buildPlan, isProfileOperation, onlyProfile, type EnvironmentPlan, type LocalSourceDigests, type PluginOperation } from '../planner/plan.js';
import { applyPluginOperation, dropUninstalledOwnership, planNeedsDshCli, pluginOwnershipRecord, type PluginStepContext } from '../resources/plugin.js';
import { applyProfilePatchOperation } from '../resources/profile-patch.js';
import { loadLock, loadManifest, loadState, parseOverlay, serializeState, serializeLock, withResources } from '../manifest/files.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { assertNotInterrupted, stopOnInterrupt } from '../io/interrupt.js';
import { createEnvironmentSnapshot, restoreSnapshotFiles, type EnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { lastSuccessfulApply } from '../rollback/rollback.js';
import { writeAtomic } from '../io/atomic-file.js';
import { readLocalSourceDigests } from '../source/local.js';
import { DshError, ValidationError, DegradedError, CapabilityError, missingManifestError } from '../errors.js';
import { probeDsh, resolveDshCommand, type CommandSpec } from '../dsh/command.js';
import { unsupportedDshVersionMessage } from '../dsh/version.js';
import { capabilitiesFor } from '../dsh/capabilities.js';
import { probeProfileHmr, type HmrStatus } from '../dsh/hmr.js';
import { readRemoteConfig } from '../remote/schema.js';
import { lockEntryId } from '../remote/lock-entries.js';
import { applySkillOperation, ownedSkillDigests, skillOwnership } from '../resources/skill.js';
import { buildRestartSummary, profilesToProbe, type RestartSummary } from './restart-plan.js';

// Longer than the ~2 s awaitWriteFinish window of DSH's HMR watcher, so it unloads the plugin before its files go.
export const HMR_SETTLE_MS = 3000;
// A hung package install would otherwise hold the environment lock forever.
export const DSH_COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface ApplyOptions {
  dryRun?: boolean;
  allowUntested?: boolean;
  harnessSource?: string;
  overlay?: OverlaySelection | null;
  // Only this profile's plugins and patches; skills are home-wide and still apply. Other profiles keep their state.
  profile?: string;
  executor?: (plan: EnvironmentPlan, paths: EnvironmentPaths) => Promise<{ success: boolean; error?: string }>;
  probeHmr?: (profile: string) => Promise<HmrStatus>;
  hmrSettleMs?: number;
  dshCommandTimeoutMs?: number;
}

export interface ApplyResult {
  applied: boolean;
  dryRun: boolean;
  operationId?: string;
  plan: EnvironmentPlan;
  message?: string;
  snapshotId?: string;
  restart?: RestartSummary;
}

export interface ProfileRollback {
  // dshenv's own profile edits, undone in reverse order when apply fails.
  undo: Array<() => Promise<void>>;
  // Re-run after undo: edits that belong to a DSH change which cannot be reverted.
  keep: Array<() => Promise<void>>;
}

function dshCommandFor(manifest: EnvironmentManifest, options?: ApplyOptions): CommandSpec | null {
  return resolveDshCommand({
    cliHarnessSource: options?.harnessSource,
    manifestHarnessSource: manifest.environment?.harness?.sourceDir
  });
}

async function assertSupportedDsh(
  command: CommandSpec,
  manifest: EnvironmentManifest,
  options?: ApplyOptions,
  { tolerateProbeFailure = false } = {}
): Promise<void> {
  let probe: Awaited<ReturnType<typeof probeDsh>>;
  try {
    probe = await probeDsh(command);
  } catch (err) {
    if (tolerateProbeFailure) {
      return;
    }
    throw err;
  }
  const caps = capabilitiesFor(probe.version, {
    allowUntested: options?.allowUntested || manifest.environment?.harness?.allowUntestedVersion
  });
  if (caps.discovery.status !== 'available') {
    throw new CapabilityError(unsupportedDshVersionMessage(probe.version));
  }
}

async function executeWithDsh(
  plan: EnvironmentPlan,
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  lock: EnvironmentLock | null,
  inventory: EnvironmentInventory,
  rollback: ProfileRollback,
  hmrByProfile: ReadonlyMap<string, HmrStatus>,
  onInstalled: (operation: PluginOperation) => Promise<void>,
  signal: AbortSignal | undefined,
  command: CommandSpec | null,
  options?: ApplyOptions
): Promise<{ success: boolean; error?: string; failedAt?: string }> {
  assertSupportedPlan(plan);

  const ctx: PluginStepContext = {
    paths,
    manifest,
    lock,
    inventory,
    rollback,
    hmrByProfile,
    onInstalled,
    signal,
    command,
    commandTimeoutMs: options?.dshCommandTimeoutMs ?? DSH_COMMAND_TIMEOUT_MS,
    hmrSettleMs: options?.hmrSettleMs ?? HMR_SETTLE_MS
  };
  // Skills are home-wide and written after every profile has converged.
  const steps = plan.operations.filter(isProfileOperation);
  for (const [index, operation] of steps.entries()) {
    assertNotInterrupted(signal);
    if (operation.resource === 'profile-patch') {
      rollback.undo.push(await applyProfilePatchOperation(paths, manifest, operation));
      continue;
    }
    const error = await applyPluginOperation(operation, ctx);
    if (error) {
      const failedAt = `[${operation.profile}] ${operation.kind} ${operation.alias} (${operation.package}), step ${index + 1} of ${steps.length}`;
      return { success: false, error, failedAt };
    }
  }

  return { success: true };
}

function recordRestartState(
  profiles: EnvironmentState['profiles'] | undefined,
  plan: EnvironmentPlan,
  verifiedInventory: EnvironmentInventory,
  timestamp: string,
  restart: RestartSummary
): EnvironmentState['profiles'] {
  const next: EnvironmentState['profiles'] = {};
  for (const [profileName, profile] of Object.entries(profiles ?? {})) {
    next[profileName] = { plugins: { ...profile.plugins } };
  }
  const restartRequired = new Set(restart.required.map((item) => `${item.profile}\0${item.package}`));
  for (const operation of plan.operations) {
    if (
      operation.resource !== 'plugin' ||
      (operation.kind !== 'install' &&
        operation.kind !== 'update' &&
        operation.kind !== 'enable' &&
        operation.kind !== 'disable' &&
        operation.kind !== 'remove')
    ) {
      continue;
    }
    if (!next[operation.profile]) {
      next[operation.profile] = { plugins: {} };
    }
    const plugins = next[operation.profile].plugins;
    const needsRestart = restartRequired.has(`${operation.profile}\0${operation.package}`);
    if (!needsRestart && operation.kind === 'remove') {
      delete plugins[operation.package];
      continue;
    }
    // A hot-reloaded change must not clear a restart an earlier apply still owes.
    const pending = plugins[operation.package]?.status === 'restart-required';
    const installedVersion = verifiedInventory.profiles[operation.profile]?.plugins[operation.package]?.version;
    plugins[operation.package] = {
      package: operation.package,
      status: needsRestart || pending ? 'restart-required' : 'healthy',
      ...(installedVersion ? { installedVersion } : {}),
      lastVerified: timestamp
    };
  }
  return next;
}

// Record the source digest each local plugin was installed from, so plan can detect later edits.
function recordLocalDigests(
  lock: EnvironmentLock | null,
  manifest: EnvironmentManifest,
  digests: LocalSourceDigests
): EnvironmentLock | null {
  let next = lock;
  for (const [profileName, aliases] of Object.entries(digests)) {
    for (const [alias, digest] of Object.entries(aliases)) {
      const plugin = manifest.profiles[profileName]?.plugins[alias];
      if (!plugin || (plugin.source.type !== 'local-file' && plugin.source.type !== 'local-link')) {
        continue;
      }
      const entry = { package: plugin.package, source: { type: plugin.source.type, path: plugin.source.path, digest } };
      if (JSON.stringify(next?.profiles[profileName]?.plugins[alias]) === JSON.stringify(entry)) {
        continue;
      }
      next = structuredClone(next ?? { apiVersion: 'dshenv-lock/v1', profiles: {} });
      (next.profiles[profileName] ??= { plugins: {} }).plugins[alias] = entry;
    }
  }
  return next;
}

// An entry for an alias no layer declares any more would pin the plugin re-added under it to the commit it had then.
// The lock serves every overlay, so an alias any overlay still declares keeps its entry, as does a team entry.
function dropUndeclaredLockEntries(paths: EnvironmentPaths, lock: EnvironmentLock | null, onlyProfileName?: string): EnvironmentLock | null {
  if (!lock) {
    return lock;
  }
  const declared = new Set<string>();
  try {
    const layers: Array<{ profiles?: Record<string, { plugins?: Record<string, unknown> }> }> = [loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'))];
    for (const name of fs.existsSync(paths.overlaysDir) ? fs.readdirSync(paths.overlaysDir) : []) {
      if (name.endsWith('.yaml')) {
        const file = path.join(paths.overlaysDir, name);
        layers.push(parseOverlay(fs.readFileSync(file, 'utf8'), file));
      }
    }
    for (const layer of layers) {
      for (const [profile, { plugins }] of Object.entries(layer.profiles ?? {})) {
        for (const alias of Object.keys(plugins ?? {})) declared.add(lockEntryId(profile, alias));
      }
    }
  } catch {
    // A layer that cannot be read may declare anything; keep every entry.
    return lock;
  }
  const team = readRemoteConfig(paths)?.lockEntries ?? {};
  let next = lock;
  for (const [profile, { plugins }] of Object.entries(lock.profiles)) {
    if (onlyProfileName && profile !== onlyProfileName) continue;
    for (const alias of Object.keys(plugins)) {
      if (declared.has(lockEntryId(profile, alias)) || team[profile]?.[alias] !== undefined) continue;
      if (next === lock) next = structuredClone(lock);
      delete next.profiles[profile].plugins[alias];
    }
  }
  return next;
}

// A local entry written over a team entry would be reported as a local change by every later sync.
function assertNoTeamEntryOverwritten(
  paths: EnvironmentPaths,
  lock: EnvironmentLock | null,
  nextLock: EnvironmentLock | null
): void {
  if (!nextLock || nextLock === lock) {
    return;
  }
  const config = readRemoteConfig(paths);
  if (!config) {
    return;
  }
  for (const [profileName, { plugins }] of Object.entries(nextLock.profiles)) {
    for (const [alias, entry] of Object.entries(plugins)) {
      if (!config.lockEntries[profileName]?.[alias]) {
        continue;
      }
      if (JSON.stringify(lock?.profiles[profileName]?.plugins[alias]) === JSON.stringify(entry)) {
        continue;
      }
      throw new ValidationError(
        `Lock entry '${lockEntryId(profileName, alias)}' is pinned by the team lock of remote ${config.url}; ` +
          'a local overlay cannot switch it to a local source. ' +
          'Disable it with remove: true in the overlay and add the local plugin under a new alias'
      );
    }
  }
}

// A plugin apply installed, or replaced with the declared version, is dshenv's to remove once the manifest drops it,
// as if it had been adopted.
function recordInstalledOwnership(
  pruned: PluginOwnership | undefined,
  operations: EnvironmentPlan['operations'],
  manifest: EnvironmentManifest,
  now: string,
  operationId: string
): PluginOwnership {
  const ownership = { ...pruned };
  for (const operation of operations) {
    if (operation.resource !== 'plugin') {
      continue;
    }
    const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
    if ((operation.kind !== 'install' && operation.kind !== 'update') || !plugin) {
      continue;
    }
    const record = pluginOwnershipRecord(plugin.package, operation.alias, plugin.source, now, operationId);
    // An owned plugin keeps when it was first owned; what it now runs follows the manifest.
    const owned = ownership[operation.profile]?.[plugin.package];
    ownership[operation.profile] = {
      ...ownership[operation.profile],
      [plugin.package]: owned ? { ...record, adoptedAt: owned.adoptedAt, adoptedBy: owned.adoptedBy } : record
    };
  }
  return ownership;
}

function pruneOwnership(
  ownership: PluginOwnership | undefined,
  manifest: EnvironmentManifest,
  onlyProfileName?: string
): PluginOwnership {
  if (!ownership) {
    return {};
  }

  const next: PluginOwnership = {};
  for (const [profileName, packages] of Object.entries(ownership)) {
    // A profile outside the applied one was not planned, so its records still name what a later apply must remove.
    if (onlyProfileName !== undefined && profileName !== onlyProfileName) {
      next[profileName] = packages;
      continue;
    }
    const expected = new Set(
      Object.values(manifest.profiles[profileName]?.plugins ?? {}).map((plugin) => plugin.package)
    );
    const kept: Record<string, (typeof packages)[string]> = {};
    for (const [packageName, record] of Object.entries(packages)) {
      if (expected.has(packageName)) {
        kept[packageName] = record;
      }
    }
    if (Object.keys(kept).length > 0) {
      next[profileName] = kept;
    }
  }
  return next;
}

function defaultHmrProbe(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  options?: ApplyOptions
): (profile: string) => Promise<HmrStatus> {
  const command = resolveDshCommand({
    cliHarnessSource: options?.harnessSource,
    manifestHarnessSource: manifest.environment?.harness?.sourceDir
  });
  return async (profile) => {
    // dsh --dump-config creates a missing profile, which a dry run must not do.
    if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
      return { state: 'unknown', reason: `profile ${profile} does not exist yet` };
    }
    return probeProfileHmr(profile, { command, dshHome: paths.home });
  };
}

function assertSupportedPlan(plan: EnvironmentPlan): void {
  const blocked = plan.operations.filter(isProfileOperation).find((operation) => operation.kind === 'blocked');
  if (blocked) {
    throw new DegradedError(
      `Apply is blocked: ${blocked.blockedReason ?? blocked.reason}`
    );
  }

  const unsupported = plan.operations.find(
    (operation) =>
      operation.kind !== 'install' &&
      operation.kind !== 'update' &&
      operation.kind !== 'enable' &&
      operation.kind !== 'disable' &&
      operation.kind !== 'remove' &&
      operation.kind !== 'configure'
  );
  if (unsupported) {
    throw new CapabilityError(
      `Apply operation '${unsupported.kind}' is not supported by the DSH CLI adapter`
    );
  }
}

// What a failed step left behind and the way back, since the manifest keeps declaring the change that failed.
async function recoveryHint(paths: EnvironmentPaths, operationId: string, installed: PluginOperation[]): Promise<string> {
  const kept = installed.length > 0 ? `; plugins it installed before failing stay installed: ${installed.map((op) => op.alias).join(', ')}` : '';
  const lines = [`Apply ${operationId} put lock.json and state.json back${kept}.`];
  // Only a pointer onward; a lookup failure must not read as a failed restore.
  const previous = await lastSuccessfulApply(paths).catch(() => null);
  lines.push(
    previous
      ? `The manifest still declares what failed: fix it and apply again, or go back to the manifest apply ${previous} applied (dropping every manifest change made since) with: dshenv rollback ${previous} --yes`
      : 'The manifest still declares what failed: fix it and apply again.'
  );
  return `\n${lines.join('\n')}`;
}

export async function applyEnvironment(
  paths: EnvironmentPaths,
  options?: ApplyOptions
): Promise<ApplyResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
  }

  if (options?.dryRun) {
    return planAndApply(paths, options);
  }
  // Plan only after locking so rollback/purge cannot change the files between plan and execution.
  const lockHandle = await acquireEnvironmentLock(paths);
  // On Ctrl-C, apply stops DSH and rolls back through its failure path; the interrupt waits for that and the lock release.
  const interrupt = new AbortController();
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  const dispose = stopOnInterrupt(async () => {
    interrupt.abort();
    await done;
  });
  let outcome: { result: ApplyResult } | { error: unknown };
  try {
    outcome = { result: await planAndApply(paths, options, interrupt.signal) };
  } catch (error) {
    outcome = { error };
  } finally {
    await lockHandle.release();
    dispose();
    settled();
  }
  if (interrupt.signal.aborted) {
    // The signal ends dshenv once the cleanup above returns; reporting the rollback as a failure would only race it.
    await new Promise(() => {});
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.result;
}

async function planAndApply(
  paths: EnvironmentPaths,
  options?: ApplyOptions,
  signal?: AbortSignal
): Promise<ApplyResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
  }

  // Loaded after the environment lock is held (see applyEnvironment), so the overlay cannot change mid-apply.
  const manifest = onlyProfile(loadEffectiveManifest(paths, options?.overlay ?? null).manifest, options?.profile);
  const lock = fs.existsSync(paths.lockFile)
    ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
    : null;
  const state = fs.existsSync(paths.stateFile)
    ? loadState(fs.readFileSync(paths.stateFile, 'utf8'))
    : null;

  const inventory = onlyProfile(await readEnvironmentInventory(paths), options?.profile);
  const localDigests = await readLocalSourceDigests(manifest);
  const plan = buildPlan(manifest, lock, inventory, state, localDigests);

  if (!plan.hasChanges) {
    // Record the overlay and skill baselines even without operations, otherwise the switch warning never clears
    // and a declared skill DSH already had is never owned.
    const skills = inventory.skills?.declared ?? {};
    const plugin = dropUninstalledOwnership(state?.resources?.plugin, inventory);
    // Without a state.json yet (a first apply on a machine that already matches), there is still something to record
    // when an overlay is active or DSH already has declared skills.
    const current: EnvironmentState = state ?? { apiVersion: 'dshenv-state/v1', lastApplied: new Date().toISOString(), appliedLockHash: '', profiles: {} };
    if (
      !options?.dryRun &&
      (current.appliedOverlay !== options?.overlay?.name ||
        !isDeepStrictEqual(ownedSkillDigests(current), skills) ||
        !isDeepStrictEqual(plugin, current.resources?.plugin ?? {}))
    ) {
      const { appliedOverlay: _previous, ...rest } = current;
      const nextState = withResources(
        { ...rest, ...(options?.overlay ? { appliedOverlay: options.overlay.name } : {}) },
        { plugin, skill: skillOwnership(skills) }
      );
      await writeAtomic(paths.stateFile, serializeState(nextState), 'overwrite');
    }
    return {
      applied: false,
      dryRun: Boolean(options?.dryRun),
      plan,
      message: 'Environment is in sync with manifest. No operations needed.'
    };
  }

  // Checked before the dry-run return too, so a preview reports the refusal a real apply would hit.
  assertNoTeamEntryOverwritten(paths, lock, recordLocalDigests(lock, manifest, localDigests));

  // A real apply refuses a blocked plan before spending up to a probe timeout per profile; a dry run still previews it.
  if (!options?.dryRun) {
    assertSupportedPlan(plan);
  }

  const probe = options?.probeHmr ?? defaultHmrProbe(paths, manifest, options);
  const profiles = profilesToProbe(plan);
  const statuses = await Promise.all(profiles.map((profile) => probe(profile)));
  const hmrByProfile = new Map<string, HmrStatus>(profiles.map((profile, index) => [profile, statuses[index]]));
  const restart = buildRestartSummary(plan, hmrByProfile);

  if (options?.dryRun) {
    // A preview refuses an unsupported DSH like the real apply would; a DSH it cannot ask still gets the plan shown.
    const command = planNeedsDshCli(plan, inventory) && !options.executor ? dshCommandFor(manifest, options) : null;
    if (command) {
      await assertSupportedDsh(command, manifest, options, { tolerateProbeFailure: true });
    }
    return {
      applied: false,
      dryRun: true,
      plan,
      message: 'Dry run completed. Planned operations ready.',
      restart
    };
  }

  // Checked before the snapshot and journal entry, so a refused DSH leaves nothing for rollback to pick.
  const needsCli = !options?.executor && planNeedsDshCli(plan, inventory);
  const command = needsCli ? dshCommandFor(manifest, options) : null;
  if (needsCli && !command) {
    throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
  }
  if (command) {
    await assertSupportedDsh(command, manifest, options);
  }

  const operationId = `apply-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  let snapshot: EnvironmentSnapshot | null = null;
  // Set when a plan step failed, as opposed to a check before or after the steps.
  let failedStep = false;
  const rollback: ProfileRollback = { undo: [], keep: [] };
  // DSH cannot take an install back, so each one is owned as soon as it succeeds, even if apply then fails or is killed.
  const installed: PluginOperation[] = [];
  const recordInstalled = async (): Promise<void> => {
    const base: EnvironmentState = state ?? { apiVersion: 'dshenv-state/v1', lastApplied: '', appliedLockHash: '', profiles: {} };
    const plugin = recordInstalledOwnership(base.resources?.plugin, installed, manifest, now, operationId);
    await writeAtomic(paths.stateFile, serializeState(withResources(base, { plugin })), 'overwrite');
  };
  const onInstalled = async (operation: PluginOperation): Promise<void> => {
    installed.push(operation);
    await recordInstalled();
  };
  // Restoring state.json must not forget what the steps that did take effect changed: DSH still runs the old code
  // of what they updated, and nothing is left to remove of what they removed.
  const recordFailedApply = async (): Promise<void> => {
    const base: EnvironmentState = state ?? { apiVersion: 'dshenv-state/v1', lastApplied: '', appliedLockHash: '', profiles: {} };
    let plugin = recordInstalledOwnership(base.resources?.plugin, installed, manifest, now, operationId);
    let profiles = base.profiles;
    // The restored lock.json has no digest for local plugins installed before the failure; without one the next plan reinstalls them.
    const installedDigests: LocalSourceDigests = {};
    for (const operation of installed) {
      const digest = localDigests[operation.profile]?.[operation.alias];
      if (digest !== undefined) {
        (installedDigests[operation.profile] ??= {})[operation.alias] = digest;
      }
    }
    const partialLock = recordLocalDigests(lock, manifest, installedDigests);
    if (partialLock && partialLock !== lock) {
      await writeAtomic(paths.lockFile, serializeLock(partialLock), 'overwrite');
    }
    try {
      const live = onlyProfile(await readEnvironmentInventory(paths), options?.profile);
      const remaining = new Set(
        buildPlan(manifest, partialLock, live, state, localDigests).operations
          .filter((op): op is PluginOperation => op.resource === 'plugin')
          .map((op) => `${op.profile}\0${op.alias}\0${op.kind}`)
      );
      const done = plan.operations.filter((op) => op.resource === 'plugin' && !remaining.has(`${op.profile}\0${op.alias}\0${op.kind}`));
      profiles = recordRestartState(base.profiles, { ...plan, operations: done }, live, now, restart);
      plugin = dropUninstalledOwnership(plugin, live);
    } catch {
      // Without the profiles on disk, keep at least the ownership of what was installed.
    }
    if (installed.length > 0 || !isDeepStrictEqual(profiles, base.profiles) || !isDeepStrictEqual(plugin, base.resources?.plugin ?? {})) {
      await writeAtomic(paths.stateFile, serializeState(withResources({ ...base, profiles }, { plugin })), 'overwrite');
    }
  };

  try {
    // 1. Create snapshot before any modifications
    // The active overlay is part of what this apply applies, so rolling back to this snapshot must restore it too.
    snapshot = await createEnvironmentSnapshot(paths, operationId, {
      overlayKeys: options?.overlay ? [`overlays/${options.overlay.name}.yaml`] : []
    });

    // 2. Log operation start
    await appendJournalEntry(paths, {
      operationId,
      type: 'apply-started',
      timestamp: now,
      details: {
        operationCount: plan.operations.filter(isProfileOperation).length,
        unmanagedCount: plan.unmanaged.length,
        overlay: options?.overlay?.name ?? null
      }
    });

    // 3. Execute operations via executor (or the DSH CLI adapter)
    const execRes = options?.executor
      ? await options.executor(plan, paths)
      : await executeWithDsh(plan, paths, manifest, lock, inventory, rollback, hmrByProfile, onInstalled, signal, command, options);
    if (!execRes.success) {
      failedStep = true;
      const at = 'failedAt' in execRes && execRes.failedAt ? ` at ${execRes.failedAt}` : '';
      throw new DegradedError(`Apply execution failed${at}: ${execRes.error ?? 'Unknown executor error'}`);
    }
    // Replaced and removed skills go to trash rather than away, since DSH may hold edits nobody pulled.
    assertNotInterrupted(signal);
    const trashRoot = path.join(paths.trashDir, operationId);
    for (const operation of plan.operations) {
      if (operation.resource === 'skill') {
        rollback.undo.push(await applySkillOperation(paths, operation, trashRoot));
      }
    }

    // Never commit successful state until the actual environment converges.
    const nextLock = dropUndeclaredLockEntries(paths, recordLocalDigests(lock, manifest, localDigests), options?.profile);
    const verifiedInventory = onlyProfile(await readEnvironmentInventory(paths), options?.profile);
    const remainingPlan = buildPlan(manifest, nextLock, verifiedInventory, state, localDigests);
    if (remainingPlan.hasChanges) {
      throw new DegradedError('Apply execution finished but the environment still has pending operations');
    }
    if (nextLock !== lock && nextLock) {
      await writeAtomic(paths.lockFile, serializeLock(nextLock), 'overwrite');
    }

    // 4. Update state.json
    const lockSerialized = nextLock ? serializeLock(nextLock) : '{}';
    const lockHash = crypto.createHash('sha256').update(lockSerialized).digest('hex');

    const nextState = withResources(
      {
        apiVersion: 'dshenv-state/v1',
        lastApplied: now,
        appliedLockHash: lockHash,
        profiles: recordRestartState(state?.profiles, plan, verifiedInventory, now, restart),
        ...(options?.overlay ? { appliedOverlay: options.overlay.name } : {})
      },
      {
        plugin: recordInstalledOwnership(pruneOwnership(state?.resources?.plugin, manifest, options?.profile), plan.operations, manifest, now, operationId),
        // Converged, so every declared skill is in DSH exactly as declared.
        skill: skillOwnership(verifiedInventory.skills?.declared ?? {})
      }
    );

    await writeAtomic(paths.stateFile, serializeState(nextState), 'overwrite');

    // 5. Log operation completion; state is committed, so a journal that cannot be written must not undo the apply.
    await appendJournalEntry(paths, {
      operationId,
      type: 'apply-completed',
      timestamp: new Date().toISOString(),
      details: {
        appliedOperations: plan.operations.filter(isProfileOperation).length
      }
    }).catch(() => {});

    return {
      applied: true,
      dryRun: false,
      operationId,
      snapshotId: snapshot.snapshotId,
      plan,
      message: `Successfully applied ${plan.operations.filter(isProfileOperation).length} operation(s).`,
      restart
    };
  } catch (err: unknown) {
    for (const step of [...[...rollback.undo].reverse(), ...rollback.keep]) {
      try {
        await step();
      } catch {
        // keep undoing the remaining edits; preserve original error
      }
    }

    // Apply writes only lock.json and state.json; the manifest and envctl/skills may hold edits made meanwhile.
    let failureNote = '';
    if (snapshot) {
      try {
        await restoreSnapshotFiles(snapshot, [paths.lockFile, paths.stateFile]);
        await recordFailedApply();
        await appendJournalEntry(paths, {
          operationId,
          type: 'apply-rollback',
          timestamp: new Date().toISOString(),
          details: {
            reason: err instanceof Error ? err.message : String(err)
          }
        });
      } catch (restoreErr) {
        const reason = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        failureNote =
          `; restoring lock.json and state.json from snapshot ${snapshot.snapshotId} also failed (${reason}), ` +
          `run dshenv rollback ${operationId} --yes`;
      }
      if (failedStep && !failureNote) {
        failureNote = await recoveryHint(paths, operationId, installed);
      }
    }

    if (err instanceof DshError) {
      err.message += failureNote;
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new DegradedError(`Apply failed: ${message}${failureNote}`);
  }
}
