import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { CaptureDocument, EnvironmentLock, EnvironmentManifest, EnvironmentState, PluginLockEntry, PluginOwnership, PluginOwnershipRecord, PluginSource } from '../domain.js';
import type { EnvironmentInventory, InstalledPluginInfo } from '../inventory/profile-reader.js';
import { captureEnvironment } from '../import/capture.js';
import { calculateSourceDigest } from '../source/local.js';
import type { EnvironmentPlan, LocalSourceDigests, PluginOperation, UnmanagedPlugin, UnverifiedPlugin } from '../planner/plan.js';
import type { ProfileRollback } from '../apply/apply.js';
import { computePatchDigest } from '../patch/patch.js';
import { isBundlePackage } from '../patch/mount.js';
import { setProfileBundleEnabled } from '../apply/bundles.js';
import { clearManagedPatches, writeManagedPatches, writePluginMount } from '../apply/patches.js';
import { awaitWithTreeTimeout } from '../io/process-tree.js';
import { releaseProfileLockOfStopped } from '../io/profile-lock.js';
import { assertNotInterrupted } from '../io/interrupt.js';
import type { CommandSpec } from '../dsh/command.js';
import type { HmrStatus } from '../dsh/hmr.js';
import { CapabilityError, ValidationError } from '../errors.js';

// Only a hex fragment proves which commit is installed; branch names and bare URLs are not evidence.
function commitFromGitSpec(spec: string | undefined): string | undefined {
  return spec?.match(/#([0-9a-f]{7,64})$/i)?.[1].toLowerCase();
}

function lockedLocalDigest(
  source: EnvironmentLock['profiles'][string]['plugins'][string]['source'] | undefined,
  type: 'local-file' | 'local-link'
): string | undefined {
  return source?.type === type ? source.digest : undefined;
}

type LockedSource = EnvironmentLock['profiles'][string]['plugins'][string]['source'] | undefined;
type ManifestSource = EnvironmentManifest['profiles'][string]['plugins'][string]['source'];

// The lock is a single per-machine file shared by every overlay, so it may only pin what the
// effective manifest declares, never override it.
export function lockedGitCommit(source: ManifestSource, locked: LockedSource): string | undefined {
  return source.type === 'git' && locked?.type === 'git' && locked.url === source.url ? locked.commit : undefined;
}

// Without a readable source an installed local plugin would read as in sync while nothing proves it.
function unreadableLocalSource(source: ManifestSource, localDigest: string | undefined, digestsRead: boolean): string | undefined {
  if ((source.type === 'local-file' || source.type === 'local-link') && digestsRead && !localDigest) {
    return `Local source ${source.path} cannot be read, so the installed copy cannot be checked against it`;
  }
  return undefined;
}

// The installed spec is the evidence; the lock stands in when the inventory could not resolve one.
function localPathMoved(
  type: 'local-file' | 'local-link',
  declared: string,
  installed: string | undefined,
  locked: LockedSource
): boolean {
  const current = installed ?? (locked?.type === type ? locked.path : undefined);
  return current !== undefined && path.normalize(current) !== path.normalize(declared);
}

function isSameCommit(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left.startsWith(right) || right.startsWith(left);
}

// The lock alone decides the installed commit; a manifest commit it disagrees with must not be silently ignored.
function gitCommitBlock(declared: string | undefined, locked: string | undefined): string | undefined {
  if (!locked) {
    return declared
      ? `Git source declares commit ${declared} in the manifest, but only lock.json pins git commits; run 'dshenv source clone <url> --profile <profile>' to lock it`
      : 'Git source has no locked commit; refusing to invent HEAD';
  }
  if (declared && !isSameCommit(declared, locked)) {
    return `Git source declares commit ${declared} in the manifest, but the locked commit is ${locked}; drop the manifest commit or move the lock with 'dshenv source sync --profile <profile> --ref ${declared}'`;
  }
  return undefined;
}

// The base and app bundles DSH selects when it creates a profile; leaving them undeclared is the normal case.
const DSH_BUILT_IN_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-app'
]);

