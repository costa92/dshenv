import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { ValidationError, DshError } from '../errors.js';
import { isValidProfileName } from '../manifest/schema.js';

// Variables like these locate the repository instead of the directory git runs in; inherited from a git hook or a CI
// step, they would make every command below inspect, merge or lock another repository.
const REPOSITORY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];

export function isolatedGit(): { env: NodeJS.ProcessEnv; extendEnv: false } {
  const env = { ...process.env };
  for (const name of REPOSITORY_ENV) delete env[name];
  return { env, extendEnv: false };
}

export interface GitWorkingTreeStatus {
  isGitRepo: boolean;
  isDirty: boolean;
  // Why git could not tell whether the tree is clean; isDirty is then true, so nothing treats it as clean.
  statusError?: string;
  commit?: string;
  branch?: string;
  trackingBranch?: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function managedGitSourceDir(
  managerDir: string,
  profileName: string,
  packageName: string
): string {
  if (!isValidProfileName(profileName)) {
    throw new ValidationError(`Invalid profile name: ${profileName}`);
  }
  const safePackage = packageName.replaceAll('/', '_').replaceAll('\\', '_');
  if (!/^[-A-Za-z0-9._@]+$/.test(safePackage) || safePackage.startsWith('.')) {
    throw new ValidationError(`Invalid package name for managed source: ${packageName}`);
  }
  const dir = path.join(path.resolve(managerDir), 'sources', profileName, safePackage);
  if (!isPathInside(managerDir, dir)) {
    throw new ValidationError(`Managed source path escapes envctl: ${dir}`);
  }
  return dir;
}

// pnpm reads a plain repository path as a local directory to link, or a GitHub shorthand, never as a Git repository.
export function normalizeGitUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\\@]+@[^/\\:]+:/.test(url)) {
    return url;
  }
  return path.isAbsolute(url) || /^\.\.?[\\/]/.test(url) || fs.existsSync(url) ? pathToFileURL(path.resolve(url)).href : url;
}

export function packageNameFromGitUrl(url: string): string {
  // A local repository on Windows is a path with backslashes.
  const trimmed = url.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const segment = trimmed.split(/[\\/]/).filter(Boolean).pop();
  if (!segment) {
    throw new ValidationError(`Cannot derive package name from git URL: ${url}`);
  }
  return segment;
}

export function resolvePluginSourcePath(
  pluginName: string,
  explicitSourceRoot?: string
): string {
  const baseRoot = explicitSourceRoot || process.env.DSH_PLUGIN_SOURCE_HOME;
  if (!baseRoot) {
    throw new ValidationError('No plugin source root: pass one or set DSH_PLUGIN_SOURCE_HOME');
  }
  const sanitizedName = pluginName.includes('/') ? pluginName.split('/')[1] : pluginName;
  return path.resolve(baseRoot, sanitizedName);
}

export async function inspectGitWorkingTree(
  repoDir: string
): Promise<GitWorkingTreeStatus> {
  if (!fs.existsSync(repoDir)) {
    return { isGitRepo: false, isDirty: false };
  }

  const gitDir = path.join(repoDir, '.git');
  if (!fs.existsSync(gitDir)) {
    return { isGitRepo: false, isDirty: false };
  }

  let isDirty: boolean;
  let statusError: string | undefined;
  try {
    const statusRes = await execa('git', ['status', '--porcelain'], { ...isolatedGit(),
      cwd: repoDir,
      shell: false,
      timeout: 10000
    });
    isDirty = statusRes.stdout.trim().length > 0;
  } catch (err) {
    isDirty = true;
    const stderr = (err as { stderr?: unknown }).stderr;
    statusError = (typeof stderr === 'string' && stderr.trim().split('\n')[0]) || (err instanceof Error ? err.message : String(err));
  }

  try {
    // A repository without commits yet has no HEAD, but its status above still counts.
    const commitRes = await execa('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { ...isolatedGit(),
      cwd: repoDir,
      shell: false,
      reject: false,
      timeout: 5000
    });
    const commit = commitRes.exitCode === 0 ? commitRes.stdout.trim() : undefined;

    let branch: string | undefined;
    try {
      const branchRes = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { ...isolatedGit(),
        cwd: repoDir,
        shell: false,
        timeout: 5000
      });
      branch = branchRes.stdout.trim() !== 'HEAD' ? branchRes.stdout.trim() : undefined;
    } catch {
      // detached head
    }

    return {
      isGitRepo: true,
      isDirty,
      ...(statusError !== undefined ? { statusError } : {}),
      ...(commit !== undefined ? { commit } : {}),
      branch
    };
  } catch {
    return { isGitRepo: true, isDirty, ...(statusError !== undefined ? { statusError } : {}) };
  }
}

