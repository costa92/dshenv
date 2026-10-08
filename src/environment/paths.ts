import * as path from 'node:path';
import * as os from 'node:os';
import { ValidationError } from '../errors.js';

export interface EnvironmentPaths {
  home: string;
  profilesDir: string;
  managerDir: string;
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
  const managerDir =
    input?.cliEnvctlDir !== undefined
      ? resolveHomePath(input.cliEnvctlDir, 'CLI envctl-dir', cwd, userHome)
      : input?.envEnvctlDir !== undefined && input.envEnvctlDir.trim() !== ''
        ? resolveHomePath(input.envEnvctlDir, 'DSHENV_HOME environment variable', cwd, userHome)
        : path.join(home, 'envctl');

  return {
    home,
    profilesDir,
    managerDir,
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
