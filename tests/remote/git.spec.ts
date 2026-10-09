import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cloneRemoteRepo,
  defaultBranch,
  fetchBranch,
  isAncestor,
  listTree,
  readBlob,
  resolveTargetRef
} from '../../src/remote/git.js';
import {
  TEAM_MANIFEST,
  commitTeamFiles,
  createTeamRepo,
  rewriteTeamHistory,
  tagTeamCommit,
  teamHead,
  type TeamRepo
} from '../helpers/team-repo.js';

describe('remote git helpers', () => {
  let root: string;
  let team: TeamRepo;
  let repoDir: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-git-'));
    team = await createTeamRepo(root);
    repoDir = path.join(root, 'home', 'envctl', 'remote', 'repo.git');
    await cloneRemoteRepo(team.url, repoDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('makes a bare clone and fetches the default branch tip', async () => {
    expect(fs.existsSync(path.join(repoDir, 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'envctl'))).toBe(false);
    expect(await defaultBranch(repoDir)).toBe('main');
    expect(await fetchBranch(repoDir, 'main')).toBe(await teamHead(team));
  });

  it('fetches new commits and reports fast-forward ancestry', async () => {
    const first = await fetchBranch(repoDir, 'main');
    const second = await commitTeamFiles(team, { 'envctl/manifest.yaml': `${TEAM_MANIFEST}# v2\n` }, 'second');
    expect(await fetchBranch(repoDir, 'main')).toBe(second);
    expect(await isAncestor(repoDir, first, second)).toBe(true);
    expect(await isAncestor(repoDir, second, first)).toBe(false);
    expect(await isAncestor(repoDir, first, first)).toBe(true);
  });

  it('sees rewritten history as not descending from the old tip', async () => {
    const first = await fetchBranch(repoDir, 'main');
    const rewritten = await rewriteTeamHistory(team, { 'envctl/manifest.yaml': `${TEAM_MANIFEST}# rewritten\n` });
    expect(await fetchBranch(repoDir, 'main')).toBe(rewritten);
    expect(await isAncestor(repoDir, first, rewritten)).toBe(false);
  });

  it('treats an unknown commit as not an ancestor', async () => {
    const first = await fetchBranch(repoDir, 'main');
    expect(await isAncestor(repoDir, 'f'.repeat(40), first)).toBe(false);
  });

  it('lists and reads files as of a commit', async () => {
    const first = await fetchBranch(repoDir, 'main');
    await commitTeamFiles(team, { 'envctl/manifest.yaml': 'changed\n' }, 'second');
    await fetchBranch(repoDir, 'main');
    const entries = await listTree(repoDir, first, 'envctl');
    expect(entries.map((entry) => entry.path)).toEqual([
      'envctl/lock.json',
      'envctl/manifest.yaml',
      'envctl/overlays/team.yaml',
      'envctl/state.json'
    ]);
    expect(entries[1]).toEqual({ mode: '100644', type: 'blob', path: 'envctl/manifest.yaml' });
    expect((await listTree(repoDir, first, '.')).map((entry) => entry.path)).toContain('README.md');
    expect((await readBlob(repoDir, first, 'envctl/manifest.yaml')).toString('utf8')).toBe(TEAM_MANIFEST);
  });

  it('resolves full and abbreviated commits and tags', async () => {
    const first = await fetchBranch(repoDir, 'main');
    await tagTeamCommit(team, 'v1', first);
    expect(await resolveTargetRef(repoDir, first)).toBe(first);
    expect(await resolveTargetRef(repoDir, first.slice(0, 12))).toBe(first);
    expect(await resolveTargetRef(repoDir, 'v1')).toBe(first);
    await expect(resolveTargetRef(repoDir, '--upload-pack=x')).rejects.toThrow("Invalid ref: '--upload-pack=x'");
  });

  it('rejects refs git would not accept, with exit code 3', async () => {
    await fetchBranch(repoDir, 'main');
    for (const ref of ['', 'v1:refs/heads/x', 'v*', 'v?', 'v[1]', 'v\\1', 'v^', 'v~1', 'v 1', 'v\t1', 'a..b', 'v\u00011', 'v@{1}', 'v/', 'v.lock']) {
      await expect(resolveTargetRef(repoDir, ref)).rejects.toMatchObject({ exitCode: 3, message: `Invalid ref: '${ref}'` });
    }
  });

  it('reports an unknown tag or commit as a validation error', async () => {
    await fetchBranch(repoDir, 'main');
    for (const ref of ['no-such-tag', 'abcdef1']) {
      await expect(resolveTargetRef(repoDir, ref)).rejects.toMatchObject({
        exitCode: 3,
        message: `Ref '${ref}' was not found: it is neither a commit on the fetched branch nor a tag of the remote`
      });
    }
  });

  it('reports git failures with exit code 1 and the git stderr', async () => {
    const err = await cloneRemoteRepo(`file://${root}/missing.git`, path.join(root, 'other.git')).catch((e: unknown) => e);
    expect(err).toMatchObject({ exitCode: 1 });
    expect((err as Error).message).toMatch(/^git clone failed: \S/);
  });

  it('never runs a transport helper, even when the git config allows one', async () => {
    const marker = path.join(root, 'marker');
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always' });
    try {
      await expect(cloneRemoteRepo(`ext::sh -c touch% ${marker}`, path.join(root, 'ext.git'))).rejects.toThrow(/git clone failed/);
    } finally {
      process.env = saved;
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});