// git reads an argument starting with '-' as an option, wherever it stands.
function assertNotOptionLike(kind: string, value: string): void {
  if (value.startsWith('-')) {
    throw new ValidationError(`${kind} must not start with -: ${value}`);
  }
}

export async function cloneManagedGit(
  url: string,
  targetDir: string,
  ref?: string
): Promise<{ commit: string }> {
  if (!path.isAbsolute(targetDir)) {
    throw new ValidationError(`Target directory must be absolute: ${targetDir}`);
  }

  assertNotOptionLike('Git URL', url);
  if (ref) {
    assertNotOptionLike('Git ref', ref);
  }

  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });

  await execa('git', ['clone', ...(ref ? ['--branch', ref] : []), '--', url, targetDir], { ...isolatedGit(), shell: false, timeout: 60000 });

  const commitRes = await execa('git', ['rev-parse', 'HEAD'], { ...isolatedGit(),
    cwd: targetDir,
    shell: false,
    timeout: 5000
  });

  return { commit: commitRes.stdout.trim() };
}

// Detaches a fresh clone at a commit; null when the clone does not have it.
export async function checkoutCommit(repoDir: string, commit: string): Promise<string | null> {
  assertNotOptionLike('Git commit', commit);
  const checkout = await execa('git', ['checkout', '--quiet', '--detach', `${commit}^{commit}`], { ...isolatedGit(), cwd: repoDir, shell: false, timeout: 30000, reject: false });
  if (checkout.exitCode !== 0) {
    return null;
  }
  const head = await execa('git', ['rev-parse', 'HEAD'], { ...isolatedGit(), cwd: repoDir, shell: false, timeout: 5000 });
  return head.stdout.trim();
}

export interface FastForwardOptions {
  // A clone dshenv manages may also move back, e.g. to the commit the manifest pins.
  managed?: boolean;
  // What a detached HEAD follows when no ref is given.
  detachedRef?: string;
  // Commit dependent metadata before accepting the move; failure restores the checkout.
  afterUpdate?: (result: { previousCommit: string; newCommit: string }) => Promise<void>;
  // Fetch and resolve where the checkout would move, but leave it and the metadata where they are.
  dryRun?: boolean;
}