function isDshBuiltIn(plugin: { name: string; sourceType?: string }): boolean {
  return plugin.sourceType === 'in-box' && DSH_BUILT_IN_BUNDLES.has(plugin.name);
}

export interface PluginPlan {
  operations: PluginOperation[];
  unmanaged: UnmanagedPlugin[];
  unverified: UnverifiedPlugin[];
}

export function planPlugins(
  manifest: EnvironmentManifest | null,
  lock: EnvironmentLock | null,
  inventory: EnvironmentInventory,
  state?: EnvironmentState | null,
  localDigests?: LocalSourceDigests
): PluginPlan {
  const operations: PluginOperation[] = [];
  const unmanaged: UnmanagedPlugin[] = [];
  const unverified: UnverifiedPlugin[] = [];

  if (!manifest) {
    // No manifest, inventory plugins are unmanaged
    for (const [profName, profInv] of Object.entries(inventory.profiles)) {
      for (const pkgName of Object.keys(profInv.plugins)) {
        if (!isDshBuiltIn(profInv.plugins[pkgName])) {
          unmanaged.push({ profile: profName, package: pkgName });
        }
      }
    }
    return { operations, unmanaged, unverified };
  }

  const manifestProfiles = manifest.profiles || {};

  // Check expected vs actual
  for (const [profName, profManifest] of Object.entries(manifestProfiles)) {
    const profInv = inventory.profiles[profName];
    const profLock = lock?.profiles?.[profName]?.plugins || {};

    for (const [alias, pluginManifest] of Object.entries(profManifest.plugins)) {
      const pkgName = pluginManifest.package;
      const targetEnabled = pluginManifest.enabled ?? true;
      const lockEntry = profLock[alias];

      const targetVersion = pluginManifest.source.type === 'npm' ? pluginManifest.source.version : undefined;

      const installed = profInv?.plugins?.[pkgName];
      const gitLockCommit = lockedGitCommit(pluginManifest.source, lockEntry?.source);

      const gitBlock = pluginManifest.source.type === 'git' ? gitCommitBlock(pluginManifest.source.commit, gitLockCommit) : undefined;
      if (gitBlock) {
        operations.push({
          resource: 'plugin',
          kind: 'blocked',
          profile: profName,
          alias,
          package: pkgName,
          reason: gitBlock,
          blockedReason: gitBlock,
          targetEnabled
        });
        continue;
      }

      // A plugin may need several operations; apply requires convergence in a single run.
      // A bundle entry without a dependency reads as in-box, which proves nothing about a package declared from elsewhere.
      const isInstalled = Boolean(installed?.installed) && !(installed?.sourceType === 'in-box' && pluginManifest.source.type !== 'in-box');
      const currentVersion = installed?.version;
      // A plain plugin is loaded through the mount row of its alias; a row left under an old alias is cleared below.
      const mountedHere = installed?.bundle === false && profInv?.mounts ? profInv.mounts[alias] === pkgName : undefined;
      const currentEnabled = isInstalled ? (mountedHere ?? installed?.enabled ?? true) : undefined;

      if (!isInstalled && pluginManifest.source.type === 'in-box') {
        // In-box plugins ship with DSH and are only inventoried through the bundles, so absence means disabled.
        if (targetEnabled) {
          operations.push({
            resource: 'plugin',
            kind: 'enable',
            profile: profName,
            alias,
            package: pkgName,
            reason: 'In-box plugin is not selected in the profile bundles',
            currentEnabled: false,
            targetEnabled
          });
        }
      } else if (!isInstalled) {
        operations.push({
          resource: 'plugin',
          kind: 'install',
          profile: profName,
          alias,
          package: pkgName,
          reason: 'Plugin is declared in manifest but not installed in profile',
          targetVersion,
          targetEnabled
        });
        // DSH plugin add selects the bundle, so only an explicit disable needs a follow-up.
        if (!targetEnabled) {
          operations.push({
            resource: 'plugin',
            kind: 'disable',
            profile: profName,
            alias,
            package: pkgName,
            reason: 'Plugin is installed disabled',
            targetEnabled
          });
        }
      } else {
        const operationsBefore = operations.length;
        const installedCommit =
          pluginManifest.source.type === 'git' ? commitFromGitSpec(installed?.resolvedSource) : undefined;
        const installedType = installed?.sourceType;
        const declaredType = pluginManifest.source.type;
        const unverifiable = unreadableLocalSource(pluginManifest.source, localDigests?.[profName]?.[alias], localDigests !== undefined);
        if (unverifiable) {
          unverified.push({ profile: profName, alias, package: pkgName, reason: unverifiable });
        }
        if (installedType && installedType !== declaredType && installedType !== 'in-box' && declaredType !== 'in-box') {
          operations.push({
            resource: 'plugin',
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Source type changed: installed ${installedType} != declared ${declaredType}`,
            currentEnabled,
            targetEnabled
          });
        } else if (targetVersion && (currentVersion ? targetVersion !== currentVersion : installedType === 'npm')) {
          // A reinstall writes the version that proves the package matches.
          operations.push({
            resource: 'plugin',
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: currentVersion
              ? `Version mismatch: current ${currentVersion} != target ${targetVersion}`
              : `Installed npm package reports no version; reinstalling ${targetVersion}`,
            currentVersion,
            targetVersion,
            currentEnabled,
            targetEnabled
          });
        } else if (
          (pluginManifest.source.type === 'local-file' || pluginManifest.source.type === 'local-link') &&
          localPathMoved(pluginManifest.source.type, pluginManifest.source.path, installed?.resolvedSource, lockEntry?.source)
        ) {
          operations.push({
            resource: 'plugin',
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Local source path changed to ${pluginManifest.source.path}`,
            currentEnabled,
            targetEnabled
          });
        } else if (
          (pluginManifest.source.type === 'local-file' || pluginManifest.source.type === 'local-link') &&
          localDigests?.[profName]?.[alias] &&
          lockedLocalDigest(lockEntry?.source, pluginManifest.source.type) !== localDigests[profName][alias]
        ) {
          // Without a recorded digest the installed copy cannot be proven to match the source.
          const recorded = lockedLocalDigest(lockEntry?.source, pluginManifest.source.type);
          operations.push({
            resource: 'plugin',
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: recorded
              ? `Local source changed: recorded ${recorded} != current ${localDigests[profName][alias]}`
              : 'Local source has no recorded digest',
            currentVersion: recorded,
            targetVersion: localDigests[profName][alias],
            currentEnabled,
            targetEnabled
          });
        } else if (gitLockCommit && installedType === 'git' && (!installedCommit || !isSameCommit(installedCommit, gitLockCommit))) {
          // A spec such as #main names no commit, so the installed code cannot be shown to match the lock.
          operations.push({
            resource: 'plugin',
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: installedCommit
              ? `Commit mismatch: current ${installedCommit} != locked ${gitLockCommit}`
              : `Installed git spec pins no commit; reinstalling at locked ${gitLockCommit}`,
            currentVersion: installedCommit,
            targetVersion: gitLockCommit,
            currentEnabled,
            targetEnabled
          });
        }
        // An update runs DSH plugin add, which selects the bundle, so a disabled plugin is disabled again after it.
        const reselected = !targetEnabled && operations.length > operationsBefore;
        if (currentEnabled !== targetEnabled || reselected) {
          operations.push({
            resource: 'plugin',
            kind: targetEnabled ? 'enable' : 'disable',
            profile: profName,
            alias,
            package: pkgName,
            reason: currentEnabled !== targetEnabled
              ? `Enable state mismatch: current ${currentEnabled} != target ${targetEnabled}`
              : 'Plugin stays disabled after the update',
            currentEnabled,
            targetEnabled
          });
        }
      }

      // Live blocks must match the enabled patches exactly, so dropped or disabled patches are cleared too.
      const expectedPatches = (pluginManifest.patches ?? []).filter((patch) => patch.enabled !== false);
      const livePatches = (profInv?.managedPatches ?? []).filter((actual) => actual.plugin === alias);
      const patchesInSync =
        livePatches.length === expectedPatches.length &&
        expectedPatches.every((expected, index) => {
          const actual = livePatches[index];
          return actual.id === expected.id && actual.isDigestValid && actual.digest === computePatchDigest(expected.config);
        });
      if (!patchesInSync) {
        operations.push({
          resource: 'plugin',
          kind: 'configure',
          profile: profName,
          alias,
          package: pkgName,
          reason: expectedPatches.length > 0
            ? 'Managed configuration patch is missing or digest does not match'
            : 'Managed configuration patch is no longer declared',
          currentEnabled,
          targetEnabled
        });
      }
    }

    // DSH creates a profile only when it installs a plugin into it; without one, in-box plugins have nowhere to go.
    if (!profInv && !operations.some((op) => op.profile === profName && op.kind === 'install')) {
      const reason = `Profile '${profName}' does not exist yet; start DSH with --profile ${profName} once, or declare a plugin to install in it`;
      for (const [index, op] of operations.entries()) {
        if (op.profile === profName && op.kind !== 'blocked') {
          operations[index] = { ...op, kind: 'blocked', reason, blockedReason: reason };
        }
      }
    }
  }

  // Installed plugins not in the manifest: remove only when ownership exists.
  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    const profManifest = manifestProfiles[profName];
    const expectedPackages = new Set<string>();
    if (profManifest) {
      for (const p of Object.values(profManifest.plugins)) {
        expectedPackages.add(p.package);
      }
    }

    for (const pkgName of Object.keys(profInv.plugins)) {
      if (expectedPackages.has(pkgName)) {
        continue;
      }
      if (isDshBuiltIn(profInv.plugins[pkgName])) {
        continue;
      }
      const owned = state?.resources?.plugin?.[profName]?.[pkgName];
      if (owned && profInv.plugins[pkgName].installed) {
        operations.push({
          resource: 'plugin',
          kind: 'remove',
          profile: profName,
          alias: owned.alias || pkgName,
          package: pkgName,
          reason: 'Owned plugin is no longer declared in the manifest'
        });
      } else {
        unmanaged.push({
          profile: profName,
          package: pkgName
        });
      }
    }
  }

  // dshenv blocks of an alias the manifest no longer declares describe nothing, unless a remove of that alias clears them.
  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    const declared = manifestProfiles[profName]?.plugins ?? {};
    const removed = new Set(operations.filter((op) => op.profile === profName && op.kind === 'remove').map((op) => op.alias));
    const aliases = new Set([
      ...(profInv.managedPatches ?? []).map((patch) => patch.plugin).filter((alias) => !alias.startsWith('@')),
      ...Object.keys(profInv.mounts ?? {})
    ]);
    for (const alias of aliases) {
      if (!Object.hasOwn(declared, alias) && !removed.has(alias)) {
        operations.push({
          resource: 'plugin',
          kind: 'configure',
          profile: profName,
          alias,
          package: profInv.mounts?.[alias] ?? alias,
          reason: 'Managed configuration patch or mount of an alias the manifest no longer declares'
        });
      }
    }
  }

  return { operations, unmanaged, unverified };
}

