import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { SourceType } from '../domain.js';
import { PackageNameRegex } from '../manifest/schema.js';
import { extractManagedPatches, needsPatchFileRepair, type ExtractedPatch } from '../patch/patch.js';
import { HOME_PATCH_TARGET, readProfilePatchState, type ProfilePatchState } from '../profile-patches/entries.js';
import { isBundlePackage, readMounts } from '../patch/mount.js';
import { readSkillInventory, type SkillInventory } from '../resources/skill.js';

export interface InstalledPluginInfo {
  name: string;
  installed: boolean;
  version?: string;
  sourceType: SourceType;
  resolvedSource?: string;
  isSymlink: boolean;
  isExternalSymlink: boolean;
  targetPath?: string;
  rawPackageJson?: Record<string, unknown>;
  // False for a plugin package without dsh.bundle, which DSH loads through an insert row instead of the bundle list.
  bundle?: boolean;
  enabled?: boolean;
}

export interface ProfileInventory {
  name: string;
  path: string;
  plugins: Record<string, InstalledPluginInfo>;
  rawProfile?: Record<string, unknown>;
  managedPatches?: ExtractedPatch[];
  // Alias -> package of each dshenv mount row in cordis.patch.yml.
  mounts?: Record<string, string>;
  // cordis.patch.yml is invalid YAML that rewriting any managed block would repair.
  patchFileRepairable?: boolean;
  // The profile's own patch entries; absent when the file is missing or not a readable array.
  profilePatches?: ProfilePatchState;
}

export interface EnvironmentInventory {
  profiles: Record<string, ProfileInventory>;
  skills?: SkillInventory;
  // $DSH_HOME/cordis.patch.yml; absent when the file does not exist.
  homePatches?: ProfilePatchState;
  // Why the global file could not be read; dshenv then leaves it alone.
  homePatchesError?: string;
}

const MAX_JSON_SIZE = 1024 * 1024; // 1 MiB

const GIT_SPEC_RE =
  /^(github:|gitlab:|bitbucket:|gist:|git\+|git:\/\/|git@)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeReadJson(filePath: string): unknown | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_JSON_SIZE) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && PackageNameRegex.test(key)) {
      result[key] = entry;
    }
  }
  return result;
}

export function classifyDependencySpec(
  spec: string,
  profileDir: string
): { sourceType: SourceType; resolvedSource?: string } {
  const trimmed = spec.trim();
  if (trimmed.startsWith('link:')) {
    const rawPath = trimmed.slice('link:'.length);
    const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(profileDir, rawPath);
    return { sourceType: 'local-link', resolvedSource: resolved };
  }
  if (trimmed.startsWith('file:')) {
    const rawPath = trimmed.slice('file:'.length);
    const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(profileDir, rawPath);
    return { sourceType: 'local-file', resolvedSource: resolved };
  }
  if (GIT_SPEC_RE.test(trimmed)) {
    return { sourceType: 'git', resolvedSource: trimmed };
  }
  if (/^https?:\/\//i.test(trimmed) && /(github\.com|gitlab\.com|bitbucket\.org|\.git(?:$|[?#]))/i.test(trimmed)) {
    return { sourceType: 'git', resolvedSource: trimmed };
  }
  return { sourceType: 'npm', resolvedSource: trimmed };
}

interface InstallInspection {
  present: boolean;
  isSymlink: boolean;
  isExternalSymlink: boolean;
  targetPath?: string;
  version?: string;
  rawPackageJson?: Record<string, unknown>;
}

async function inspectInstallPath(pkgPath: string, profileDir: string): Promise<InstallInspection> {
  const empty: InstallInspection = {
    present: false,
    isSymlink: false,
    isExternalSymlink: false
  };

  try {
    const lstat = await fs.promises.lstat(pkgPath);
    const isSymlink = lstat.isSymbolicLink();
    let targetPath: string | undefined;
    let isExternalSymlink = false;

    try {
      targetPath = await fs.promises.realpath(pkgPath);
      const profileReal = await fs.promises.realpath(profileDir);
      isExternalSymlink = !isPathInside(profileReal, targetPath);
    } catch {
      if (isSymlink) {
        return {
          present: true,
          isSymlink: true,
          isExternalSymlink: true
        };
      }
      return { present: true, isSymlink: false, isExternalSymlink: false };
    }

    if (isExternalSymlink) {
      return {
        present: true,
        isSymlink,
        isExternalSymlink: true,
        targetPath
      };
    }

    const packageJsonPath = path.join(pkgPath, 'package.json');
    try {
      const metaReal = await fs.promises.realpath(packageJsonPath);
      const profileReal = await fs.promises.realpath(profileDir);
      if (!isPathInside(profileReal, metaReal)) {
        return {
          present: true,
          isSymlink,
          isExternalSymlink: true,
          targetPath
        };
      }
    } catch {
      return {
        present: true,
        isSymlink,
        isExternalSymlink: false,
        targetPath
      };
    }

    const pkgJson = safeReadJson(packageJsonPath) as Record<string, unknown> | null;
    const version = pkgJson?.version && typeof pkgJson.version === 'string' ? pkgJson.version : undefined;

    return {
      present: true,
      isSymlink,
      isExternalSymlink: false,
      targetPath,
      version,
      rawPackageJson: pkgJson || undefined
    };
  } catch {
    return empty;
  }
}

