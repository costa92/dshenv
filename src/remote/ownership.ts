import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentLock } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { loadLock } from '../manifest/files.js';
import { findLockEntryDrift, lockEntryId, type LockEntryDrift } from './lock-entries.js';
import { remoteSkillNames } from '../resources/skill.js';
import { isUndigestedEntry } from '../source/local.js';
import { compareRemoteKeys, overlayNameFromKey, readRemoteConfig, remoteFilePath, sha256Hex, type RemoteConfig } from './schema.js';

export interface RemoteFileDrift {
  file: string;
  // added: a local file inside a team skill's directory, which the team owns whole
  status: 'modified' | 'missing' | 'added';
}

export function localFileDigest(file: string): string | null {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function findLocalDrift(paths: EnvironmentPaths, config: RemoteConfig): RemoteFileDrift[] {
  const drift: RemoteFileDrift[] = [];
  for (const key of Object.keys(config.files).sort(compareRemoteKeys)) {
    const digest = localFileDigest(remoteFilePath(paths, key));
    if (digest === null) {
      drift.push({ file: key, status: 'missing' });
    } else if (digest !== config.files[key]) {
      drift.push({ file: key, status: 'modified' });
    }
  }
  for (const name of [...remoteSkillNames(config.files)].sort()) {
    for (const rel of localSkillFiles(path.join(paths.skillsDir, name))) {
      const key = `skills/${name}/${rel}`;
      if (!Object.hasOwn(config.files, key)) {
        drift.push({ file: key, status: 'added' });
      }
    }
  }
  return drift;
}

// The files of a skill directory a copy into DSH would carry, as '/'-separated paths relative to it.
function localSkillFiles(dir: string, rel = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !isUndigestedEntry(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.isDirectory() ? localSkillFiles(dir, child) : [child];
    });
}

// An unreadable lock may still hold this machine's own entries, so nothing may overwrite or reinterpret it.
export function readLocalLock(paths: EnvironmentPaths): EnvironmentLock | null {
  if (!fs.existsSync(paths.lockFile)) {
    return null;
  }
  try {
    return loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(
        `Cannot parse local lock file ${paths.lockFile}: ${err.message}; it may hold local entries, so fix it by hand, then run the command again`
      );
    }
    throw err;
  }
}

export function findRemoteLockDrift(paths: EnvironmentPaths, config: RemoteConfig): LockEntryDrift[] {
  return findLockEntryDrift(readLocalLock(paths), config.lockEntries);
}

export function describeRemoteDrift(files: RemoteFileDrift[], entries: LockEntryDrift[]): string[] {
  return [
    ...files.map((entry) => `${entry.file} (${entry.status})`),
    ...entries.map((entry) => `lock entry ${entry.entry} (${entry.status})`)
  ];
}

export function remoteOwnedKey(paths: EnvironmentPaths, config: RemoteConfig, file: string): string | null {
  // macOS and Windows filesystems ignore case by default, so Team.yaml there is the team's team.yaml.
  const fold = process.platform === 'darwin' || process.platform === 'win32' ? (p: string) => p.toLowerCase() : (p: string) => p;
  const target = fold(path.resolve(file));
  return Object.keys(config.files).find((key) => fold(remoteFilePath(paths, key)) === target) ?? null;
}

// Remote files change only through sync; local customisation belongs in a local overlay.
export function assertNotRemoteOwned(paths: EnvironmentPaths, file: string): void {
  const config = readRemoteConfig(paths);
  if (!config) {
    return;
  }
  const key = remoteOwnedKey(paths, config, file);
  if (key === null) {
    return;
  }
  if (key === 'manifest.yaml') {
    throw new ValidationError(`The base manifest is owned by remote ${config.url}; put local changes in a local overlay and write with --layer overlay`);
  }
  throw new ValidationError(`Overlay '${overlayNameFromKey(key)}' is owned by remote ${config.url}; use a local overlay with a different name`);
}

export function isLockEntryRemoteOwned(paths: EnvironmentPaths, profile: string, alias: string): boolean {
  const config = readRemoteConfig(paths);
  return Boolean(config && Object.hasOwn(config.lockEntries, profile) && Object.hasOwn(config.lockEntries[profile], alias));
}

// The lock is shared per entry: team entries change only through sync, local entries stay writable.
export function assertLockEntryNotRemoteOwned(paths: EnvironmentPaths, profile: string, alias: string): void {
  if (!isLockEntryRemoteOwned(paths, profile, alias)) {
    return;
  }
  const config = readRemoteConfig(paths)!;
  throw new ValidationError(
    `Lock entry '${lockEntryId(profile, alias)}' is pinned by the team lock of remote ${config.url}; change it in the team repository and run dshenv remote sync`
  );
}
