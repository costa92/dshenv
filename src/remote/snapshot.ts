import type { EnvironmentLock, EnvironmentManifest, EnvironmentOverlay } from '../domain.js';
import { ValidationError } from '../errors.js';
import { loadLock, loadManifest, parseOverlay } from '../manifest/files.js';
import { isTransportHelperUrl } from '../manifest/schema.js';
import { mergeManifest } from '../overlay/merge.js';
import { isUndigestedEntry } from '../source/local.js';
import { listTree, readBlobs, type TreeEntry } from './git.js';
import { lockEntryDigests, lockEntryId } from './lock-entries.js';
import { ENV_KEY_ADVICE, documentSecrets } from '../security/secrets.js';
import { isRemoteFileKey, overlayNameFromKey, sha256Hex, type RemoteLockEntries } from './schema.js';

export interface RemoteSnapshot {
  commit: string;
  files: Record<string, Buffer>;
  // keys of the files Git records as executable (mode 100755)
  executables: string[];
  digests: Record<string, string>;
  manifest: EnvironmentManifest;
  lock: EnvironmentLock | null;
  lockEntries: RemoteLockEntries;
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

// Read under the environment lock and held in memory, so a team repository past these is refused rather than read.
export const MAX_REMOTE_FILES = 10_000;
export const MAX_REMOTE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_REMOTE_TOTAL_BYTES = 100 * 1024 * 1024;

// Everything else under the path (state, selection, backups, sources, nested overlays) is machine-local and ignored.
function candidateKey(rel: string): string | null {
  if (rel === 'manifest.yaml' || rel === 'lock.json') {
    return rel;
  }
  // A file directly under skills/ (a README, .DS_Store) belongs to no skill, and neither does skills/node_modules.
  return /^overlays\/[^/]+\.yaml$/.test(rel) || (/^skills\/[^/]+\/./.test(rel) && !rel.startsWith('skills/node_modules/')) ? rel : null;
}

// Only a network URL (scheme://, or scp-style host:path) names the same repository on every machine. pnpm's own
// protocols (link:../x, file:/x) look like host:path but name a directory here, which pnpm then links or copies.
function isMachineLocalGitUrl(url: string): boolean {
  // A <transport>:: helper runs a program here (ext::) or reads a local descriptor (fd::).
  if (isTransportHelperUrl(url)) {
    return true;
  }
  const scheme = /^(?:git\+)?([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1].toLowerCase();
  if (scheme !== undefined) {
    return scheme === 'file';
  }
  if (/^(?:git\+)?(?:link|file|workspace|portal):/i.test(url)) {
    return true;
  }
  return !/^(?:[^@/:]+@)?[^/:\\]{2,}:/.test(url);
}

function localSourceKind(source: { type: string; url?: string } | undefined): string | null {
  if (source?.type === 'local-link' || source?.type === 'local-file') {
    return `a ${source.type} source`;
  }
  return source?.type === 'git' && source.url !== undefined && isMachineLocalGitUrl(source.url) ? 'a Git URL on this machine' : null;
}

// Local paths and their digests only mean something on the machine that recorded them.
function assertNoLocalSources(lock: EnvironmentLock): void {
  for (const [profile, { plugins }] of Object.entries(lock.profiles)) {
    for (const [alias, entry] of Object.entries(plugins)) {
      const kind = localSourceKind(entry.source);
      if (kind !== null) {
        throw new ValidationError(`Lock entry '${lockEntryId(profile, alias)}' has ${kind}; a team lock cannot pin machine-local paths`);
      }
    }
  }
}

// Same reason as the lock: a machine-local path from untrusted remote content would also be hashed by preview.
function assertNoLocalPluginSources(
  profiles: Record<string, { plugins?: Record<string, { source?: { type: string; url?: string } }> }> | undefined
): void {
  for (const [profile, { plugins }] of Object.entries(profiles ?? {})) {
    for (const [alias, plugin] of Object.entries(plugins ?? {})) {
      const kind = localSourceKind(plugin.source);
      if (kind !== null) {
        throw new ValidationError(
          `Plugin '${lockEntryId(profile, alias)}' has ${kind}; a team configuration cannot reference machine-local paths`
        );
      }
    }
  }
}

// dshenv runs `pnpm --dir <harness.sourceDir> dsh` for read-only commands too, so a team could otherwise run a script it
// synced into envctl/skills on every member's machine.
function assertNoLocalEnvironment(environment: EnvironmentManifest['environment']): void {
  if (environment?.harness?.sourceDir !== undefined) {
    throw new ValidationError(
      'environment.harness.sourceDir names a machine-local DSH checkout that dshenv runs; set it in a local overlay, not in a team configuration'
    );
  }
  if (environment?.sourceRoot !== undefined) {
    throw new ValidationError('environment.sourceRoot names a machine-local path; set it in a local overlay, not in a team configuration');
  }
}

function hasJsExpression(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasJsExpression);
  }
  return typeof value === 'object' && value !== null && Object.entries(value).some(([key, inner]) => key === '__jsExpr' || hasJsExpression(inner));
}

