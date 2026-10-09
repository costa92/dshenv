import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { PatchEntry, ProfilePatch } from '../domain.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withProfilePackageLock } from '../io/profile-lock.js';
import { assertPatchFileArray, extractPluginBlocks, removePatchBlock, repairPatchFile, replacePluginBlocks, splicePluginBlocks } from '../patch/patch.js';
import { HOME_PATCH_TARGET, PROFILE_PATCHES_ALIAS, replaceProfileBlock } from '../profile-patches/entries.js';
import { mountBlockAlias, writeMount } from '../patch/mount.js';
import { isValidProfileName } from '../manifest/schema.js';

const MAX_PATCH_BYTES = 1024 * 1024;

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function profilePatchFile(paths: EnvironmentPaths, profileName: string): string {
  if (profileName === HOME_PATCH_TARGET) {
    return path.join(paths.home, 'cordis.patch.yml');
  }
  if (!isValidProfileName(profileName)) {
    throw new ValidationError(`Invalid profile name: ${profileName}`);
  }
  const profileDir = path.resolve(paths.profilesDir, profileName);
  if (!isPathInside(paths.profilesDir, profileDir)) {
    throw new ValidationError(`Profile path escapes profiles directory: ${profileName}`);
  }
  return path.join(profileDir, 'cordis.patch.yml');
}

// DSH's plugin manager rewrites cordis.patch.yml while holding the profile's package.json lock.
async function withPatchFileLock<T>(paths: EnvironmentPaths, profileName: string, operation: () => Promise<T>): Promise<T> {
  const file = profilePatchFile(paths, profileName);
  const profileDir = path.dirname(file);
  // Without a profile directory no DSH runs this profile yet, and the lock file would have nowhere to live.
  // DSH never writes the global file, which has no package.json beside it to lock.
  if (profileName === HOME_PATCH_TARGET || !fs.existsSync(profileDir)) {
    return operation();
  }
  return withProfilePackageLock(path.join(profileDir, 'package.json'), operation);
}

// Returns what was written, for the undo to compare with.
async function writePatchFile(file: string, content: string): Promise<string> {
  await writeAtomic(file, content, 'overwrite');
  return content;
}