// Only DSH's own `dsh:` lines are shown: the raw pnpm output around them can echo registry URLs and tokens.
function dshFailure(result: { exitCode?: number; timedOut?: boolean; stdout?: unknown; stderr?: unknown }, timeoutMs: number): string {
  const diagnostics = [result.stderr, result.stdout]
    .flatMap((output) => (typeof output === 'string' ? output.split('\n') : []))
    .filter((line) => line.startsWith('dsh: '))
    .map((line) => `\n  ${line.trimEnd()}`)
    .join('');
  const outcome = result.timedOut ? `timed out after ${timeoutMs} ms` : `exited with code ${String(result.exitCode)}`;
  return `DSH plugin command ${outcome}${diagnostics}`;
}

async function runDshPluginCommand(
  command: CommandSpec,
  profile: string,
  args: string[],
  paths: EnvironmentPaths,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ exitCode?: number; timedOut: boolean; stdout?: unknown; stderr?: unknown }> {
  const subprocess = execa(command.file, [...command.args, 'plugin', '--profile', profile, ...args], {
    cwd: command.cwd,
    env: { ...process.env, DSH_HOME: paths.home },
    shell: false,
    reject: false
  });
  const { result, timedOut, killed } = await awaitWithTreeTimeout(subprocess, timeoutMs, signal);
  if (killed.length > 0) {
    await releaseProfileLockOfStopped(path.join(paths.profilesDir, profile, 'package.json'), killed);
  }
  return { exitCode: result.exitCode, timedOut, stdout: result.stdout, stderr: result.stderr };
}

