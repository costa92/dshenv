import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import { DshError, ValidationError } from '../errors.js';
import { isolatedGit } from '../source/git.js';

export interface TreeEntry {
  mode: string;
  type: string;
  path: string;
}

const GIT_TIMEOUT_MS = 120_000;
// Never block on an interactive credential prompt; authentication belongs to SSH or a credential helper. GIT_DIR and
// the like, inherited from a hook or CI step, would point git at another repository.
const gitEnv = () => {
  const { env } = isolatedGit();
  return { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, extendEnv: false as const };
};

function stderrText(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string') {
    return stderr.trim();
  }
  if (stderr instanceof Uint8Array) {
    return Buffer.from(stderr).toString('utf8').trim();
  }
  return '';
}

function gitFailure(command: string, err: unknown): DshError {
  const detail = stderrText(err) || (err instanceof Error ? err.message : String(err));
  return new DshError(`git ${command} failed: ${detail}`, 1);
}

function gitArgs(repoDir: string | null, args: string[]): string[] {
  return repoDir ? ['--git-dir', repoDir, ...args] : args;
}

async function git(repoDir: string | null, args: string[]): Promise<string> {
  try {
    const res = await execa('git', gitArgs(repoDir, args), { shell: false, timeout: GIT_TIMEOUT_MS, ...gitEnv() });
    return res.stdout;
  } catch (err) {
    throw gitFailure(args[0], err);
  }
}

async function hasCommit(repoDir: string, rev: string): Promise<boolean> {
  const res = await execa('git', gitArgs(repoDir, ['cat-file', '-e', `${rev}^{commit}`]), {
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    ...gitEnv(),
    reject: false
  });
  return res.exitCode === 0;
}

export async function cloneRemoteRepo(url: string, repoDir: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(repoDir), { recursive: true });
  await git(null, ['clone', '--bare', '--quiet', '--', url, repoDir]);
}

// The URL the clone fetches from, or null when it has none (a broken clone).
export async function cloneOrigin(repoDir: string): Promise<string | null> {
  const res = await execa('git', gitArgs(repoDir, ['remote', 'get-url', 'origin']), { shell: false, timeout: GIT_TIMEOUT_MS, ...gitEnv(), reject: false });
  return res.exitCode === 0 ? String(res.stdout).trim() : null;
}

export async function defaultBranch(repoDir: string): Promise<string> {
  return (await git(repoDir, ['symbolic-ref', '--short', 'HEAD'])).trim();
}

export async function revParseCommit(repoDir: string, rev: string): Promise<string> {
  return (await git(repoDir, ['rev-parse', '--verify', `${rev}^{commit}`])).trim();
}

export async function fetchBranch(repoDir: string, branch: string): Promise<string> {
  const tracking = `refs/remotes/origin/${branch}`;
  // '+' accepts a force-pushed branch, so a rewrite is reported by the ancestry check instead of a fetch error.
  await git(repoDir, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${tracking}`]);
  return revParseCommit(repoDir, tracking);
}

// Characters git forbids in ref names; ':' or '*' would also change the meaning of the fetch refspec.
const InvalidRefRegex = /[\x00-\x20\x7f:*?[\\^~]|\.\./;

export async function resolveTargetRef(repoDir: string, ref: string): Promise<string> {
  if (ref.startsWith('-') || InvalidRefRegex.test(ref)) {
    throw new ValidationError(`Invalid ref: '${ref}'`);
  }
  if (/^[0-9a-f]{7,40}$/.test(ref) && (await hasCommit(repoDir, ref))) {
    return revParseCommit(repoDir, ref);
  }
  const args = ['fetch', '--quiet', '--no-tags', 'origin', `+refs/tags/${ref}:refs/tags/${ref}`];
  try {
    // A fixed locale keeps the "couldn't find remote ref" message recognisable.
    await execa('git', gitArgs(repoDir, args), { shell: false, timeout: GIT_TIMEOUT_MS, env: { ...gitEnv().env, LC_ALL: 'C' }, extendEnv: false });
  } catch (err) {
    if (stderrText(err).includes("couldn't find remote ref")) {
      throw new ValidationError(`Ref '${ref}' was not found: it is neither a commit on the fetched branch nor a tag of the remote`);
    }
    throw gitFailure(args[0], err);
  }
  return revParseCommit(repoDir, `refs/tags/${ref}`);
}

export async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  // A commit missing after a fetch was dropped by a history rewrite, which is exactly "not an ancestor".
  if (!(await hasCommit(repoDir, ancestor)) || !(await hasCommit(repoDir, descendant))) {
    return false;
  }
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const res = await execa('git', gitArgs(repoDir, args), { shell: false, timeout: GIT_TIMEOUT_MS, ...gitEnv(), reject: false });
  if (res.exitCode === 0) {
    return true;
  }
  if (res.exitCode === 1) {
    return false;
  }
  throw gitFailure(args[0], res);
}

export async function listTree(repoDir: string, commit: string, dir: string): Promise<TreeEntry[]> {
  const out = await git(repoDir, ['ls-tree', '-r', '-z', commit, '--', dir]);
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type] = line.slice(0, tab).split(' ');
      return { mode, type, path: line.slice(tab + 1) };
    });
}

export async function readBlob(repoDir: string, commit: string, file: string): Promise<Buffer> {
  const args = ['cat-file', 'blob', `${commit}:${file}`];
  try {
    const res = await execa('git', gitArgs(repoDir, args), {
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      ...gitEnv(),
      encoding: 'buffer',
      // File contents must stay byte-exact; execa would otherwise drop the final newline.
      stripFinalNewline: false
    });
    return Buffer.from(res.stdout);
  } catch (err) {
    throw gitFailure(args[0], err);
  }
}