// dshenv writes { __jsExpr } as a cordis `!!js` value, which DSH evaluates; a team must not ship code onto every machine.
function assertNoJsExpressions(
  profiles: Record<string, { plugins?: Record<string, { patches?: unknown[] }>; patches?: unknown[] }> | undefined,
  globalPatches?: unknown[]
): void {
  const refuse = (owner: string) =>
    new ValidationError(
      `${owner} patch has a JavaScript expression (__jsExpr) that DSH would run; set it in a local overlay, not in a team configuration`
    );
  if (hasJsExpression(globalPatches)) {
    throw refuse('Global');
  }
  for (const [profile, { plugins, patches }] of Object.entries(profiles ?? {})) {
    if (hasJsExpression(patches)) {
      throw refuse(`Profile '${profile}'`);
    }
    for (const [alias, plugin] of Object.entries(plugins ?? {})) {
      if (hasJsExpression(plugin.patches)) {
        throw refuse(`Plugin '${lockEntryId(profile, alias)}'`);
      }
    }
  }
}

// A team repository is shared by every member, so a credential committed there leaks to all of them.
function assertNoPlaintextSecrets(doc: Parameters<typeof documentSecrets>[0]): void {
  const found = documentSecrets(doc);
  if (found.length > 0) {
    throw new ValidationError(`Holds plaintext credentials (${found.map((secret) => secret.location).join(', ')}), which a team configuration must not carry; ${ENV_KEY_ADVICE}`);
  }
}

function withFile<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(`Remote file ${file}: ${err.message}`);
    }
    throw err;
  }
}