function packageSpec(
  manifest: EnvironmentManifest,
  lock: EnvironmentLock | null,
  operation: PluginOperation
): string {
  const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
  if (!plugin) {
    throw new ValidationError(`Plugin '${operation.alias}' is missing from profile '${operation.profile}'`);
  }

  const lockedSource = lock?.profiles[operation.profile]?.plugins[operation.alias]?.source;
  switch (plugin.source.type) {
    case 'npm':
      return `${plugin.package}@${plugin.source.version}`;
    case 'git': {
      const commit = lockedGitCommit(plugin.source, lockedSource) ?? plugin.source.commit;
      if (!commit) throw new ValidationError(`Git plugin '${plugin.package}' has no locked commit`);
      // pnpm reads a bare file:// or non-hosted https:// URL as a local path or tarball, not a Git repository.
      const url = /^(?:https?|ssh|file):\/\//i.test(plugin.source.url) ? `git+${plugin.source.url}` : plugin.source.url;
      return `${url}#${commit}`;
    }
    case 'local-link':
      return `link:${plugin.source.path}`;
    case 'local-file':
      return `file:${plugin.source.path}`;
    case 'in-box':
      return plugin.package;
  }
}

export function planNeedsDshCli(plan: EnvironmentPlan, inventory: EnvironmentInventory): boolean {
  return plan.operations.some((operation) => {
    if (operation.resource !== 'plugin') {
      return false;
    }
    if (operation.kind === 'install' || operation.kind === 'update') {
      return true;
    }
    if (operation.kind !== 'remove') {
      return false;
    }
    return inventory.profiles[operation.profile]?.plugins[operation.package]?.sourceType !== 'in-box';
  });
}