export async function safeFastForwardManagedGit(
  repoDir: string,
  ref?: string,
  options: FastForwardOptions = {}
): Promise<{ previousCommit: string; newCommit: string }> {
  if (ref !== undefined) {
    assertNotOptionLike('Git ref', ref);
  }
  const status = await inspectGitWorkingTree(repoDir);
  if (!status.isGitRepo) {
    throw new ValidationError(`Directory is not a git repository: ${repoDir}`);
  }
  if (status.isDirty) {
    throw new DshError(
      `Refusing to update Git source with dirty working tree at ${repoDir}. Commit or stash changes manually before proceeding.`,
      1
    );
  }

  const previousCommit = status.commit || 'unknown';

  const branch = await execa('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { ...isolatedGit(), cwd: repoDir, shell: false, reject: false, timeout: 5000 });
  const targetCommitOrRef = ref ?? (branch.exitCode === 0 ? branch.stdout.trim() : options.detachedRef);
  if (targetCommitOrRef === undefined) {
    throw new ValidationError(`${repoDir} is on a detached HEAD; pass --ref <ref>`);
  }

  await execa('git', ['fetch', '--all'], { ...isolatedGit(), cwd: repoDir, shell: false, timeout: 30000 });
  // A bare branch name would resolve to the local branch, which never moves on its own; follow its upstream copy.
  // show-ref matches whole ref names only, so revisions such as HEAD~1 keep their meaning; origin/HEAD is not a branch.
  const upstream =
    targetCommitOrRef === 'HEAD'
      ? null
      : await execa('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${targetCommitOrRef}`], { ...isolatedGit(),
          cwd: repoDir,
          shell: false,
          reject: false,
          timeout: 5000
        });
  const target = upstream?.exitCode === 0 ? `origin/${targetCommitOrRef}` : targetCommitOrRef;
  const resolved = await execa('git', ['rev-parse', '--verify', '--quiet', `${target}^{commit}`], { ...isolatedGit(), cwd: repoDir, shell: false, reject: false, timeout: 5000 });
  if (resolved.exitCode !== 0) {
    throw new ValidationError(`Git ref not found in ${repoDir}: ${targetCommitOrRef}`);
  }
  // merge --ff-only to a commit behind HEAD says "Already up to date" and succeeds, moving nothing.
  const ahead = await execa('git', ['merge-base', '--is-ancestor', 'HEAD', resolved.stdout.trim()], { ...isolatedGit(), cwd: repoDir, shell: false, reject: false, timeout: 5000 });
  if (options.dryRun && (ahead.exitCode === 0 || options.managed)) {
    return { previousCommit, newCommit: resolved.stdout.trim() };
  }
  if (ahead.exitCode === 0) {
    await execa('git', ['merge', '--ff-only', target], { ...isolatedGit(), cwd: repoDir, shell: false, timeout: 10000 });
  } else if (options.managed) {
    await execa('git', ['checkout', '--quiet', '--detach', resolved.stdout.trim()], { ...isolatedGit(), cwd: repoDir, shell: false, timeout: 30000 });
  } else {
    throw new ValidationError(`${targetCommitOrRef} is not ahead of the checked-out commit; source sync only fast-forwards a checkout outside envctl`);
  }

  const newCommitRes = await execa('git', ['rev-parse', 'HEAD'], { ...isolatedGit(),
    cwd: repoDir,
    shell: false,
    timeout: 5000
  });

  const result = { previousCommit, newCommit: newCommitRes.stdout.trim() };
  try {
    await options.afterUpdate?.(result);
  } catch (error) {
    if (result.newCommit !== previousCommit) {
      try {
        const current = await inspectGitWorkingTree(repoDir);
        const expectedBranch = ahead.exitCode === 0 ? status.branch : undefined;
        if (current.isDirty || current.commit !== result.newCommit || current.branch !== expectedBranch) {
          throw new Error('checkout changed after sync; refusing to overwrite it');
        }
        // --keep refuses conflicting edits, unlike --hard. Preserve the original branch or detached HEAD.
        await execa('git', ['reset', '--keep', previousCommit], { ...isolatedGit(), cwd: repoDir, shell: false, timeout: 10000 });
        if (status.branch && current.branch !== status.branch) {
          await execa('git', ['checkout', '--quiet', status.branch], { ...isolatedGit(), cwd: repoDir, shell: false, timeout: 10000 });
        }
      } catch (restoreError) {
        throw new DshError(`Source sync failed: ${error instanceof Error ? error.message : String(error)}; could not restore ${repoDir} to ${previousCommit}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    throw error;
  }
  return result;
}

function comparableGitUrl(url: string): string {
  return url.trim().replace(/^git\+/, '').replace(/^file:\/\//, '').replace(/\/+$/, '').replace(/\.git$/, '');
}

// Whether two spellings of a git URL (git+ prefix, trailing slash, .git suffix) name the same repository.
export function sameGitUrl(a: string, b: string): boolean {
  return comparableGitUrl(a) === comparableGitUrl(b);
}

// A lock pins what the declared URL serves, so the checkout must come from that repository and its commit be pushed there.
export async function assertCheckoutServes(repoDir: string, declaredUrl: string): Promise<void> {
  const origin = await execa('git', ['remote', 'get-url', 'origin'], { ...isolatedGit(), cwd: repoDir, shell: false, reject: false, timeout: 5000 });
  const originUrl = origin.exitCode === 0 ? origin.stdout.trim() : '';
  if (comparableGitUrl(originUrl) !== comparableGitUrl(declaredUrl)) {
    throw new ValidationError(
      `The origin of ${repoDir} (${originUrl || 'none'}) is not the repository the manifest declares (${declaredUrl}); sync the managed clone, or fix the manifest`
    );
  }
}

export async function assertCommitOnOrigin(repoDir: string, commit: string): Promise<void> {
  const branches = await execa('git', ['branch', '--remotes', '--contains', commit], { ...isolatedGit(), cwd: repoDir, shell: false, reject: false, timeout: 5000 });
  if (branches.exitCode !== 0 || !branches.stdout.split('\n').some((line) => line.trim().startsWith('origin/'))) {
    throw new ValidationError(`Commit ${commit} in ${repoDir} is not on any branch of origin; push it first, since the lock would pin a commit others cannot fetch`);
  }
}