export async function loadRemoteSnapshot(repoDir: string, commit: string, remotePath: string): Promise<RemoteSnapshot> {
  const prefix = remotePath === '.' ? '' : `${remotePath}/`;
  const files: Record<string, Buffer> = {};
  const executables: string[] = [];
  // The lock is owned per entry, so it is kept apart from the whole-file keys.
  let lockData: Buffer | null = null;
  const wanted: Array<{ key: string; entry: TreeEntry }> = [];
  let totalBytes = 0;
  for (const entry of await listTree(repoDir, commit, remotePath)) {
    if (!entry.path.startsWith(prefix)) {
      continue;
    }
    const key = candidateKey(entry.path.slice(prefix.length));
    if (key === null) {
      continue;
    }
    if (key !== 'lock.json' && !isRemoteFileKey(key)) {
      const kind = key.startsWith('skills/') ? 'skill file' : 'overlay';
      throw new ValidationError(`Remote ${kind} ${entry.path} has an invalid name (allowed: letters, digits, '.', '_', '-')`);
    }
    if (entry.type !== 'blob' || !REGULAR_FILE_MODES.has(entry.mode)) {
      throw new ValidationError(`Remote file ${entry.path} must be a regular file`);
    }
    // Neither copied into DSH nor digested, so the team's change to it would never arrive; .DS_Store is only noise.
    const segments = key.split('/');
    if (key.startsWith('skills/') && segments.slice(2).some((segment) => isUndigestedEntry(segment) && segment !== '.DS_Store')) {
      throw new ValidationError(
        `Remote skill file ${entry.path} is never copied into DSH, which skips node_modules and .tmp-* in a skill; remove it from the team repository`
      );
    }
    if ((entry.size ?? 0) > MAX_REMOTE_FILE_BYTES) {
      throw new ValidationError(`Remote file ${entry.path} is ${entry.size} bytes, more than the ${MAX_REMOTE_FILE_BYTES} dshenv reads from a team repository`);
    }
    totalBytes += entry.size ?? 0;
    wanted.push({ key, entry });
  }
  if (wanted.length > MAX_REMOTE_FILES) {
    throw new ValidationError(`Remote path ${remotePath} holds ${wanted.length} files, more than the ${MAX_REMOTE_FILES} dshenv reads from a team repository`);
  }
  if (totalBytes > MAX_REMOTE_TOTAL_BYTES) {
    throw new ValidationError(`Remote path ${remotePath} holds ${totalBytes} bytes, more than the ${MAX_REMOTE_TOTAL_BYTES} dshenv reads from a team repository`);
  }
  const blobs = await readBlobs(repoDir, wanted.map(({ entry }) => entry.object), totalBytes);
  for (const [index, { key, entry }] of wanted.entries()) {
    if (key === 'lock.json') {
      lockData = blobs[index];
    } else {
      files[key] = blobs[index];
      if (entry.mode === '100755') {
        executables.push(key);
      }
    }
  }

  const where = (key: string) => `${prefix}${key}`;
  if (!files['manifest.yaml']) {
    throw new ValidationError(`Remote commit ${commit} has no ${where('manifest.yaml')}`);
  }
  const manifest = withFile(where('manifest.yaml'), () => {
    const parsed = loadManifest(files['manifest.yaml'].toString('utf8'));
    assertNoLocalEnvironment(parsed.environment);
    assertNoLocalPluginSources(parsed.profiles);
    assertNoJsExpressions(parsed.profiles, parsed.patches);
    assertNoPlaintextSecrets(parsed);
    return parsed;
  });
  const lockText = lockData?.toString('utf8') ?? null;
  const lock = lockText !== null
    ? withFile(where('lock.json'), () => {
        const parsed = loadLock(lockText);
        assertNoLocalSources(parsed);
        return parsed;
      })
    : null;
  // Overlay names are file names, and on a case-insensitive file system these two would be one file.
  const byLowerCase = new Map<string, string>();
  for (const key of Object.keys(files)) {
    if (overlayNameFromKey(key) === null) {
      continue;
    }
    const other = byLowerCase.get(key.toLowerCase());
    if (other !== undefined) {
      throw new ValidationError(`Remote overlays ${where(other)} and ${where(key)} differ only by case`);
    }
    byLowerCase.set(key.toLowerCase(), key);
  }
  // A skill path (a skill name, a directory or a file) that differs from another only by case would be the same one there too.
  const skillPaths = new Map<string, string>();
  for (const key of Object.keys(files).filter((name) => name.startsWith('skills/')).sort()) {
    const segments = key.split('/');
    for (let depth = 2; depth <= segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('/');
      const other = skillPaths.get(prefix.toLowerCase());
      if (other !== undefined && other !== prefix) {
        throw new ValidationError(`Remote skill paths ${where(other)} and ${where(prefix)} differ only by case`);
      }
      skillPaths.set(prefix.toLowerCase(), prefix);
    }
  }
  const overlays: EnvironmentOverlay[] = [];
  for (const key of Object.keys(files)) {
    const name = overlayNameFromKey(key);
    if (name === null) {
      continue;
    }
    withFile(where(key), () => {
      const overlay = parseOverlay(files[key].toString('utf8'), where(key));
      overlays.push(overlay);
      assertNoLocalEnvironment(overlay.environment);
      assertNoLocalPluginSources(overlay.profiles);
      assertNoJsExpressions(overlay.profiles, overlay.patches);
      assertNoPlaintextSecrets(overlay);
      mergeManifest(manifest, overlay, name);
    });
  }

  // An entry no team layer declares would pin, and lock against local changes, a plugin only a local overlay adds.
  for (const [profile, { plugins }] of Object.entries(lock?.profiles ?? {})) {
    for (const alias of Object.keys(plugins)) {
      const inBase = Object.hasOwn(manifest.profiles[profile]?.plugins ?? {}, alias);
      const inOverlay = overlays.some((overlay) => overlay.profiles?.[profile]?.plugins?.[alias]?.package !== undefined);
      if (!inBase && !inOverlay) {
        throw new ValidationError(
          `Remote file ${where('lock.json')}: lock entry '${lockEntryId(profile, alias)}' is declared by neither the team manifest nor a team overlay; remove it from the team lock`
        );
      }
    }
  }

  const digests = Object.fromEntries(Object.entries(files).map(([key, data]) => [key, sha256Hex(data)]));
  return { commit, files, executables, digests, manifest, lock, lockEntries: lockEntryDigests(lock) };
}