function installedAsPlainPlugin(paths: EnvironmentPaths, profile: string, packageName: string): boolean {
  try {
    const file = path.join(paths.profilesDir, profile, 'node_modules', ...packageName.split('/'), 'package.json');
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !isBundlePackage(raw as Record<string, unknown>);
  } catch {
    return false;
  }
}

export interface PluginStepContext {
  paths: EnvironmentPaths;
  manifest: EnvironmentManifest;
  lock: EnvironmentLock | null;
  inventory: EnvironmentInventory;
  rollback: ProfileRollback;
  hmrByProfile: ReadonlyMap<string, HmrStatus>;
  onInstalled: (operation: PluginOperation) => Promise<void>;
  signal: AbortSignal | undefined;
  command: CommandSpec | null;
  commandTimeoutMs: number;
  hmrSettleMs: number;
}

// A plugin that is not a DSH bundle is switched by its insert row; it never belongs in the bundle list.
async function setPlainPluginEnabled(ctx: PluginStepContext, operation: PluginOperation, enabled: boolean): Promise<void> {
  const { paths, rollback } = ctx;
  rollback.undo.push(await writePluginMount(paths, operation.profile, operation.alias, enabled ? operation.package : null));
  const previousIndex = await setProfileBundleEnabled(paths, operation.profile, operation.package, false);
  rollback.undo.push(async () => {
    await setProfileBundleEnabled(paths, operation.profile, operation.package, previousIndex !== -1, previousIndex);
  });
}