function nodeModulesPackagePath(profileDir: string, packageName: string): string {
  return path.join(profileDir, 'node_modules', ...packageName.split('/'));
}

function readHomePatches(paths: EnvironmentPaths): Pick<EnvironmentInventory, 'homePatches' | 'homePatchesError'> {
  const file = path.join(paths.home, 'cordis.patch.yml');
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return {};
    if (stat.size > MAX_JSON_SIZE) return { homePatchesError: `${file} exceeds 1 MiB` };
    return { homePatches: readProfilePatchState(fs.readFileSync(file, 'utf8'), HOME_PATCH_TARGET) };
  } catch (err) {
    return { homePatchesError: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function readEnvironmentInventory(
  paths: EnvironmentPaths
): Promise<EnvironmentInventory> {
  const result: EnvironmentInventory = {
    profiles: {},
    skills: await readSkillInventory(paths),
    ...readHomePatches(paths)
  };

  if (!fs.existsSync(paths.profilesDir)) {
    return result;
  }

  const entries = await fs.promises.readdir(paths.profilesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const profileName = entry.name;
    const profilePath = path.join(paths.profilesDir, profileName);
    const packageJsonPath = path.join(profilePath, 'package.json');
    const rawProfileData = safeReadJson(packageJsonPath);
    if (!isRecord(rawProfileData) || !isRecord(rawProfileData.dsh) || !isRecord(rawProfileData.dsh.profile)) {
      continue;
    }

    const bundlesRaw = rawProfileData.dsh.profile.bundles;
    const bundleNames = Array.isArray(bundlesRaw)
      ? bundlesRaw.filter((name): name is string => typeof name === 'string' && PackageNameRegex.test(name))
      : [];

    const dependencies = {
      ...stringRecord(rawProfileData.optionalDependencies),
      ...stringRecord(rawProfileData.dependencies)
    };

    const patchFile = path.join(profilePath, 'cordis.patch.yml');
    let managedPatches: ExtractedPatch[] = [];
    let patchFileRepairable = false;
    let profilePatches: ProfilePatchState | undefined;
    let mounts: Record<string, string> = {};
    try {
      const patchStat = fs.statSync(patchFile);
      if (patchStat.size <= MAX_JSON_SIZE) {
        const patchContent = fs.readFileSync(patchFile, 'utf8');
        managedPatches = extractManagedPatches(patchContent, profileName);
        patchFileRepairable = needsPatchFileRepair(patchContent);
        profilePatches = readProfilePatchState(patchContent, profileName);
        mounts = readMounts(patchContent, profileName);
      }
    } catch {
      // A missing or unreadable file has no patches to report.
    }

    const mounted = new Set(Object.values(mounts));
    const names = new Set<string>([...Object.keys(dependencies), ...bundleNames]);
    const plugins: Record<string, InstalledPluginInfo> = {};

    for (const pkgName of names) {
      const spec = dependencies[pkgName];
      const classified = spec
        ? classifyDependencySpec(spec, profilePath)
        : { sourceType: 'in-box' as const };
      const inspection = await inspectInstallPath(nodeModulesPackagePath(profilePath, pkgName), profilePath);
      const installed = classified.sourceType === 'in-box' || inspection.present;
      // DSH loads a listed bundle only when its package declares dsh.bundle; any other plugin loads through an
      // insert row (patch/mount). DSH reads a linked package through its link, so the bundle check does too,
      // though no other metadata is taken from outside the profile. An unreadable package.json keeps the bundle reading.
      const pkgPath = nodeModulesPackagePath(profilePath, pkgName);
      const raw = inspection.rawPackageJson ?? (inspection.present ? safeReadJson(path.join(pkgPath, 'package.json')) : null);
      const bundle = classified.sourceType === 'in-box' || !isRecord(raw) || isBundlePackage(raw);

      plugins[pkgName] = {
        name: pkgName,
        installed,
        version: inspection.version,
        sourceType: classified.sourceType,
        resolvedSource: classified.resolvedSource,
        isSymlink: inspection.isSymlink,
        isExternalSymlink: inspection.isExternalSymlink,
        targetPath: inspection.targetPath,
        rawPackageJson: inspection.rawPackageJson,
        bundle,
        enabled: bundle ? bundleNames.includes(pkgName) : mounted.has(pkgName)
      };
    }

    result.profiles[profileName] = {
      name: profileName,
      path: profilePath,
      plugins,
      rawProfile: rawProfileData,
      managedPatches,
      mounts,
      ...(patchFileRepairable ? { patchFileRepairable } : {}),
      ...(profilePatches ? { profilePatches } : {})
    };
  }

  return result;
}
