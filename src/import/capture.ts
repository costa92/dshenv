import * as fs from 'node:fs';
import { officialBundleAlias } from '../dsh/templates.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import type {
  CaptureDocument,
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState,
  PluginManifestEntry,
  PluginLockEntry
} from '../domain.js';
import {
  serializeManifest,
  serializeLock,
  serializeState
} from '../manifest/files.js';
import { writeAtomic } from '../io/atomic-file.js';
import { ValidationError } from '../errors.js';
import { ExactVersionRegex, hasEmbeddedCredentials } from '../manifest/schema.js';

const GIT_COMMIT_RE = /^[0-9a-f]{7,64}$/i;

const GIT_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

// The fragment is a commit or a ref; anything else (such as npm's semver:) is null, as git cannot check it out.
function parseGitSpec(spec: string): { url: string; commit?: string; ref?: string } | null {
  const hashIndex = spec.lastIndexOf('#');
  if (hashIndex <= 0) {
    return { url: spec };
  }
  const url = spec.slice(0, hashIndex);
  const fragment = spec.slice(hashIndex + 1);
  if (GIT_COMMIT_RE.test(fragment)) {
    return { url, commit: fragment };
  }
  return GIT_REF_RE.test(fragment) ? { url, ref: fragment } : null;
}

function getAliasFromPackageName(pkgName: string, usedKeys: Set<string>): string {
  let base = officialBundleAlias(pkgName) ?? (pkgName.includes('/') ? pkgName.split('/')[1] : pkgName);
  if (base.startsWith('dsh-')) {
    base = base.slice(4);
  }
  let candidate = base;
  let counter = 1;
  while (usedKeys.has(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  usedKeys.add(candidate);
  return candidate;
}

export function captureEnvironment(
  inventory: EnvironmentInventory,
  options?: { profile?: string }
): CaptureDocument {
  const warnings: string[] = [];
  const manifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    profiles: {}
  };
  const lock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: {}
  };

  if (options?.profile && !inventory.profiles[options.profile]) {
    throw new ValidationError(`Profile not found: ${options.profile}`);
  }

  const selectedProfiles = options?.profile
    ? { [options.profile]: inventory.profiles[options.profile] }
    : inventory.profiles;

  for (const [profileName, profileInv] of Object.entries(selectedProfiles)) {
    const profileManifestPlugins: Record<string, PluginManifestEntry> = {};
    const profileLockPlugins: Record<string, PluginLockEntry> = {};
    const usedKeys = new Set<string>();

    for (const [pkgName, plugin] of Object.entries(profileInv.plugins)) {
      if (!plugin.installed) {
        warnings.push(`Package ${pkgName} in profile ${profileName} is declared but not installed`);
      }

      const alias = getAliasFromPackageName(pkgName, usedKeys);
      const isEnabled = plugin.enabled ?? true;

      if (plugin.sourceType === 'npm') {
        const spec = plugin.resolvedSource ?? '';
        // A tarball URL or an npm: alias installs something other than this name from the registry.
        if (spec.includes(':')) {
          warnings.push(
            `Package ${pkgName} in profile ${profileName} is declared as '${spec}', not a registry version; skipped because dshenv installs npm packages from the registry by name`
          );
          continue;
        }
        const version = plugin.version || spec;
        if (!ExactVersionRegex.test(version)) {
          warnings.push(
            `Package ${pkgName} in profile ${profileName} is declared as '${version}' and not installed; skipped because dshenv needs an exact version`
          );
          continue;
        }
        const resolvedFrom =
          typeof plugin.rawPackageJson?._resolved === 'string'
            ? plugin.rawPackageJson._resolved
            : undefined;
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'npm',
            version
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'npm',
            resolvedVersion: version,
            ...(resolvedFrom ? { resolvedFrom } : {})
          }
        };
      } else if (plugin.sourceType === 'git') {
        const parsed = parseGitSpec(plugin.resolvedSource || '');
        if (!parsed) {
          warnings.push(`Package ${pkgName} in profile ${profileName} was skipped: its git spec '${plugin.resolvedSource}' names no commit or ref git can check out`);
          continue;
        }
        if (hasEmbeddedCredentials(parsed.url)) {
          warnings.push(
            `Package ${pkgName} in profile ${profileName} was skipped: its git URL embeds credentials; reinstall it over SSH or a git credential helper`
          );
          continue;
        }
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'git',
            url: parsed.url,
            ...(parsed.ref ? { ref: parsed.ref } : {})
          }
        };
        if (parsed.commit) {
          profileLockPlugins[alias] = {
            package: pkgName,
            source: {
              type: 'git',
              url: parsed.url,
              commit: parsed.commit
            }
          };
        } else {
          warnings.push(`Cannot lock git commit for package ${pkgName} in profile ${profileName}`);
        }
      } else if (plugin.sourceType === 'local-link') {
        const targetPath = plugin.resolvedSource || plugin.targetPath || '';
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'local-link',
            path: targetPath
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'local-link',
            path: targetPath
          }
        };
      } else if (plugin.sourceType === 'local-file') {
        const targetPath = plugin.resolvedSource || plugin.targetPath || '';
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'local-file',
            path: targetPath
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'local-file',
            path: targetPath
          }
        };
      } else if (plugin.sourceType === 'in-box') {
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'in-box'
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'in-box'
          }
        };
      } else {
        warnings.push(`Missing or unknown source metadata for package ${pkgName} in profile ${profileName}`);
      }
    }

    const unmanagedPatches = profileInv.profilePatches?.unmanaged.length ?? 0;
    if (unmanagedPatches > 0) {
      warnings.push(`Profile ${profileName} has ${unmanagedPatches} patch entr${unmanagedPatches === 1 ? 'y' : 'ies'} outside the manifest; adopt takes them over as with dshenv pull`);
    }

    manifest.profiles[profileName] = {
      plugins: profileManifestPlugins
    };
    lock.profiles[profileName] = {
      plugins: profileLockPlugins
    };
  }

  const skills = Object.keys(inventory.skills?.live ?? {}).filter((name) => inventory.skills?.declared[name] === undefined);
  if (skills.length > 0) {
    warnings.push(`Skills outside the manifest in DSH_HOME/skills: ${skills.join(', ')}; adopt takes them over as with dshenv pull`);
  }

  return {
    apiVersion: 'dshenv-capture/v1',
    manifest,
    lock,
    warnings
  };
}

export async function initEnvironment(paths: EnvironmentPaths): Promise<void> {
  const initialManifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    profiles: {}
  };

  const initialLock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: {}
  };

  const initialState: EnvironmentState = {
    apiVersion: 'dshenv-state/v1',
    lastApplied: new Date().toISOString(),
    appliedLockHash: '',
    profiles: {}
  };

  // Checked before writing any, so a refusal does not leave a manifest behind that makes the next init say it is done.
  const existing = [paths.lockFile, paths.stateFile].filter((file) => fs.existsSync(file));
  if (existing.length > 0) {
    throw new ValidationError(
      `${existing.join(' and ')} already ${existing.length > 1 ? 'exist' : 'exists'} without a manifest; move ${existing.length > 1 ? 'them' : 'it'} aside, or write ${paths.manifestFile} by hand`
    );
  }
  await writeAtomic(paths.manifestFile, serializeManifest(initialManifest), 'create');
  await writeAtomic(paths.lockFile, serializeLock(initialLock), 'create');
  await writeAtomic(paths.stateFile, serializeState(initialState), 'create');
}