// Returns why DSH failed the step, or null once it is done.
export async function applyPluginOperation(operation: PluginOperation, ctx: PluginStepContext): Promise<string | null> {
  const { paths, manifest, lock, inventory, rollback, hmrByProfile, onInstalled, signal, command } = ctx;
  if ((operation.kind === 'enable' || operation.kind === 'disable') && inventory.profiles[operation.profile]?.plugins[operation.package]?.bundle === false) {
    await setPlainPluginEnabled(ctx, operation, operation.kind === 'enable');
    return null;
  }
  if (operation.kind === 'enable' || operation.kind === 'disable') {
    const previousIndex = await setProfileBundleEnabled(
      paths,
      operation.profile,
      operation.package,
      operation.kind === 'enable'
    );
    rollback.undo.push(async () => {
      await setProfileBundleEnabled(paths, operation.profile, operation.package, previousIndex !== -1, previousIndex);
    });
    return null;
  }

  if (operation.kind === 'configure') {
    const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
    if (!plugin) {
      rollback.undo.push(await clearManagedPatches(paths, operation.profile, operation.alias));
      rollback.undo.push(await writePluginMount(paths, operation.profile, operation.alias, null));
      return null;
    }
    rollback.undo.push(await writeManagedPatches(paths, operation.profile, operation.alias, plugin.patches ?? []));
    return null;
  }

  if (operation.kind === 'remove') {
    const undoStart = rollback.undo.length;
    // The alias may now name the package replacing this one (removes run first); its patches belong to that entry.
    const aliasRedeclared = Boolean(manifest.profiles[operation.profile]?.plugins[operation.alias]);
    if (!aliasRedeclared) {
      rollback.undo.push(await clearManagedPatches(paths, operation.profile, operation.alias));
    }
    rollback.undo.push(await writePluginMount(paths, operation.profile, operation.alias, null));
    const previousIndex = await setProfileBundleEnabled(paths, operation.profile, operation.package, false);
    rollback.undo.push(async () => {
      await setProfileBundleEnabled(paths, operation.profile, operation.package, previousIndex !== -1, previousIndex);
    });
    const sourceType = inventory.profiles[operation.profile]?.plugins[operation.package]?.sourceType;
    if (sourceType === 'in-box') {
      return null;
    }
    if (!command) {
      throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
    }
    // Only a plugin that was in the bundle list or mounted is loaded, so only then is there an unload to wait for.
    const installed = inventory.profiles[operation.profile]?.plugins[operation.package];
    const wasMounted = installed?.bundle === false && installed.enabled === true;
    if ((previousIndex !== -1 || wasMounted) && hmrByProfile.get(operation.profile)?.state === 'on') {
      await delay(ctx.hmrSettleMs, undefined, { signal }).catch(() => assertNotInterrupted(signal));
    }
    const removeResult = await runDshPluginCommand(
      command,
      operation.profile,
      ['remove', operation.package],
      paths,
      ctx.commandTimeoutMs,
      signal
    );
    if (removeResult.exitCode !== 0) {
      assertNotInterrupted(signal);
      return dshFailure(removeResult, ctx.commandTimeoutMs);
    }
    // The package is gone; restoring its bundle or patch would describe a plugin that no longer exists.
    rollback.undo.length = undoStart;
    rollback.keep.push(async () => {
      if (!aliasRedeclared) {
        await clearManagedPatches(paths, operation.profile, operation.alias);
      }
      await writePluginMount(paths, operation.profile, operation.alias, null);
    });
    return null;
  }

  if (!command) {
    throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
  }

  const result = await runDshPluginCommand(
    command,
    operation.profile,
    ['add', packageSpec(manifest, lock, operation)],
    paths,
    ctx.commandTimeoutMs,
    signal
  );
  if (result.exitCode !== 0) {
    // Killed because of the interrupt: report that, not the exit code it caused.
    assertNotInterrupted(signal);
    return dshFailure(result, ctx.commandTimeoutMs);
  }
  // An update replaces what DSH had, so it is owned as an install is.
  if (operation.kind === 'install' || operation.kind === 'update') {
    await onInstalled(operation);
  }
  // Only now is the package on disk to tell whether DSH loads it as a bundle.
  if (installedAsPlainPlugin(paths, operation.profile, operation.package)) {
    await setPlainPluginEnabled(ctx, operation, operation.targetEnabled !== false);
  }
  return null;
}

