import type { EnvironmentManifest, EnvironmentOverlay, OverlayPatchEntry, PatchEntry } from '../domain.js';
import { ValidationError } from '../errors.js';
import { ManifestSchema } from '../manifest/schema.js';
import { mergeProfilePatches } from '../profile-patches/entries.js';

export type PluginOrigin = 'base' | `overlay:${string}` | `base+overlay:${string}`;

export interface PluginProvenance {
  origin: PluginOrigin;
  overridden: string[];
}

// profile -> alias -> where the effective plugin entry came from
export type ManifestProvenance = Record<string, Record<string, PluginProvenance>>;

export interface MergeResult {
  manifest: EnvironmentManifest;
  provenance: ManifestProvenance;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

export function baseProvenance(manifest: EnvironmentManifest): ManifestProvenance {
  const provenance: ManifestProvenance = {};
  for (const [profileName, profile] of Object.entries(manifest.profiles)) {
    provenance[profileName] = {};
    for (const alias of Object.keys(profile.plugins)) {
      provenance[profileName][alias] = { origin: 'base', overridden: [] };
    }
  }
  return provenance;
}

function mergePatches(base: PatchEntry[], overrides: OverlayPatchEntry[], where: string): PatchEntry[] {
  const merged = base.map((patch) => ({ ...patch }));
  for (const override of overrides) {
    const existing = merged.find((patch) => patch.id === override.id);
    if (existing) {
      if (override.config) {
        existing.config = deepMerge(existing.config, override.config);
      }
      if (override.enabled !== undefined) {
        existing.enabled = override.enabled;
      }
      continue;
    }
    if (!override.config) {
      throw new ValidationError(`${where}: patch '${override.id}' is not in the base manifest and must declare config`);
    }
    merged.push({
      id: override.id,
      config: override.config,
      ...(override.enabled !== undefined ? { enabled: override.enabled } : {})
    });
  }
  return merged;
}

export function mergeManifest(base: EnvironmentManifest, overlay: EnvironmentOverlay, name: string): MergeResult {
  const manifest = structuredClone(base);
  const provenance = baseProvenance(manifest);

  if (overlay.environment) {
    manifest.environment = deepMerge(
      (manifest.environment ?? {}) as Record<string, unknown>,
      overlay.environment as Record<string, unknown>
    ) as EnvironmentManifest['environment'];
  }

  if (overlay.patches) {
    manifest.patches = mergeProfilePatches(manifest.patches ?? [], overlay.patches);
  }

  for (const [profileName, profileOverlay] of Object.entries(overlay.profiles ?? {})) {
    // Own-property checks, so names like `toString` are not mistaken for inherited members.
    if (!Object.hasOwn(manifest.profiles, profileName)) {
      manifest.profiles[profileName] = { plugins: {} };
    }
    if (!Object.hasOwn(provenance, profileName)) {
      provenance[profileName] = {};
    }
    const target = manifest.profiles[profileName];
    const profileProvenance = provenance[profileName];
    if (profileOverlay.patches) {
      target.patches = mergeProfilePatches(target.patches ?? [], profileOverlay.patches);
    }
    for (const [alias, entry] of Object.entries(profileOverlay.plugins ?? {})) {
      const where = `Overlay '${name}' profile '${profileName}' plugin '${alias}'`;
      const existing = Object.hasOwn(target.plugins, alias) ? target.plugins[alias] : undefined;

      // The base may have dropped a plugin the overlay removes or adjusts, e.g. through a team sync; that entry has nothing left to do.
      if (!existing && (entry.remove || entry.package === undefined)) {
        continue;
      }

      if (entry.remove) {
        delete target.plugins[alias];
        delete profileProvenance[alias];
        continue;
      }

      if (!existing) {
        if (!entry.package || !entry.source) {
          throw new ValidationError(`${where}: a plugin not in the base manifest must declare package and source`);
        }
        target.plugins[alias] = {
          package: entry.package,
          enabled: entry.enabled ?? true,
          source: entry.source,
          ...(entry.patches ? { patches: mergePatches([], entry.patches, where) } : {})
        };
        profileProvenance[alias] = { origin: `overlay:${name}`, overridden: [] };
        continue;
      }

      if (entry.package !== undefined) {
        throw new ValidationError(`${where}: an overlay cannot change package; remove the plugin and add a new alias instead`);
      }
      const overridden: string[] = [];
      if (entry.enabled !== undefined) {
        existing.enabled = entry.enabled;
        overridden.push('enabled');
      }
      if (entry.source) {
        existing.source = entry.source;
        overridden.push('source');
      }
      if (entry.patches) {
        existing.patches = mergePatches(existing.patches ?? [], entry.patches, where);
        overridden.push(...entry.patches.map((patch) => `patches.${patch.id}`));
      }
      profileProvenance[alias] = {
        origin: overridden.length > 0 ? `base+overlay:${name}` : 'base',
        overridden
      };
    }
  }

  const res = ManifestSchema.safeParse(manifest);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ValidationError(`Invalid manifest after applying overlay '${name}': ${issues}`);
  }
  return { manifest: res.data as EnvironmentManifest, provenance };
}
