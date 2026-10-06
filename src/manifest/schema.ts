import { z } from 'zod';
import { ValidationError } from '../errors.js';
import * as path from 'node:path';
import { PROFILE_PATCHES_ALIAS } from '../profile-patches/entries.js';

// A leading dot is refused so '.' and '..' can never name a directory outside the package's own, and a leading '-'
// so pnpm never reads the name as an option.
export const PackageNameRegex = /^(?:@[a-z0-9_][a-z0-9._-]*\/)?[a-z0-9_][a-z0-9._-]*$/;

// dshenv pins exact npm versions; ranges and tags would never compare equal to an installed version.
// The SemVer 2.0 grammar, as npm takes it: no leading zeros, a prerelease and a build part each optional.
const SemverNumber = '(?:0|[1-9]\\d*)';
const SemverPrerelease = `(?:${SemverNumber}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
export const ExactVersionRegex = new RegExp(
  `^${SemverNumber}\\.${SemverNumber}\\.${SemverNumber}(?:-${SemverPrerelease}(?:\\.${SemverPrerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

const isAbsolutePath = (val: string) => path.isAbsolute(val);

export const NpmSourceSchema = z
  .object({
    type: z.literal('npm'),
    version: z.string().regex(ExactVersionRegex, { message: 'npm version must be an exact version such as 1.2.3' })
  })
  .strict();

const CredentialParamRegex = /^(?:access_?token|private_?token|oauth_?token|token|password|passwd|secret|api_?key|auth)$/i;

// Manifest and lock are meant to be shared, so a URL may not carry a password or token: any userinfo on
// http(s), user:password on other schemes (scp-style and ssh://git@ URLs stay allowed), or a token query parameter.
export function hasEmbeddedCredentials(url: string): boolean {
  const query = url.split('#')[0].split('?')[1];
  if (query !== undefined && [...new URLSearchParams(query).keys()].some((key) => CredentialParamRegex.test(key))) {
    return true;
  }
  const match = url.match(/^(?:git\+)?([a-z][a-z0-9+.-]*):\/\/([^/@]*)@/i);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' ? match[2].length > 0 : match[2].includes(':');
}

// The URL and commit end up as arguments to git and pnpm, where a leading '-' would read as an option.
const gitUrlSchema = z
  .string()
  .min(1)
  .refine((url) => !hasEmbeddedCredentials(url), {
    message: 'Git URL must not embed credentials; use SSH or a git credential helper'
  })
  .refine((url) => !url.startsWith('-'), { message: 'Git URL must not start with -' });

export const GitCommitRegex = /^[0-9a-f]{7,64}$/i;

export const GitSourceSchema = z
  .object({
    type: z.literal('git'),
    url: gitUrlSchema,
    ref: z.string().refine((ref) => !ref.startsWith('-'), { message: 'Git ref must not start with -' }).optional(),
    commit: z.string().regex(GitCommitRegex, { message: 'git commit must be a 7-64 character hexadecimal commit id' }).optional()
  })
  .strict();

export const LocalLinkSourceSchema = z
  .object({
    type: z.literal('local-link'),
    path: z.string().refine(isAbsolutePath, {
      message: 'Local link path must be absolute'
    })
  })
  .strict();

export const LocalFileSourceSchema = z
  .object({
    type: z.literal('local-file'),
    path: z.string().refine(isAbsolutePath, {
      message: 'Local file path must be absolute'
    })
  })
  .strict();

export const InBoxSourceSchema = z
  .object({
    type: z.literal('in-box')
  })
  .strict();

export const PluginSourceSchema = z.discriminatedUnion('type', [
  NpmSourceSchema,
  GitSourceSchema,
  LocalLinkSourceSchema,
  LocalFileSourceSchema,
  InBoxSourceSchema
]);

// Profiles and aliases are object keys; these would resolve to inherited properties instead of entries.
const ReservedKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function assertNotReservedKey(kind: string, name: string): string {
  if (ReservedKeys.has(name)) {
    throw new ValidationError(`${kind} '${name}' is reserved`);
  }
  return name;
}

const notReserved = (name: string) => !ReservedKeys.has(name);

// A profile name becomes a directory under profiles/ and a file name under envctl/, and DSH takes it as an option value.
const ProfileNameRegex = /^[A-Za-z0-9._][-A-Za-z0-9._]*$/;

export function isValidProfileName(name: string): boolean {
  return ProfileNameRegex.test(name) && name !== '.' && name !== '..';
}

export function assertProfileName(name: string): string {
  if (!isValidProfileName(name)) {
    throw new ValidationError(`Invalid profile name: ${name}`);
  }
  return name;
}

export const ProfileNameKeySchema = z
  .string()
  .refine(notReserved, { message: 'Profile name is reserved' })
  .refine(isValidProfileName, { message: "Invalid profile name (allowed: letters, digits, '.', '_', '-'; not '.' or '..')" });

// Aliases appear in single-line patch markers, so whitespace would break or inject into them.
export const PluginAliasSchema = z
  .string()
  .regex(/^\S+$/, { message: 'Plugin alias must not contain whitespace' })
  .refine((name) => notReserved(name) && name !== PROFILE_PATCHES_ALIAS, { message: 'Plugin alias is reserved' })
  // dshenv names its own patch blocks @profile and @mount:<alias>; an alias like them would share their markers.
  .refine((name) => !name.startsWith('@'), { message: "Plugin alias must not start with '@'" });

export const PatchEntrySchema = z
  .object({
    id: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean().optional()
  })
  .strict();

export const ProfilePatchSchema = z
  .record(z.string(), z.unknown())
  .refine((entry) => (typeof entry.id === 'string' && entry.id.length > 0) || Array.isArray(entry.insert), {
    message: 'A profile patch needs an id or an insert list'
  });

export const PluginManifestEntrySchema = z
  .object({
    package: z.string().regex(PackageNameRegex, {
      message: 'Invalid npm package name format'
    }),
    enabled: z.boolean().optional().default(true),
    source: PluginSourceSchema,
    patches: z.array(PatchEntrySchema).optional()
  })
  .strict();

export const ProfileManifestEntrySchema = z
  .object({
    plugins: z.record(PluginAliasSchema, PluginManifestEntrySchema).default({}),
    patches: z.array(ProfilePatchSchema).optional()
  })
  .strict()
  .superRefine((val, ctx) => {
    const seenPackages = new Map<string, string>();
    for (const [key, plugin] of Object.entries(val.plugins)) {
      const existingKey = seenPackages.get(plugin.package);
      if (existingKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate package "${plugin.package}" in profile (used in keys "${existingKey}" and "${key}")`
        });
      } else {
        seenPackages.set(plugin.package, key);
      }
    }
  });

export const EnvironmentConfigSchema = z
  .object({
    sourceRoot: z.string().refine(isAbsolutePath, 'sourceRoot must be absolute').optional(),
    harness: z
      .object({
        sourceDir: z.string().refine(isAbsolutePath, 'sourceDir must be absolute').optional(),
        allowUntestedVersion: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const ManifestSchema = z
  .object({
    apiVersion: z.literal('dshenv/v1'),
    environment: EnvironmentConfigSchema.optional(),
    profiles: z.record(ProfileNameKeySchema, ProfileManifestEntrySchema).default({})
  })
  .strict();

export const NpmLockSourceSchema = z
  .object({
    type: z.literal('npm'),
    resolvedVersion: z.string().min(1),
    integrity: z.string().optional(),
    resolvedFrom: z.string().optional()
  })
  .strict();

export const GitLockSourceSchema = z
  .object({
    type: z.literal('git'),
    url: gitUrlSchema,
    // A branch or tag would let the same lock install different code later.
    commit: z.string().regex(GitCommitRegex, { message: 'git commit must be a 7-64 character hexadecimal commit id' })
  })
  .strict();

export const LocalLinkLockSourceSchema = z
  .object({
    type: z.literal('local-link'),
    path: z.string().refine(isAbsolutePath, 'Path must be absolute'),
    digest: z.string().optional()
  })
  .strict();

export const LocalFileLockSourceSchema = z
  .object({
    type: z.literal('local-file'),
    path: z.string().refine(isAbsolutePath, 'Path must be absolute'),
    digest: z.string().optional()
  })
  .strict();

export const InBoxLockSourceSchema = z
  .object({
    type: z.literal('in-box')
  })
  .strict();

export const PluginLockSourceSchema = z.discriminatedUnion('type', [
  NpmLockSourceSchema,
  GitLockSourceSchema,
  LocalLinkLockSourceSchema,
  LocalFileLockSourceSchema,
  InBoxLockSourceSchema
]);

export const PluginLockEntrySchema = z
  .object({
    package: z.string().regex(PackageNameRegex),
    source: PluginLockSourceSchema
  })
  .strict();

export const ProfileLockEntrySchema = z
  .object({
    plugins: z.record(PluginAliasSchema, PluginLockEntrySchema).default({})
  })
  .strict();

export const LockSchema = z
  .object({
    apiVersion: z.literal('dshenv-lock/v1'),
    profiles: z.record(ProfileNameKeySchema, ProfileLockEntrySchema).default({})
  })
  .strict();

export const PluginStateEntrySchema = z
  .object({
    package: z.string().regex(PackageNameRegex),
    status: z.string(),
    installedVersion: z.string().optional(),
    lastVerified: z.string().optional()
  })
  .strict();

export const ProfileStateEntrySchema = z
  .object({
    plugins: z.record(z.string(), PluginStateEntrySchema).default({})
  })
  .strict();

export const PluginOwnershipRecordSchema = z
  .object({
    package: z.string().regex(PackageNameRegex),
    alias: z.string().min(1),
    sourceType: z.enum(['npm', 'git', 'local-link', 'local-file', 'in-box', 'unknown']),
    lockedVersion: z.string().optional(),
    adoptedAt: z.string().min(1),
    adoptedBy: z.string().min(1)
  })
  .strict();

export const StateSchema = z
  .object({
    apiVersion: z.literal('dshenv-state/v1'),
    lastApplied: z.string(),
    appliedLockHash: z.string(),
    profiles: z.record(z.string(), ProfileStateEntrySchema).default({}),
    appliedOverlay: z.string().min(1).optional(),
    resources: z
      .object({
        plugin: z.record(z.string(), z.record(z.string(), PluginOwnershipRecordSchema)).optional(),
        skill: z.record(z.string(), z.object({ digest: z.string() }).strict()).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const CaptureDocumentSchema = z
  .object({
    apiVersion: z.literal('dshenv-capture/v1'),
    manifest: ManifestSchema,
    lock: LockSchema,
    warnings: z.array(z.string()).default([])
  })
  .strict();