// A plugin dshenv installed or took over is dshenv's to remove once the manifest drops it.
export function pluginOwnershipRecord(packageName: string, alias: string, source: PluginSource, adoptedAt: string, adoptedBy: string): PluginOwnershipRecord {
  return {
    package: packageName,
    alias,
    sourceType: source.type,
    lockedVersion: source.type === 'npm' ? source.version : undefined,
    adoptedAt,
    adoptedBy
  };
}

// A record for a package no longer in its profile has nothing left to remove; kept, it would make a later
// hand install of that package look like dshenv's.
export function dropUninstalledOwnership(ownership: PluginOwnership | undefined, inventory: EnvironmentInventory): PluginOwnership {
  const next: PluginOwnership = {};
  for (const [profileName, packages] of Object.entries(ownership ?? {})) {
    const live = inventory.profiles[profileName]?.plugins;
    const kept = live ? Object.fromEntries(Object.entries(packages).filter(([name]) => live[name]?.installed)) : packages;
    if (Object.keys(kept).length > 0) {
      next[profileName] = kept;
    }
  }
  return next;
}

// A captured alias can already name another declared package; overwriting that entry would drop it and its patches.
export function freeAlias(plugins: Record<string, unknown>, alias: string): string {
  let candidate = alias;
  for (let counter = 1; Object.hasOwn(plugins, candidate); counter++) {
    candidate = `${alias}-${counter}`;
  }
  return candidate;
}

// The plugins plan reports as not in the manifest, described the way capture describes them.
export function captureUnmanagedPlugins(
  inventory: EnvironmentInventory,
  profiles: string[],
  manifest: EnvironmentManifest,
  lock: EnvironmentLock | null,
  state: EnvironmentState | null,
  // profile -> packages; when given, only these are taken.
  only?: Record<string, string[]>
): CaptureDocument {
  const selected: EnvironmentInventory = { profiles: {} };
  const unmanaged = planPlugins(manifest, lock, inventory, state).unmanaged
    .sort((a, b) => a.profile.localeCompare(b.profile) || a.package.localeCompare(b.package));
  for (const { profile, package: name } of unmanaged) {
    if (!profiles.includes(profile) || (only && !only[profile]?.includes(name))) {
      continue;
    }
    // Patch entries are pulled on their own; capture would only warn about them.
    const { profilePatches: _patches, ...source } = inventory.profiles[profile];
    (selected.profiles[profile] ??= { ...source, plugins: {} }).plugins[name] = source.plugins[name];
  }
  return captureEnvironment(selected);
}

// An install that resolves to the source directory is that directory, so its digest is what DSH loads; a copy proves nothing.
export async function withLinkDigest(entry: PluginLockEntry, installed: InstalledPluginInfo | undefined): Promise<PluginLockEntry> {
  if (entry.source.type !== 'local-link' || !installed?.targetPath) {
    return entry;
  }
  try {
    if ((await fs.promises.realpath(entry.source.path)) !== installed.targetPath) {
      return entry;
    }
    return { ...entry, source: { ...entry.source, digest: await calculateSourceDigest(entry.source.path) } };
  } catch {
    return entry;
  }
}
