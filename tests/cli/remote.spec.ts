import { readSelectionFile } from '../../src/overlay/selection.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { runCli } from '../../src/cli.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { createEnvironmentSnapshot } from '../../src/io/backup.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import { lockEntryDigest } from '../../src/remote/lock-entries.js';
import { readRemoteConfig, sha256Hex } from '../../src/remote/schema.js';
import {
  TEAM_LOCK,
  TEAM_MANIFEST,
  TEAM_OVERLAY,
  commitTeamFiles,
  commitTeamSideBranch,
  createTeamRepo,
  teamHead,
  type TeamRepo
} from '../helpers/team-repo.js';

const LOCAL_MANIFEST = 'apiVersion: dshenv/v1\nprofiles: {}\n';
const LOCAL_TEAM_OVERLAY = 'apiVersion: dshenv-overlay/v1\n# local team overlay\n';

describe('CLI remote', () => {
  let root: string;
  let home: string;
  let paths: EnvironmentPaths;
  let team: TeamRepo;
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', home], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const overlayFile = (name: string) => path.join(paths.overlaysDir, `${name}.yaml`);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-remote-'));
    home = path.join(root, 'home');
    paths = resolveEnvironmentPaths({ cliDshHome: home });
    team = await createTeamRepo(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('previews a subscription with exit 2 and leaves nothing behind', async () => {
    const { code, stdout } = await run(['remote', 'add', team.url]);
    expect(code).toBe(2);
    expect(stdout).toContain('Files:\n  + manifest.yaml\n  + overlays/team.yaml\n');
    expect(stdout).toContain('Lock entries:\n  + web/shared\n');
    expect(stdout).toContain('+ [web] shared-plugin (shared)');
    expect(stdout).toContain(`Re-run with --ref ${await teamHead(team)} --yes to accept this commit.`);
    expect(fs.existsSync(paths.manifestFile)).toBe(false);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it('ignores a GIT_WORK_TREE inherited from a hook or CI step', async () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: other });
    fs.mkdirSync(path.join(other, 'sub'));
    const previous = process.cwd();
    // As in a git hook: the working directory inside another repository, its work tree exported.
    process.chdir(path.join(other, 'sub'));
    process.env.GIT_WORK_TREE = other;
    try {
      const { code, stdout } = await run(['remote', 'add', team.url]);
      expect(code).toBe(2);
      expect(stdout).toContain('+ manifest.yaml');
    } finally {
      delete process.env.GIT_WORK_TREE;
      process.chdir(previous);
    }
  });

  it('accepts the commit it previewed when the branch has moved on since', async () => {
    const previewed = await teamHead(team);
    await run(['remote', 'add', team.url]);
    await commitTeamFiles(team, { 'envctl/overlays/late.yaml': TEAM_OVERLAY }, 'pushed after the review');
    const { code } = await run(['remote', 'add', team.url, '--ref', previewed, '--yes']);
    expect(code).toBe(0);
    expect(readRemoteConfig(paths)?.commit).toBe(previewed);
    expect(fs.existsSync(overlayFile('late'))).toBe(false);
  });

  it('reports the preview as JSON', async () => {
    const { code, stdout } = await run(['remote', 'add', team.url, '--json']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      status: 'pending',
      url: team.url,
      branch: 'main',
      path: 'envctl',
      from: null,
      to: await teamHead(team),
      files: { added: ['manifest.yaml', 'overlays/team.yaml'], modified: [], removed: [] },
      lockEntries: { added: ['web/shared'], modified: [], removed: [] }
    });
    expect(Object.keys(parsed)).toEqual(['status', 'url', 'branch', 'path', 'from', 'to', 'files', 'lockEntries', 'plan']);
    expect(parsed.plan.operations.some((op: { kind: string; alias: string }) => op.kind === 'install' && op.alias === 'shared')).toBe(true);
  });

  it('accepts with --yes and pins the branch tip', async () => {
    const { code, stdout } = await run(['remote', 'add', team.url, '--yes']);
    expect(code).toBe(0);
    expect(stdout).toContain('Next: dshenv plan, then dshenv apply --yes.');
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(loadLock(read(paths.lockFile))).toEqual(loadLock(TEAM_LOCK));
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(readRemoteConfig(paths)).toMatchObject({
      url: team.url,
      branch: 'main',
      path: 'envctl',
      commit: await teamHead(team),
      files: { 'manifest.yaml': sha256Hex(TEAM_MANIFEST) },
      lockEntries: { web: { shared: lockEntryDigest(loadLock(TEAM_LOCK).profiles.web.plugins.shared) } }
    });
    expect(fs.existsSync(path.join(paths.remoteDir, 'repo.git', 'HEAD'))).toBe(true);
  });

  it('refuses a second subscription', async () => {
    await run(['remote', 'add', team.url, '--yes']);
    const { code, stderr } = await run(['remote', 'add', team.url, '--yes']);
    expect(code).toBe(3);
    expect(stderr).toContain('A remote is already configured');
    expect(fs.existsSync(path.join(paths.remoteDir, 'repo.git', 'HEAD'))).toBe(true);
    expect((await run(['sync'])).code).toBe(0);
  });

  it('replaces a leftover clone when no remote.json exists', async () => {
    fs.mkdirSync(path.join(paths.remoteDir, 'repo.git'), { recursive: true });
    fs.writeFileSync(path.join(paths.remoteDir, 'repo.git', 'stale'), 'left behind');
    expect((await run(['remote', 'add', team.url, '--yes'])).code).toBe(0);
    expect(fs.existsSync(path.join(paths.remoteDir, 'repo.git', 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(paths.remoteDir, 'repo.git', 'HEAD'))).toBe(true);
  });

  it('refuses a local manifest without --replace', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, LOCAL_MANIFEST);
    const { code, stderr } = await run(['remote', 'add', team.url, '--yes']);
    expect(code).toBe(3);
    expect(stderr).toContain('already exists; pass --replace');
    expect(read(paths.manifestFile)).toBe(LOCAL_MANIFEST);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it('keeps --replace in the accept command the preview prints', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, LOCAL_MANIFEST);
    const { code, stdout } = await run(['remote', 'add', team.url, '--replace']);
    expect(code).toBe(2);
    expect(stdout).toContain(`Re-run with --ref ${await teamHead(team)} --replace --yes to accept this commit.`);
  });

  it('asks to add again, not sync, when a local skill takes a team skill name', async () => {
    await commitTeamFiles(team, { 'envctl/skills/wiki/SKILL.md': 'team' }, 'skill');
    fs.mkdirSync(path.join(paths.skillsDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(paths.skillsDir, 'wiki', 'SKILL.md'), 'mine');
    const { code, stderr } = await run(['remote', 'add', team.url]);
    expect(code).toBe(3);
    expect(stderr).toContain('move it aside, then run remote add again');
  });

  it('merges into a local lock and refuses a clashing local entry without --replace', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    const localLock = serializeLock({
      apiVersion: 'dshenv-lock/v1',
      profiles: { web: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '0.9.0' } } } } }
    });
    fs.writeFileSync(paths.lockFile, localLock);
    const refused = await run(['remote', 'add', team.url, '--yes']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("Local lock entry 'web/shared' already exists; pass --replace");
    expect(read(paths.lockFile)).toBe(localLock);

    fs.writeFileSync(
      paths.lockFile,
      serializeLock({
        apiVersion: 'dshenv-lock/v1',
        profiles: { cli: { plugins: { helper: { package: 'helper', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
      })
    );
    expect((await run(['remote', 'add', team.url, '--yes'])).code).toBe(0);
    const lock = loadLock(read(paths.lockFile));
    expect(Object.keys(lock.profiles).sort()).toEqual(['cli', 'web']);
    expect(lock.profiles.web.plugins.shared.source).toEqual({ type: 'npm', resolvedVersion: '1.0.0' });
  });

  it('--replace overwrites local files after a snapshot that rollback restores', async () => {
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, LOCAL_MANIFEST);
    fs.writeFileSync(overlayFile('team'), LOCAL_TEAM_OVERLAY);
    expect((await run(['remote', 'add', team.url, '--replace', '--yes'])).code).toBe(0);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    const [snapshot] = fs.readdirSync(paths.backupsDir);
    expect(read(path.join(paths.backupsDir, snapshot, 'manifest.yaml'))).toBe(LOCAL_MANIFEST);
    expect(read(path.join(paths.backupsDir, snapshot, 'overlays', 'team.yaml'))).toBe(LOCAL_TEAM_OVERLAY);

    expect((await run(['rollback', '--yes'])).code).toBe(0);
    expect(read(paths.manifestFile)).toBe(LOCAL_MANIFEST);
    expect(read(overlayFile('team'))).toBe(LOCAL_TEAM_OVERLAY);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  it.each([
    ['https://user:token@example.com/team.git', [], 'Git URL must not embed credentials'],
    [null, ['--path', '../envctl'], "Invalid --path '../envctl'"],
    [null, ['--branch', 'bad branch'], "Invalid --branch 'bad branch'"],
    [null, ['--branch', 'a..b'], "Invalid --branch 'a..b'"],
    [null, ['--branch', 'main/'], "Invalid --branch 'main/'"],
    [null, ['--branch', 'main.lock'], "Invalid --branch 'main.lock'"],
    [null, ['--ref', ''], "Invalid ref: ''"],
    [null, ['--ref', 'a..b'], "Invalid ref: 'a..b'"],
    ['ext::sh -c touch% x', [], 'transport'],
    ['alice:token@example.com:team.git', [], 'Git URL must not embed credentials']
  ])('rejects bad input %s %j', async (url, extra, message) => {
    const { code, stderr } = await run(['remote', 'add', url ?? team.url, ...extra]);
    expect(code).toBe(3);
    expect(stderr).toContain(message);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it.each([[''], ['a..b']])('remote sync rejects --ref %j with exit 3', async (ref) => {
    expect((await run(['remote', 'add', team.url, '--yes'])).code).toBe(0);
    const { code, stderr } = await run(['remote', 'sync', '--ref', ref]);
    expect(code).toBe(3);
    expect(stderr).toContain(`Invalid ref: '${ref}'`);
  });

  it('follows --branch and --path', async () => {
    await commitTeamSideBranch(team, 'release', { 'config/manifest.yaml': TEAM_MANIFEST }, 'release layout');
    expect((await run(['remote', 'add', team.url, '--branch', 'release', '--path', 'config', '--yes'])).code).toBe(0);
    const config = readRemoteConfig(paths)!;
    expect(config).toMatchObject({ branch: 'release', path: 'config' });
    expect(config.files).toEqual({ 'manifest.yaml': sha256Hex(TEAM_MANIFEST) });
    expect(config.lockEntries).toEqual({});
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  it('refuses invalid remote content and reports git failures with exit 1', async () => {
    await commitTeamFiles(team, { 'envctl/manifest.yaml': 'apiVersion: nope\n' }, 'broken');
    const invalid = await run(['remote', 'add', team.url, '--yes']);
    expect(invalid.code).toBe(3);
    expect(invalid.stderr).toContain('Remote file envctl/manifest.yaml: Invalid manifest schema');
    expect(fs.existsSync(paths.remoteDir)).toBe(false);

    const missing = await run(['remote', 'add', `file://${root}/missing.git`]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^git clone failed: \S/);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it('refuses a remote default branch it cannot follow, without leaving a clone', async () => {
    await commitTeamFiles(team, {}, 'plus branch', 'team+x');
    await execa('git', ['--git-dir', team.bare, 'symbolic-ref', 'HEAD', 'refs/heads/team+x']);
    const { code, stderr } = await run(['remote', 'add', team.url]);
    expect(code).toBe(3);
    expect(stderr).toContain("Remote default branch 'team+x' is not a supported branch name; pass --branch");
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
    expect((await run(['remote', 'add', team.url, '--branch', 'main'])).code).toBe(2);
  });

  it('rejects a URL starting with - with exit 3', async () => {
    // Only after '--' does commander pass a dash-prefixed value through; the run helper appends options, so call runCli directly.
    let stderr = '';
    const code = await runCli(['--dsh-home', home, 'remote', 'add', '--', '-uhttps://example.com/x.git'], {
      stdout: () => {},
      stderr: (chunk) => { stderr += chunk; }
    });
    expect(code).toBe(3);
    expect(stderr).toContain('Invalid Git URL: -uhttps://example.com/x.git');
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it('shows the subscription and the remote files and lock entries changed locally', async () => {
    await run(['remote', 'add', team.url, '--yes']);
    fs.appendFileSync(overlayFile('team'), '# local edit\n');
    fs.writeFileSync(paths.lockFile, serializeLock({ apiVersion: 'dshenv-lock/v1', profiles: {} }));
    const text = await run(['remote', 'show']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`Remote: ${team.url}`);
    expect(text.stdout).toContain('Files:\n  manifest.yaml\n  overlays/team.yaml (modified)\n');
    expect(text.stdout).toContain('Lock entries:\n  web/shared (missing)\n');
    expect(JSON.parse((await run(['remote', 'show', '--json'])).stdout)).toEqual({
      subscribed: true,
      url: team.url,
      branch: 'main',
      path: 'envctl',
      commit: await teamHead(team),
      files: ['manifest.yaml', 'overlays/team.yaml'],
      lockEntries: ['web/shared'],
      drift: [{ file: 'overlays/team.yaml', status: 'modified' }],
      lockDrift: [{ entry: 'web/shared', status: 'missing' }]
    });

    fs.writeFileSync(paths.lockFile, '{');
    const broken = await run(['remote', 'show']);
    expect(broken.code).toBe(3);
    expect(broken.stderr).toContain(`Cannot parse local lock file ${paths.lockFile}`);
  });

  it('shows that nothing is subscribed', async () => {
    expect(await run(['remote', 'show'])).toMatchObject({ code: 0, stdout: 'No remote configured.\n' });
    expect(JSON.parse((await run(['remote', 'show', '--json'])).stdout)).toEqual({ subscribed: false });
  });

  it('records a relative repository path as a file:// URL, so a sync from another directory still finds it', async () => {
    const previous = process.cwd();
    process.chdir(path.dirname(team.bare));
    try {
      expect((await run(['remote', 'add', path.basename(team.bare), '--yes'])).code).toBe(0);
    } finally {
      process.chdir(previous);
    }
    expect(readRemoteConfig(paths)?.url).toBe(pathToFileURL(fs.realpathSync(team.bare)).href);
    fs.rmSync(paths.remoteDir, { recursive: true, force: true });
    const sync = await run(['remote', 'sync']);
    expect(sync.stderr).toBe('');
    expect(sync.code).toBe(0);
  });

  it('clears the selection of a team overlay that a rollback to before the subscription removes', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, LOCAL_MANIFEST);
    // As an apply before the subscription saves it: the team overlay did not exist, so the snapshot does not name it.
    const earlier = await createEnvironmentSnapshot(paths, 'apply-0123456789ab');
    expect((await run(['remote', 'add', team.url, '--replace', '--yes'])).code).toBe(0);
    expect((await run(['overlay', 'use', 'team'])).code).toBe(0);

    const out = await run(['rollback', 'apply-0123456789ab', '--yes']);
    expect(out.code).toBe(0);
    expect(earlier.snapshotId).toContain('apply-0123456789ab');
    expect(fs.existsSync(overlayFile('team'))).toBe(false);
    expect(out.stdout).toContain("overlay 'team' it removed was selected; no overlay is selected now");
    const status = await run(['status']);
    expect(status.stderr).not.toContain("Overlay 'team' not found");
  });

  it('selects the team overlay again when the rollback that deselected it is undone', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, LOCAL_MANIFEST);
    await createEnvironmentSnapshot(paths, 'apply-0123456789ab');
    expect((await run(['remote', 'add', team.url, '--replace', '--yes'])).code).toBe(0);
    expect((await run(['overlay', 'use', 'team'])).code).toBe(0);
    expect((await run(['rollback', 'apply-0123456789ab', '--yes'])).code).toBe(0);

    const undo = await run(['rollback', '--yes']);
    expect(undo.code).toBe(0);
    expect(fs.existsSync(overlayFile('team'))).toBe(true);
    expect(undo.stdout).toContain("overlay 'team', which the rolled-back rollback deselected, is selected again");
    expect(readSelectionFile(paths)).toBe('team');
  });

  it('clones the remote again when a rollback brought back the subscription that remote remove dropped', async () => {
    expect((await run(['remote', 'add', team.url, '--yes'])).code).toBe(0);
    await commitTeamFiles(team, { 'envctl/overlays/new.yaml': 'apiVersion: dshenv-overlay/v1\n' }, 'new overlay');
    // The sync snapshot holds remote.json as it was before this sync.
    expect((await run(['remote', 'sync', '--yes'])).code).toBe(0);
    expect((await run(['remote', 'remove', '--yes'])).code).toBe(0);
    expect((await run(['rollback', '--yes'])).code).toBe(0);
    expect(fs.existsSync(paths.remoteFile)).toBe(true);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);

    const sync = await run(['remote', 'sync']);
    expect(sync.stderr).toBe('');
    expect(sync.code).toBe(2);
    expect(sync.stdout).toContain('+ overlays/new.yaml');
  });

  it('removes the subscription only with --yes and leaves the files writable', async () => {
    const addDryRun = await run(['remote', 'add', team.url, '--yes', '--dry-run']);
    expect(addDryRun.code).toBe(2);
    expect(addDryRun.stdout).toContain('Run it again without --dry-run and with --ref ');
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    await run(['remote', 'add', team.url, '--yes']);
    const removeDryRun = await run(['remote', 'remove', '--yes', '--dry-run']);
    expect(removeDryRun.code).toBe(2);
    expect(removeDryRun.stderr).toContain('without --dry-run and with --yes to remove the remote');
    expect(fs.existsSync(paths.remoteFile)).toBe(true);
    const preview = await run(['remote', 'remove']);
    expect(preview.code).toBe(2);
    expect(preview.stdout).toContain(`Would stop following ${team.url}`);
    expect(preview.stderr).toContain('Re-run with --yes to remove the remote');
    expect(fs.existsSync(paths.remoteFile)).toBe(true);
    expect((await run(['install', 'extra-plugin@1.0.0', '-p', 'web'])).code).toBe(3);

    expect((await run(['remote', 'remove', '--yes'])).code).toBe(0);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect((await run(['install', 'extra-plugin@1.0.0', '-p', 'web'])).code).toBe(0);

    const again = await run(['remote', 'remove', '--yes']);
    expect(again.code).toBe(3);
    expect(again.stderr).toContain('No remote is configured');
  });
});
