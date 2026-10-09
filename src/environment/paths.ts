import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ValidationError } from '../errors.js';
import { MOVED_FILE } from './moved.js';

export interface EnvironmentPaths {
  home: string;
  profilesDir: string;
  managerDir: string;
  // How managerDir was chosen, which doctor reports; absent on paths built by hand.
  managerDirSource?: 'flag' | 'env' | 'default';
  manifestFile: string;
  lockFile: string;
  stateFile: string;
  backupsDir: string;
  logsDir: string;
  runDir: string;
  trashDir: string;
  overlaysDir: string;
  overlaySelectionFile: string;
  remoteFile: string;
  remoteDir: string;
  // Skills the manifest declares, and the $DSH_HOME/skills directory DSH loads loose skills from.
  skillsDir: string;
  dshSkillsDir: string;
}

export interface ResolvePathsInput {
  cliDshHome?: string;
  envDshHome?: string;
  // Where envctl lives instead of <home>/envctl; DSH never reads it, so it can sit anywhere.
  cliEnvctlDir?: string;
  envEnvctlDir?: string;
  userHome?: string;
  cwd?: string;
}

// As DSH's own resolveDshHome does, so both name the same directory when a shell did not expand the ~ (.env, Docker ENV).
export function resolveHomePath(value: string, label: string, cwd: string, userHome: string): string {
  if (!value.trim()) {
    throw new ValidationError(`${label} must not be empty`);
  }
  const expanded = value === '~' ? userHome : value.startsWith('~/') || value.startsWith('~\\') ? path.join(userHome, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) return path.resolve(cwd, expanded);
  // No trailing separator, which would make lstat follow a symlinked directory; not resolve, which adds a drive on Windows.
  const normalized = path.normalize(expanded);
  return normalized.length > path.parse(normalized).root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Every environment has one of these; without them the directory is not envctl, and migrate will not delete it.
export const ENVIRONMENT_FILES = ['manifest.yaml', 'lock.json', 'state.json'];
// All dshenv itself keeps in envctl, besides its lock files and MOVED_FILE.
export const ENVCTL_ENTRIES = [
  ...ENVIRONMENT_FILES,
  'backups',
  'logs',
  'run',
  'trash',
  'overlays',
  'overlay-selection.json',
  'remote.json',
  'remote',
  'skills',
  'sources'
];

// The path may not exist yet, so resolve its nearest existing ancestor: on macOS /var is a link to /private/var.
export function realpathOfExisting(target: string): string {
  let dir = target;
  const rest: string[] = [];
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return target;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

// Compared as written and resolved: through a symlinked parent, envctl can land in the DSH home under another name.
function bothSpellings(managerDir: string, home: string): [string, string][] {
  return [
    [managerDir, home],
    [realpathOfExisting(managerDir), realpathOfExisting(home)]
  ];
}

// Only left from before dshenv refused such an envctl; migrate moves dshenv's own entries out of it.
export function envctlHoldsDsh(managerDir: string, home: string): boolean {
  return bothSpellings(managerDir, home).some(([dir, dshHome]) => path.relative(dir, dshHome) !== '' && isSameOrInside(dir, dshHome));
}

// envctl may sit in the DSH home (its default is <home>/envctl), but not on top of what DSH itself reads: its skills would hide DSH's loose skills.
// Nor above it, as envctl's content is taken to be dshenv's: migrate would move the DSH home and all else there with it.
export function assertEnvctlClearOfDsh(managerDir: string, home: string, label: string, allowAbove = false): void {
  for (const [dir, dshHome] of bothSpellings(managerDir, home)) {
    if (path.relative(dshHome, dir) === '') {
      throw new ValidationError(`${label} ${managerDir} is the DSH home; use ${path.join(home, 'envctl')} or a directory outside it`);
    }
    const owned = ['profiles', 'skills'].find((name) => isSameOrInside(path.join(dshHome, name), dir));
    if (owned !== undefined) {
      throw new ValidationError(`${label} ${managerDir} overlaps DSH's ${path.join(home, owned)}; use ${path.join(home, 'envctl')} or a directory outside it`);
    }
    if (!allowAbove && isSameOrInside(dir, dshHome)) {
      throw new ValidationError(`${label} ${managerDir} contains the DSH home ${home}; use ${path.join(home, 'envctl')} or a directory of its own`);
    }
  }
}

// For every command but migrate, which is how such an envctl is left.
export function assertEnvctlNotAboveDsh(paths: EnvironmentPaths): void {
  if (envctlHoldsDsh(paths.managerDir, paths.home)) {
    throw new ValidationError(
      `envctl ${paths.managerDir} contains the DSH home ${paths.home}, which dshenv no longer supports; ` +
        `move dshenv's files out of it with dshenv migrate --to <dir> --yes, then point DSHENV_HOME or --envctl-dir at <dir>`
    );
  }
}

export function resolveEnvironmentPaths(input?: ResolvePathsInput): EnvironmentPaths {
  const userHome = input?.userHome ?? os.homedir();
  const cwd = input?.cwd ?? process.cwd();
  let explicitHome: string | undefined;

  if (input?.cliDshHome !== undefined) {
    explicitHome = resolveHomePath(input.cliDshHome, 'CLI dsh-home', cwd, userHome);
  } else if (input?.envDshHome !== undefined && input.envDshHome.trim() !== '') {
    // DSH treats a blank DSH_HOME as unset.
    explicitHome = resolveHomePath(input.envDshHome, 'DSH_HOME environment variable', cwd, userHome);
  }

  const home = explicitHome ?? path.join(userHome, '.dsh');
  const profilesDir = path.join(home, 'profiles');
  const managerDirSource =
    input?.cliEnvctlDir !== undefined ? 'flag' : input?.envEnvctlDir !== undefined && input.envEnvctlDir.trim() !== '' ? 'env' : 'default';
  const managerDir =
    managerDirSource === 'flag'
      ? resolveHomePath(input!.cliEnvctlDir!, 'CLI envctl-dir', cwd, userHome)
      : managerDirSource === 'env'
        ? resolveHomePath(input!.envEnvctlDir!, 'DSHENV_HOME environment variable', cwd, userHome)
        : path.join(home, 'envctl');
  if (managerDirSource !== 'default') {
    // One that already holds dshenv's files is let through, so migrate can move them out.
    const existing = [...ENVIRONMENT_FILES, MOVED_FILE].some((name) => fs.existsSync(path.join(managerDir, name)));
    assertEnvctlClearOfDsh(managerDir, home, managerDirSource === 'flag' ? 'CLI envctl-dir' : 'DSHENV_HOME environment variable', existing);
  }

  return {
    home,
    profilesDir,
    managerDir,
    managerDirSource,
    manifestFile: path.join(managerDir, 'manifest.yaml'),
    lockFile: path.join(managerDir, 'lock.json'),
    stateFile: path.join(managerDir, 'state.json'),
    backupsDir: path.join(managerDir, 'backups'),
    logsDir: path.join(managerDir, 'logs'),
    runDir: path.join(managerDir, 'run'),
    trashDir: path.join(managerDir, 'trash'),
    overlaysDir: path.join(managerDir, 'overlays'),
    overlaySelectionFile: path.join(managerDir, 'overlay-selection.json'),
    remoteFile: path.join(managerDir, 'remote.json'),
    remoteDir: path.join(managerDir, 'remote'),
    skillsDir: path.join(managerDir, 'skills'),
    dshSkillsDir: path.join(home, 'skills')
  };
}
