import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentManifest, PatchEntry } from '../domain.js';
import { ValidationError } from '../errors.js';
import { computePatchDigest, extractManagedPatches } from '../patch/patch.js';
import { readProfilePatchFile } from '../apply/patches.js';

export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Keys that reach an object's prototype instead of a config field.
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function assertConfigPath(dottedPath: string): string[] {
  const parts = dottedPath.split('.');
  if (!dottedPath.trim() || parts.some((part) => part.length === 0 || UNSAFE_PATH_SEGMENTS.has(part))) {
    throw new ValidationError(`Invalid config path: ${dottedPath}`);
  }
  return parts;
}

export function setAtPath(target: Record<string, unknown>, dottedPath: string, value: unknown): Record<string, unknown> {
  const parts = assertConfigPath(dottedPath);
  const next: Record<string, unknown> = { ...target };
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (i === parts.length - 1) {
      cursor[key] = value;
      break;
    }
    const child = cursor[key];
    const copy = child && typeof child === 'object' && !Array.isArray(child)
      ? { ...(child as Record<string, unknown>) }
      : {};
    cursor[key] = copy;
    cursor = copy;
  }
  return next;
}

export function getAtPath(target: Record<string, unknown>, dottedPath: string): unknown {
  const parts = dottedPath.split('.');
  let cursor: unknown = target;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

// Removes one key; parents it leaves empty go too. False when the key is not there.
export function unsetAtPath(target: Record<string, unknown>, dottedPath: string): boolean {
  const [head, ...rest] = dottedPath.split('.');
  if (!Object.hasOwn(target, head)) {
    return false;
  }
  if (rest.length === 0) {
    delete target[head];
    return true;
  }
  const child = target[head];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    return false;
  }
  const removed = unsetAtPath(child as Record<string, unknown>, rest.join('.'));
  if (removed && Object.keys(child as Record<string, unknown>).length === 0) {
    delete target[head];
  }
  return removed;
}

export async function readPluginConfig(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  profileName: string,
  alias: string
): Promise<{ source: 'live' | 'manifest'; id: string; config: Record<string, unknown>; digest?: string; digestValid?: boolean }> {
  const plugin = manifest.profiles[profileName]?.plugins[alias];
  if (!plugin) {
    throw new ValidationError(`Plugin '${alias}' not found in profile '${profileName}'`);
  }

  const live = extractManagedPatches(await readProfilePatchFile(paths, profileName), profileName)
    .find((patch) => patch.plugin === alias);
  if (live) {
    return {
      source: 'live',
      id: live.id ?? alias,
      config: live.config,
      digest: live.digest,
      digestValid: live.isDigestValid
    };
  }

  const declared = plugin.patches?.find((patch) => patch.enabled !== false);
  return {
    source: 'manifest',
    id: declared?.id ?? alias,
    config: declared?.config ?? {},
    digest: declared ? computePatchDigest(declared.config) : undefined,
    digestValid: declared ? true : undefined
  };
}

export function disabledPatches(alias: string, profileName: string): ValidationError {
  return new ValidationError(
    `Every config patch of '${alias}' in profile '${profileName}' is disabled (enabled: false), so apply would never write the key; enable one or remove them first`
  );
}

export function upsertPluginPatch(
  manifest: EnvironmentManifest,
  profileName: string,
  alias: string,
  dottedPath: string,
  value: unknown,
  newId = alias
): PatchEntry {
  const plugin = manifest.profiles[profileName]?.plugins[alias];
  if (!plugin) {
    throw new ValidationError(`Plugin '${alias}' not found in profile '${profileName}'`);
  }
  const patches = plugin.patches ?? [];
  const index = patches.findIndex((patch) => patch.enabled !== false);
  if (patches.length > 0 && index === -1) {
    throw disabledPatches(alias, profileName);
  }
  const current: PatchEntry = patches[index] ?? { id: newId, config: {} };
  const next: PatchEntry = { ...current, config: setAtPath(current.config, dottedPath, value) };
  plugin.patches = index === -1 ? [next] : patches.map((patch, i) => (i === index ? next : patch));
  return next;
}
