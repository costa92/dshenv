import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { DshError, ValidationError } from '../errors.js';
import { ExactVersionRegex } from '../manifest/schema.js';
import { findOnPath } from '../dsh/command.js';

export const PACKAGE_NAME = '@costa92/dshenv';
const LOOKUP_TIMEOUT_MS = 30_000;

export type InstallMethod = 'npm' | 'pnpm';

export interface RunResult {
  exitCode?: number;
  // Why the command could not be started, such as a missing npm.
  spawnError?: string;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  // The package manager's own progress and errors go straight to the user's stderr.
  showOutput?: boolean;
}

export type Runner = (file: string, args: string[], options: RunOptions) => Promise<RunResult>;

export const defaultRunner: Runner = async (file, args, options) => {
  // On Windows a missing command reaches no ENOENT, as it is started through cmd, which only exits 1.
  if (!/[\\/]/.test(file) && findOnPath(file) === null) {
    return { stdout: '', stderr: '', spawnError: `${file} was not found on PATH` };
  }
  const result = await execa(file, args, {
    reject: false,
    shell: false,
    // A project .npmrc in the current directory could point the global install at another registry.
    cwd: os.homedir(),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    // stdout goes to stderr too, so `--json` output on stdout stays parseable.
    ...(options.showOutput ? { stdin: 'inherit' as const, stdout: 2, stderr: 'inherit' as const } : {})
  });
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : ''
  };
};

export interface SelfUpdateOptions {
  currentVersion: string;
  packageRoot: string;
  to?: string;
  check?: boolean;
  run?: Runner;
}

export interface SelfUpdateResult {
  // newer-installed: the installed version is ahead of latest (a prerelease or local build), so nothing is done.
  status: 'up-to-date' | 'newer-installed' | 'available' | 'updated';
  current: string;
  target: string;
  direction?: 'upgrade' | 'downgrade';
  method?: InstallMethod | null;
  command?: string;
}

function parseVersion(version: string): { core: number[]; pre: string[] } {
  const [main, pre] = version.split('+')[0].split(/-(.*)/s);
  return { core: main.split('.').map(Number), pre: pre ? pre.split('.') : [] };
}