export async function readProfilePatchFile(paths: EnvironmentPaths, profileName: string): Promise<string> {
  const file = profilePatchFile(paths, profileName);
  if (!fs.existsSync(file)) {
    return '';
  }
  const stat = await fs.promises.stat(file);
  // A FIFO reports size 0 and would block the read forever.
  if (!stat.isFile()) {
    throw new ValidationError(`cordis.patch.yml is not a regular file: ${file}`);
  }
  if (stat.size > MAX_PATCH_BYTES) {
    throw new ValidationError(`cordis.patch.yml exceeds 1 MiB: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

export type RestorePatchFile = () => Promise<void>;

// Restores the file as it was, unless anything wrote it after the write this undoes; then only this plugin's blocks go back.
// `content` must be read under the same lock hold as the write it undoes, or a DSH edit made in between is lost.
function restorePatchFile(
  paths: EnvironmentPaths,
  profileName: string,
  pluginAlias: string,
  existed: boolean,
  content: string,
  written: string
): RestorePatchFile {
  const file = profilePatchFile(paths, profileName);
  return () =>
    withPatchFileLock(paths, profileName, async () => {
      const current = fs.existsSync(file) ? await readProfilePatchFile(paths, profileName) : null;
      if (current !== null && current !== written) {
        const blocks = extractPluginBlocks(content, profileName, pluginAlias);
        await writePatchFile(file, splicePluginBlocks(current, profileName, pluginAlias, blocks));
      } else if (existed) {
        await writePatchFile(file, content);
      } else {
        await fs.promises.rm(file, { force: true });
      }
    });
}

// The undo image stays the original bytes; only what is written is repaired.
function repairedOrSelf(content: string): string {
  try {
    assertPatchFileArray(content, '');
    return content;
  } catch {
    return repairPatchFile(content) ?? content;
  }
}

// Returns how to undo the write.
export async function writeManagedPatches(
  paths: EnvironmentPaths,
  profileName: string,
  pluginAlias: string,
  patches: PatchEntry[]
): Promise<RestorePatchFile> {
  const active = patches.filter((patch) => patch.enabled !== false);
  const file = profilePatchFile(paths, profileName);
  return withPatchFileLock(paths, profileName, async () => {
    const existed = fs.existsSync(file);
    const before = await readProfilePatchFile(paths, profileName);
    const content = replacePluginBlocks(repairedOrSelf(before), profileName, pluginAlias, active);
    assertPatchFileArray(content, file);
    const written = await writePatchFile(file, content.endsWith('\n') ? content : `${content}\n`);
    return restorePatchFile(paths, profileName, pluginAlias, existed, before, written);
  });
}

// Mounts a plugin that is not a DSH bundle through its insert row, or unmounts it when packageName is null.
// Returns how to undo it.
export async function writePluginMount(
  paths: EnvironmentPaths,
  profileName: string,
  pluginAlias: string,
  packageName: string | null
): Promise<RestorePatchFile> {
  const file = profilePatchFile(paths, profileName);
  if (packageName === null && !fs.existsSync(file)) {
    return async () => {};
  }
  return withPatchFileLock(paths, profileName, async () => {
    const existed = fs.existsSync(file);
    const before = await readProfilePatchFile(paths, profileName);
    const content = writeMount(repairedOrSelf(before), profileName, pluginAlias, packageName);
    if (content === before) {
      return async () => {};
    }
    assertPatchFileArray(content, file);
    const written = await writePatchFile(file, content.endsWith('\n') ? content : `${content}\n`);
    return restorePatchFile(paths, profileName, mountBlockAlias(pluginAlias), existed, before, written);
  });
}

// Returns how to undo the clear.
export async function clearManagedPatches(
  paths: EnvironmentPaths,
  profileName: string,
  pluginAlias: string
): Promise<RestorePatchFile> {
  const file = profilePatchFile(paths, profileName);
  if (!fs.existsSync(file)) {
    return async () => {};
  }
  return withPatchFileLock(paths, profileName, async () => {
    const existed = fs.existsSync(file);
    const before = await readProfilePatchFile(paths, profileName);
    const written = await writePatchFile(file, removePatchBlock(repairedOrSelf(before), profileName, pluginAlias));
    return restorePatchFile(paths, profileName, pluginAlias, existed, before, written);
  });
}

// The file writeProfilePatches leaves, from the content it finds.
export function profilePatchContent(before: string, profileName: string, entries: ProfilePatch[]): string {
  const content = replaceProfileBlock(repairedOrSelf(before), profileName, entries);
  return content.endsWith('\n') ? content : `${content}\n`;
}

// Returns how to undo the write.
export async function writeProfilePatches(
  paths: EnvironmentPaths,
  profileName: string,
  entries: ProfilePatch[]
): Promise<RestorePatchFile> {
  const file = profilePatchFile(paths, profileName);
  return withPatchFileLock(paths, profileName, async () => {
    const existed = fs.existsSync(file);
    const before = await readProfilePatchFile(paths, profileName);
    const content = profilePatchContent(before, profileName, entries);
    assertPatchFileArray(content, file);
    const written = await writePatchFile(file, content);
    return restorePatchFile(paths, profileName, PROFILE_PATCHES_ALIAS, existed, before, written);
  });
}

// Rewrites the whole file from what `transform` makes of its current content, under the lock DSH writes it with.
export async function rewriteProfilePatchFile(
  paths: EnvironmentPaths,
  profileName: string,
  transform: (content: string) => string
): Promise<void> {
  const file = profilePatchFile(paths, profileName);
  await withPatchFileLock(paths, profileName, async () => {
    const content = transform(await readProfilePatchFile(paths, profileName));
    assertPatchFileArray(content, file);
    await writePatchFile(file, content);
  });
}
