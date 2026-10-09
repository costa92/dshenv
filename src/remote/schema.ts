import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { TRANSPORT_HELPER_MESSAGE, hasEmbeddedCredentials, isTransportHelperUrl, isValidGitRef } from '../manifest/schema.js';
import { isValidOverlayName } from '../overlay/selection.js';

export const REMOTE_API_VERSION = 'dshenv-remote/v1';
export const DEFAULT_REMOTE_PATH = 'envctl';

// SHA-1 or, for a repository created with --object-format=sha256, SHA-256.
const CommitShaRegex = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const Sha256Regex = /^[0-9a-f]{64}$/;
// The branch ends up in a git refspec; a leading '-' could be read as an option.
const BranchRegex = /^(?!-)[A-Za-z0-9._/-]+$/;
const OverlayKeyRegex = /^overlays\/([^/]+)\.yaml$/;

export function overlayNameFromKey(key: string): string | null {
  const match = OverlayKeyRegex.exec(key);
  return match ? match[1] : null;
}

const SkillNameRegex = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// skills/<name>/<file...>: the path segments below envctl/skills, or null for any other key.
export function skillPathFromKey(key: string): string[] | null {
  const segments = key.split('/');
  if (segments[0] !== 'skills' || segments.length < 3 || !SkillNameRegex.test(segments[1])) {
    return null;
  }
  const rest = segments.slice(1);
  return rest.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\')) ? rest : null;
}

// lock.json is not a file key: the lock is owned per entry through lockEntries.
export function isRemoteFileKey(key: string): boolean {
  if (key === 'manifest.yaml') {
    return true;
  }
  const name = overlayNameFromKey(key);
  return (name !== null && isValidOverlayName(name)) || skillPathFromKey(key) !== null;
}

// '.' is the repository root; any other value is relative and never climbs out of it.
export function isValidRemotePath(value: string): boolean {
  if (value === '.') {
    return true;
  }
  return value.split('/').every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..');
}

export function isValidBranchName(value: string): boolean {
  return BranchRegex.test(value) && isValidGitRef(value);
}

export function compareRemoteKeys(a: string, b: string): number {
  const rank = (key: string) => (key === 'manifest.yaml' ? 0 : 1);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

const DigestSchema = z.string().regex(Sha256Regex, { message: 'Digest must be a 64-character lowercase hex SHA-256' });

export const RemoteConfigSchema = z
  .object({
    apiVersion: z.literal(REMOTE_API_VERSION),
    url: z
      .string()
      .min(1)
      .refine((url) => !hasEmbeddedCredentials(url), { message: 'Git URL must not embed credentials; use SSH or a git credential helper' })
      .refine((url) => !url.startsWith('-'), { message: 'Git URL must not start with -' })
      .refine((url) => !isTransportHelperUrl(url), { message: TRANSPORT_HELPER_MESSAGE }),
    branch: z.string().refine(isValidBranchName, { message: 'Invalid branch name' }),
    path: z.string().refine(isValidRemotePath, { message: "Path must be '.' or a relative directory without '.' or '..' segments" }),
    commit: z.string().regex(CommitShaRegex, { message: 'Commit must be a 40- or 64-character lowercase hex commit id' }),
    files: z
      .record(
        z.string().refine(isRemoteFileKey, { message: 'File must be manifest.yaml or overlays/<name>.yaml' }),
        DigestSchema
      )
      .refine((files) => Object.hasOwn(files, 'manifest.yaml'), { message: 'files must include manifest.yaml' }),
    lockEntries: z.record(z.string().min(1), z.record(z.string().min(1), DigestSchema))
  })
  .strict();

export type RemoteLockEntries = Record<string, Record<string, string>>;
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export function parseRemoteConfig(content: string, file: string): RemoteConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ValidationError(`Invalid JSON in remote file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = RemoteConfigSchema.safeParse(raw);
  if (!res.success) {
    // Record key failures only say "Invalid key in record"; the reason lives in the nested issues.
    const issues = res.error.issues
      .map((i) => `${i.path.join('.')}: ${i.code === 'invalid_key' ? i.issues.map((nested) => nested.message).join(', ') : i.message}`)
      .join(', ');
    throw new ValidationError(`Invalid remote file ${file}: ${issues}`);
  }
  return res.data;
}

export function readRemoteConfig(paths: EnvironmentPaths): RemoteConfig | null {
  if (!fs.existsSync(paths.remoteFile)) {
    return null;
  }
  return parseRemoteConfig(fs.readFileSync(paths.remoteFile, 'utf8'), paths.remoteFile);
}

export function serializeRemoteConfig(config: RemoteConfig): string {
  const files = Object.fromEntries(Object.keys(config.files).sort(compareRemoteKeys).map((key) => [key, config.files[key]]));
  const lockEntries = Object.fromEntries(
    Object.keys(config.lockEntries)
      .sort()
      .map((profile) => {
        const aliases = config.lockEntries[profile];
        return [profile, Object.fromEntries(Object.keys(aliases).sort().map((alias) => [alias, aliases[alias]]))];
      })
  );
  const ordered = { apiVersion: config.apiVersion, url: config.url, branch: config.branch, path: config.path, commit: config.commit, files, lockEntries };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeRemoteConfig(paths: EnvironmentPaths, config: RemoteConfig): Promise<void> {
  const content = serializeRemoteConfig(config);
  // Never write a file the next command could not read back.
  parseRemoteConfig(content, paths.remoteFile);
  await writeAtomic(paths.remoteFile, content, 'overwrite');
}

export function remoteFilePath(paths: EnvironmentPaths, key: string): string {
  if (key === 'manifest.yaml') {
    return paths.manifestFile;
  }
  const skillPath = skillPathFromKey(key);
  if (skillPath) {
    return path.join(paths.skillsDir, ...skillPath);
  }
  const name = overlayNameFromKey(key);
  if (name === null || !isValidOverlayName(name)) {
    throw new ValidationError(`Invalid remote file key: ${key}`);
  }
  return path.join(paths.overlaysDir, `${name}.yaml`);
}

export function remoteOverlayKeys(config: RemoteConfig | null): string[] {
  return Object.keys(config?.files ?? {}).filter((key) => overlayNameFromKey(key) !== null).sort(compareRemoteKeys);
}

export function remoteRepoDir(paths: EnvironmentPaths): string {
  return path.join(paths.remoteDir, 'repo.git');
}

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