// Semver precedence: a release outranks its prereleases; numeric identifiers compare as numbers.
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) - Number(y);
    if (/^\d+$/.test(x)) return -1;
    if (/^\d+$/.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// Only error codes are shown: full npm and pnpm error lines can carry registry URLs and auth tokens.
function describeFailure(result: RunResult, timeoutMs?: number): string {
  if (result.timedOut) {
    return `timed out after ${String((timeoutMs ?? 0) / 1000)} s`;
  }
  if (result.spawnError) {
    return result.spawnError;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  const code = output.match(/\bERR_PNPM_[A-Z0-9_]+/)?.[0] ?? output.match(/^npm (?:error|ERR!) code (\S+)/m)?.[1];
  const hint = code === 'EACCES' || code === 'EPERM' ? '; the global install directory is not writable by this user' : '';
  return code ? `${code}${hint}` : `exit code ${String(result.exitCode)}`;
}

// --prefer-online: a cached packument can lag a fresh release by minutes and report it as missing.
export async function resolveTargetVersion(run: Runner, to?: string): Promise<string> {
  if (to !== undefined && !ExactVersionRegex.test(to)) {
    throw new ValidationError(`--to must be an exact version such as 0.2.0, got '${to}'`);
  }
  const result = await run('npm', ['view', `${PACKAGE_NAME}@${to ?? 'latest'}`, 'version', '--prefer-online'], {
    timeoutMs: LOOKUP_TIMEOUT_MS
  });
  const version = result.stdout.trim().split('\n').at(-1)?.trim().replace(/^'|'$/g, '') ?? '';
  // Only a version the package lacks reads "No match found"; a registry or network failure stays a lookup failure.
  if (to !== undefined && /\b404 No match found for version\b/.test(result.stderr)) {
    throw new ValidationError(`npm has no version ${to} of ${PACKAGE_NAME}`);
  }
  if (result.exitCode !== 0 || !ExactVersionRegex.test(version)) {
    throw new DshError(
      `Could not look up ${PACKAGE_NAME}@${to ?? 'latest'} on the npm registry: ${describeFailure(result, LOOKUP_TIMEOUT_MS)}`
    );
  }
  return version;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpathOrSelf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// pnpm records the global spec in the package.json above its global node_modules.
function pnpmGlobalSpec(globalRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(globalRoot), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    const spec = manifest.dependencies?.[PACKAGE_NAME];
    return typeof spec === 'string' ? spec : undefined;
  } catch {
    return undefined;
  }
}

// Only a global npm or pnpm install from the registry can be replaced in place; a linked checkout
// or a git install must be updated the way it was installed.
export async function detectInstallMethod(run: Runner, packageRoot: string): Promise<InstallMethod | null> {
  const root = realpathOrSelf(packageRoot);
  for (const method of ['npm', 'pnpm'] as const) {
    const result = await run(method, ['root', '-g'], { timeoutMs: LOOKUP_TIMEOUT_MS }).catch(() => null);
    const globalRoot = result?.exitCode === 0 ? result.stdout.trim() : '';
    // pnpm 10 keeps the package files in a .pnpm store beside its global node_modules, not inside it.
    const installDir = method === 'pnpm' ? path.dirname(realpathOrSelf(globalRoot)) : realpathOrSelf(globalRoot);
    if (!globalRoot || !isInside(installDir, root)) {
      continue;
    }
    const spec = method === 'pnpm' ? pnpmGlobalSpec(globalRoot) : undefined;
    if (spec && /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:)/.test(spec)) {
      throw new ValidationError(
        `dshenv was installed with pnpm from ${spec.replace(/\/\/[^/@]*@/, '//')}, not from the npm registry; ` +
          `reinstall from that source, or switch with 'pnpm add -g ${PACKAGE_NAME}'`
      );
    }
    return method;
  }
  return null;
}

export function installArgs(method: InstallMethod, version: string): string[] {
  return method === 'npm'
    ? ['install', '-g', `${PACKAGE_NAME}@${version}`, '--prefer-online']
    : ['add', '-g', `${PACKAGE_NAME}@${version}`];
}

function manualUpdate(packageRoot: string, target: string): string {
  return (
    `dshenv at ${packageRoot} was not installed globally with npm or pnpm, so it cannot replace itself; ` +
    `run 'npm install -g ${PACKAGE_NAME}@${target}', or 'git pull && pnpm build' in a linked checkout`
  );
}

export async function selfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const run = options.run ?? defaultRunner;
  const current = options.currentVersion;
  const target = await resolveTargetVersion(run, options.to);
  const order = compareVersions(target, current);
  if (order === 0) {
    return { status: 'up-to-date', current, target };
  }
  // Without --to only a newer release counts; latest behind a prerelease or local build is no update.
  if (order < 0 && options.to === undefined) {
    return { status: 'newer-installed', current, target };
  }
  const direction = order > 0 ? 'upgrade' : 'downgrade';

  // --check only reports, so an install it cannot replace becomes method null instead of an error.
  const method = await detectInstallMethod(run, options.packageRoot).catch((err: unknown) => {
    if (options.check && err instanceof ValidationError) return null;
    throw err;
  });
  if (options.check) {
    return { status: 'available', current, target, direction, method };
  }
  if (!method) {
    throw new ValidationError(manualUpdate(options.packageRoot, target));
  }
  const args = installArgs(method, target);
  const command = [method, ...args].join(' ');
  // No timeout: killing the package manager mid-install can leave the global package half replaced.
  const result = await run(method, args, { showOutput: true });
  if (result.exitCode !== 0) {
    throw new DshError(`'${command}' failed: ${describeFailure(result)}; its output is above`);
  }
  return { status: 'updated', current, target, direction, method, command };
}
