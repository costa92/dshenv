import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentManifest, EnvironmentState } from '../domain.js';
import { ValidationError } from '../errors.js';
import { withEnvironmentLock } from '../io/lock.js';
import { retryWhileBusy } from '../io/windows-retry.js';
import { appendJournalEntry } from '../io/journal.js';
import { loadManifest, loadState } from '../manifest/files.js';
import { clearManagedPatches, profilePatchFile, readProfilePatchFile } from '../apply/patches.js';
import { extractPluginBlocks } from '../patch/patch.js';
import { inspectGitWorkingTree, managedGitSourceDir } from '../source/git.js';

export interface PurgeOptions {
  dryRun?: boolean;
  manifest?: EnvironmentManifest | null;
}

export interface PurgeResult {
  dryRun: boolean;
  profile: string;
  plugin: string;
  package: string;
  moved: string[];
  message: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertSafeManagedPath(target: string, allowedRoot: string): Promise<void> {
  const resolved = path.resolve(target);
  if (!isPathInside(allowedRoot, resolved)) {
    throw new ValidationError(`Refusing to purge path outside allowed root: ${target}`);
  }
  const lstat = await fs.promises.lstat(resolved);
  if (lstat.isSymbolicLink()) {
    const real = await fs.promises.realpath(resolved);
    if (!isPathInside(allowedRoot, real)) {
      throw new ValidationError(`Refusing to follow symlink outside allowed root: ${target}`);
    }
  }
}

interface PurgeTarget {
  alias: string;
  packageName: string;
  // Apply already removed the plugin and its config blocks; only the managed clone is left.
  cloneOnly?: boolean;
}

function findOwnedPlugin(
  state: EnvironmentState,
  manifest: EnvironmentManifest | null,
  profileName: string,
  pluginRef: string
): PurgeTarget | null {
  const owned = state.resources?.plugin?.[profileName] ?? {};
  const plugins = manifest?.profiles[profileName]?.plugins ?? {};
  for (const [packageName, record] of Object.entries(owned)) {
    if (packageName === pluginRef || record.alias === pluginRef) {
      // The record keeps the alias of the last install; a rename since writes the config blocks under the new one.
      const declared = Object.entries(plugins).find(([, plugin]) => plugin.package === packageName)?.[0];
      return { alias: declared ?? record.alias, packageName };
    }
  }
  const fromManifest = plugins[pluginRef];
  if (fromManifest && owned[fromManifest.package]) {
    return { alias: pluginRef, packageName: fromManifest.package };
  }
  return null;
}

// Apply drops the ownership record when it removes a plugin, but a clone under envctl/sources is dshenv's own either way.
function leftoverClone(paths: EnvironmentPaths, manifest: EnvironmentManifest | null, profileName: string, packageName: string): PurgeTarget | null {
  const plugins = manifest?.profiles[profileName]?.plugins ?? {};
  if (Object.hasOwn(plugins, packageName) || Object.values(plugins).some((plugin) => plugin.package === packageName)) {
    return null;
  }
  return fs.existsSync(managedGitSourceDir(paths.managerDir, profileName, packageName)) ? { alias: packageName, packageName, cloneOnly: true } : null;
}

// Decided under the lock, so state and the clone cannot change between the checks and the move.
export async function purgePlugin(
  paths: EnvironmentPaths,
  profileName: string,
  pluginRef: string,
  options?: PurgeOptions
): Promise<PurgeResult> {
  const purge = () => purgeDecided(paths, profileName, pluginRef, options);
  return options?.dryRun ? purge() : withEnvironmentLock(paths, purge);
}

async function purgeDecided(
  paths: EnvironmentPaths,
  profileName: string,
  pluginRef: string,
  options?: PurgeOptions
): Promise<PurgeResult> {
  if (!fs.existsSync(paths.stateFile)) {
    throw new ValidationError(`State file not found: ${paths.stateFile}`);
  }
  const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
  const manifest = options?.manifest !== undefined
    ? options.manifest
    : fs.existsSync(paths.manifestFile)
      ? loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'))
      : null;
  const owned = findOwnedPlugin(state, manifest, profileName, pluginRef) ?? leftoverClone(paths, manifest, profileName, pluginRef);
  if (!owned) {
    throw new ValidationError(`Refusing to purge '${pluginRef}' in '${profileName}': no ownership record, and no managed clone of a package by that name the manifest no longer declares`);
  }

  const moved: string[] = [];
  const patchFile = profilePatchFile(paths, profileName);
  const cloneDir = managedGitSourceDir(paths.managerDir, profileName, owned.packageName);
  const cloneStatus = await inspectGitWorkingTree(cloneDir);
  if (cloneStatus.statusError !== undefined) {
    throw new ValidationError(`Refusing to purge ${cloneDir}: git cannot tell whether the managed clone has uncommitted changes (${cloneStatus.statusError})`);
  }
  if (cloneStatus.isDirty) {
    throw new ValidationError(`Refusing to purge ${cloneDir}: the managed clone has uncommitted changes`);
  }

  // A patch file without this plugin's blocks (purged already, or never configured) has nothing of it to purge.
  const hasPatchFile = !owned.cloneOnly && fs.existsSync(patchFile) &&
    extractPluginBlocks(await readProfilePatchFile(paths, profileName), profileName, owned.alias).trim() !== '';
  const hasClone = fs.existsSync(cloneDir);
  if (!hasPatchFile && !hasClone) {
    return { dryRun: Boolean(options?.dryRun), profile: profileName, plugin: owned.alias, package: owned.packageName, moved, message: `Nothing to purge for ${owned.alias}` };
  }

  // Both are checked before anything is written, and before a preview, so a refusal leaves everything as it was, trash and
  // journal included, and the preview refuses what the purge would.
  if (hasPatchFile) {
    await assertSafeManagedPath(patchFile, paths.profilesDir);
  }
  if (hasClone) {
    await assertSafeManagedPath(cloneDir, paths.managerDir);
  }

  if (options?.dryRun) {
    if (hasPatchFile) moved.push(patchFile);
    if (hasClone) moved.push(cloneDir);
    return {
      dryRun: true,
      profile: profileName,
      plugin: owned.alias,
      package: owned.packageName,
      moved,
      message: `Would purge managed resources for ${owned.alias}`
    };
  }

  const operationId = `purge-${Date.now().toString(16)}`;
  const trashRoot = path.join(paths.trashDir, operationId);
  await fs.promises.mkdir(trashRoot, { recursive: true });
  await appendJournalEntry(paths, {
    operationId,
    type: 'purge-started',
    timestamp: new Date().toISOString(),
    details: { profile: profileName, package: owned.packageName }
  });

  let restorePatches: (() => Promise<void>) | null = null;
  if (hasPatchFile) {
    const dest = path.join(trashRoot, 'cordis.patch.yml');
    await fs.promises.copyFile(patchFile, dest);
    moved.push(dest);
    restorePatches = await clearManagedPatches(paths, profileName, owned.alias);
  }

  if (hasClone) {
    const dest = path.join(trashRoot, 'source');
    try {
      await retryWhileBusy(() => fs.promises.rename(cloneDir, dest));
    } catch (err) {
      await restorePatches?.();
      throw err;
    }
    moved.push(dest);
  }

  await appendJournalEntry(paths, {
    operationId,
    type: 'purge-completed',
    timestamp: new Date().toISOString(),
    details: { moved }
  });

  return {
    dryRun: false,
    profile: profileName,
    plugin: owned.alias,
    package: owned.packageName,
    moved,
    message: `Purged managed resources for ${owned.alias} into ${trashRoot}`
  };
}
