import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { applyEnvironment } from '../../src/apply/apply.js';
import { runCli } from '../../src/cli.js';
import { createEnvironmentSnapshot } from '../../src/io/backup.js';
import { appendJournalEntry } from '../../src/io/journal.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { loadLock } from '../../src/manifest/files.js';
import { readRemoteConfig, sha256Hex } from '../../src/remote/schema.js';
import {
  TEAM_MANIFEST,
  TEAM_OVERLAY,
  commitTeamFiles,
  commitTeamSideBranch,
  createTeamRepo,
  rewriteTeamHistory,
  tagTeamCommit,
  teamHead,
  type TeamRepo
} from '../helpers/team-repo.js';

const LOCAL_OVERLAY = 'apiVersion: dshenv-overlay/v1\n';
const V2_MANIFEST = `${TEAM_MANIFEST}      extra:
        package: extra-plugin
        source: { type: npm, version: "2.0.0" }
`;
const TEAM_LOCK_V2 = `${JSON.stringify(
  {
    apiVersion: 'dshenv-lock/v1',
    profiles: { web: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.1.0' } } } } }
  },
  null,
  2
)}\n`;
const NO_CHANGES = { added: [], modified: [], removed: [] };

describe('CLI sync', () => {
  let root: string;
  let home: string;
  let paths: EnvironmentPaths;
  let team: TeamRepo;
  let first: string;
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-sync-'));
    home = path.join(root, 'home');
    paths = resolveEnvironmentPaths({ cliDshHome: home });
    team = await createTeamRepo(root);
    expect((await run(['remote', 'add', team.url, '--yes'])).code).toBe(0);
    first = await teamHead(team);
  });

  afterEach(() => {
    // On Windows a git process that just exited can still hold the team clone for a moment.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('reports up to date with exit 0', async () => {
    expect(await run(['sync'])).toMatchObject({ code: 0, stdout: `Already up to date with ${team.url} at ${first}.\n` });
    const json = await run(['sync', '--json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(Object.keys(parsed)).toEqual(['status', 'from', 'to', 'files', 'lockEntries', 'plan']);
    expect(parsed).toMatchObject({ status: 'up-to-date', from: first, to: first, files: NO_CHANGES, lockEntries: NO_CHANGES });
  });

  it('previews an update with exit 2 without writing', async () => {
    const second = await commitTeamFiles(team, { 'envctl/manifest.yaml': V2_MANIFEST, 'envctl/overlays/new.yaml': TEAM_OVERLAY }, 'v2');
    const text = await run(['sync']);
    expect(text.code).toBe(2);
    expect(text.stdout).toContain(`Remote ${team.url} ${first.slice(0, 12)} -> ${second.slice(0, 12)}`);
    expect(text.stdout).toContain('~ manifest.yaml');
    expect(text.stdout).toContain('+ overlays/new.yaml');
    expect(text.stdout).toContain('Lock entries: no changes');
    expect(text.stdout).toContain('+ [web] extra-plugin (extra)');
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(fs.existsSync(overlayFile('new'))).toBe(false);
    expect(readRemoteConfig(paths)?.commit).toBe(first);

    const json = await run(['sync', '--json']);
    expect(json.code).toBe(2);
    const parsed = JSON.parse(json.stdout);
    expect(Object.keys(parsed)).toEqual(['status', 'from', 'to', 'files', 'lockEntries', 'plan']);
    expect(parsed).toMatchObject({
      status: 'pending',
      from: first,
      to: second,
      files: { added: ['overlays/new.yaml'], modified: ['manifest.yaml'], removed: [] },
      lockEntries: NO_CHANGES
    });
  });

  it('previews and accepts team lock entry changes', async () => {
    await commitTeamFiles(team, { 'envctl/lock.json': TEAM_LOCK_V2 }, 'lock v2');
    const text = await run(['sync']);
    expect(text.code).toBe(2);
    expect(text.stdout).toContain('Files: no changes');
    expect(text.stdout).toContain('Lock entries:\n  ~ web/shared\n');
    const lockBefore = read(paths.lockFile);
    const dryRun = await run(['remote', 'sync', '--yes', '--dry-run']);
    expect(dryRun.code).toBe(2);
    expect(dryRun.stdout).toContain('Run it again without --dry-run and with --ref ');
    expect(read(paths.lockFile)).toBe(lockBefore);
    const accepted = await run(['sync', '--yes', '--json']);
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      status: 'accepted',
      operationId: expect.stringMatching(/^sync-/),
      snapshotId: expect.any(String),
      lockEntries: { added: [], modified: ['web/shared'], removed: [] }
    });
    expect(loadLock(read(paths.lockFile)).profiles.web.plugins.shared.source).toEqual({ type: 'npm', resolvedVersion: '1.1.0' });
  });

  it('accepts with --yes: replaces files, deletes dropped overlays, keeps local overlays', async () => {
    fs.writeFileSync(overlayFile('mine'), LOCAL_OVERLAY);
    const second = await commitTeamFiles(
      team,
      { 'envctl/manifest.yaml': V2_MANIFEST, 'envctl/overlays/team.yaml': null, 'envctl/overlays/new.yaml': TEAM_OVERLAY },
      'v2'
    );
    const { code, stdout } = await run(['sync', '--yes', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'accepted',
      from: first,
      to: second,
      files: { added: ['overlays/new.yaml'], modified: ['manifest.yaml'], removed: ['overlays/team.yaml'] }
    });
    expect(read(paths.manifestFile)).toBe(V2_MANIFEST);
    expect(fs.existsSync(overlayFile('team'))).toBe(false);
    expect(read(overlayFile('new'))).toBe(TEAM_OVERLAY);
    expect(read(overlayFile('mine'))).toBe(LOCAL_OVERLAY);
    const config = readRemoteConfig(paths)!;
    expect(config.commit).toBe(second);
    expect(config.files['manifest.yaml']).toBe(sha256Hex(V2_MANIFEST));
    expect(Object.keys(config.files)).toEqual(['manifest.yaml', 'overlays/new.yaml']);
    expect(Object.keys(config.lockEntries.web)).toEqual(['shared']);

    const text = await run(['sync']);
    expect(text.code).toBe(0);
  });

  it('prints the next steps after accepting', async () => {
    await commitTeamFiles(team, { 'envctl/manifest.yaml': V2_MANIFEST }, 'v2');
    const { code, stdout } = await run(['sync', '--yes']);
    expect(code).toBe(0);
    expect(stdout).toContain('Next: dshenv plan, then dshenv apply --yes.');
  });

  it('refuses rewritten history', async () => {
    await rewriteTeamHistory(team, { 'envctl/manifest.yaml': V2_MANIFEST });
    const { code, stderr } = await run(['sync', '--yes']);
    expect(code).toBe(3);
    expect(stderr).toContain(`does not descend from the pinned commit ${first}`);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
  });

  it('moves to a tag with --ref and refuses refs that go backwards or leave the branch', async () => {
    const second = await commitTeamFiles(team, { 'envctl/manifest.yaml': V2_MANIFEST }, 'v2');
    await tagTeamCommit(team, 'v2', second);
    await commitTeamFiles(team, { 'envctl/manifest.yaml': `${V2_MANIFEST}# v3\n` }, 'v3');
    expect((await run(['sync', '--ref', 'v2', '--yes'])).code).toBe(0);
    expect(readRemoteConfig(paths)?.commit).toBe(second);

    const backwards = await run(['sync', '--ref', first]);
    expect(backwards.code).toBe(3);
    expect(backwards.stderr).toContain(`Remote commit ${first} does not descend from the pinned commit ${second}`);

    const side = await commitTeamSideBranch(team, 'side', { 'envctl/manifest.yaml': `${V2_MANIFEST}# side\n` }, 'side');
    await tagTeamCommit(team, 'side-tag', side);
    const offBranch = await run(['sync', '--ref', 'side-tag']);
    expect(offBranch.code).toBe(3);
    expect(offBranch.stderr).toContain(`Ref 'side-tag' (${side}) is not on branch 'main'`);
  });

  it('exits 3 for a --ref that is malformed or does not exist', async () => {
    const unknown = await run(['sync', '--ref', 'no-such-tag']);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain("Ref 'no-such-tag' was not found");
    const malformed = await run(['sync', '--ref', 'v1:refs/heads/x']);
    expect(malformed.code).toBe(3);
    expect(malformed.stderr).toContain("Invalid ref: 'v1:refs/heads/x'");
  });

  it('refuses a local overlay named like a new remote overlay', async () => {
    fs.writeFileSync(overlayFile('new'), LOCAL_OVERLAY);
    await commitTeamFiles(team, { 'envctl/overlays/new.yaml': TEAM_OVERLAY }, 'add new');
    const { code, stderr } = await run(['sync', '--yes']);
    expect(code).toBe(3);
    expect(stderr).toContain('is not owned by the remote, but the remote now provides it');
    expect(read(overlayFile('new'))).toBe(LOCAL_OVERLAY);
  });

  it('refuses local edits to remote files until they are discarded', async () => {
    fs.appendFileSync(paths.manifestFile, '# local edit\n');
    const refused = await run(['sync']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('Remote-owned files and lock entries were changed locally: manifest.yaml (modified)');

    const preview = await run(['sync', '--discard-local-changes']);
    expect(preview.code).toBe(2);
    expect(preview.stdout).toContain('~ manifest.yaml');
    expect(read(paths.manifestFile)).toContain('# local edit');

    expect((await run(['sync', '--discard-local-changes', '--yes'])).code).toBe(0);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect((await run(['sync'])).code).toBe(0);
  });

  it('keeps the lock entry of a git plugin a local overlay clones, across syncs', async () => {
    const upstream = path.join(root, 'upstream', 'local-tool');
    fs.mkdirSync(upstream, { recursive: true });
    for (const args of [
      ['init', '--quiet'],
      ['config', 'user.name', 'Tester'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'commit.gpgsign', 'false']
    ]) {
      await execa('git', args, { cwd: upstream });
    }
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'local-tool', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '--quiet', '-m', 'init'], { cwd: upstream });
    fs.writeFileSync(overlayFile('mine'), LOCAL_OVERLAY);

    const clone = await run(['source', 'clone', upstream, '-p', 'web', '--as', 'tool', '--overlay', 'mine', '--layer', 'overlay']);
    expect(clone.code).toBe(0);
    const toolEntry = loadLock(read(paths.lockFile)).profiles.web.plugins.tool;
    expect(toolEntry.source).toMatchObject({ type: 'git', url: upstream });
    expect(await run(['sync'])).toMatchObject({ code: 0, stdout: `Already up to date with ${team.url} at ${first}.\n` });

    await commitTeamFiles(team, { 'envctl/manifest.yaml': V2_MANIFEST, 'envctl/lock.json': TEAM_LOCK_V2 }, 'v2');
    const accepted = await run(['sync', '--yes', '--json']);
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.stdout).lockEntries).toEqual({ added: [], modified: ['web/shared'], removed: [] });
    const lock = loadLock(read(paths.lockFile));
    expect(lock.profiles.web.plugins.tool).toEqual(toolEntry);
    expect(lock.profiles.web.plugins.shared.source).toEqual({ type: 'npm', resolvedVersion: '1.1.0' });
  });

  it('reports no local change after apply records a local source digest', async () => {
    const sourceDir = path.join(root, 'src', 'demo');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.0', dsh: { bundle: {} } }));
    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'export const v = 1;\n');
    fs.writeFileSync(
      overlayFile('laptop'),
      `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      shared:
        remove: true
      demo:
        package: demo-plugin
        source: { type: local-file, path: ${JSON.stringify(sourceDir)} }
`
    );
    // demo is already installed from its source, so apply only has to record the source digest.
    const profileDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'demo-plugin': `file:${sourceDir}` }, dsh: { profile: { bundles: ['demo-plugin'] } } })
    );
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.0', dsh: { bundle: {} } }));

    const result = await applyEnvironment(paths, { overlay: { name: 'laptop', via: 'flag' }, executor: async () => ({ success: true }) });
    expect(result.applied).toBe(true);
    expect(loadLock(read(paths.lockFile)).profiles.web.plugins.demo.source).toMatchObject({
      type: 'local-file',
      path: sourceDir,
      digest: expect.any(String)
    });

    expect(await run(['sync'])).toMatchObject({ code: 0, stdout: `Already up to date with ${team.url} at ${first}.\n` });
    expect(JSON.parse((await run(['remote', 'show', '--json'])).stdout)).toMatchObject({ drift: [], lockDrift: [] });
  });

  it('refuses to apply an overlay that switches a team-pinned lock entry to a local source', async () => {
    const sourceDir = path.join(root, 'src', 'shared');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'shared-plugin', version: '0.1.0', dsh: { bundle: {} } }));
    fs.writeFileSync(
      overlayFile('laptop'),
      `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      shared:
        source: { type: local-file, path: ${JSON.stringify(sourceDir)} }
`
    );
    const lockBefore = read(paths.lockFile);
    const snapshotsBefore = fs.existsSync(paths.backupsDir) ? fs.readdirSync(paths.backupsDir) : [];

    const dryRun = await run(['apply', '--dry-run', '--overlay', 'laptop']);
    expect(dryRun.code).toBe(3);
    expect(dryRun.stderr).toContain("Lock entry 'web/shared' is pinned by the team lock");

    const { code, stderr } = await run(['apply', '--yes', '--overlay', 'laptop']);
    expect(code).toBe(3);
    expect(stderr).toContain(
      `Lock entry 'web/shared' is pinned by the team lock of remote ${team.url}; a local overlay cannot switch it to a local source. ` +
        'Disable it with remove: true in the overlay and add the local plugin under a new alias'
    );
    expect(read(paths.lockFile)).toBe(lockBefore);
    expect(fs.existsSync(paths.backupsDir) ? fs.readdirSync(paths.backupsDir) : []).toEqual(snapshotsBefore);
    expect(fs.existsSync(path.join(home, 'profiles', 'web'))).toBe(false);
    expect((await run(['sync'])).code).toBe(0);
  });

  it('points at rollback when a previous accept was interrupted', async () => {
    await commitTeamFiles(team, { 'envctl/manifest.yaml': V2_MANIFEST }, 'v2');
    // Simulate a process killed mid-accept: snapshot and sync-started exist, the manifest is written, remote.json is not.
    const operationId = 'sync-0123456789ab';
    await createEnvironmentSnapshot(paths, operationId);
    await appendJournalEntry(paths, { operationId, type: 'sync-started', timestamp: new Date().toISOString() });
    fs.writeFileSync(paths.manifestFile, V2_MANIFEST);

    const { code, stderr } = await run(['sync']);
    expect(code).toBe(3);
    expect(stderr).toContain(
      `The previous sync ${operationId} did not finish; run dshenv rollback ${operationId} --yes to restore the files it started changing, then sync again`
    );

    expect((await run(['rollback', operationId, '--yes'])).code).toBe(0);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect((await run(['sync', '--yes'])).code).toBe(0);
    expect(read(paths.manifestFile)).toBe(V2_MANIFEST);
  });

  it('keeps pointing at rollback after a rollback to a snapshot taken since the interrupted accept', async () => {
    await commitTeamFiles(team, { 'envctl/manifest.yaml': V2_MANIFEST }, 'v2');
    const operationId = 'sync-0123456789ab';
    await createEnvironmentSnapshot(paths, operationId);
    await appendJournalEntry(paths, { operationId, type: 'sync-started', timestamp: new Date().toISOString() });
    fs.writeFileSync(paths.manifestFile, V2_MANIFEST);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createEnvironmentSnapshot(paths, 'apply-later');

    expect((await run(['rollback', 'apply-later', '--yes'])).code).toBe(0);
    const { code, stderr } = await run(['sync']);
    expect(code).toBe(3);
    expect(stderr).toContain(`The previous sync ${operationId} did not finish`);
  });

  it('is undone by rollback, after which sync still fast-forwards', async () => {
    const second = await commitTeamFiles(team, { 'envctl/manifest.yaml': V2_MANIFEST }, 'v2');
    expect((await run(['sync', '--yes'])).code).toBe(0);
    expect((await run(['rollback', '--yes'])).code).toBe(0);
    expect(readRemoteConfig(paths)?.commit).toBe(first);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);

    const again = await run(['sync', '--json']);
    expect(again.code).toBe(2);
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'pending', from: first, to: second });
    expect((await run(['sync', '--yes'])).code).toBe(0);
    expect(readRemoteConfig(paths)?.commit).toBe(second);
  });

  it('clones a missing clone again and explains a missing subscription', async () => {
    fs.rmSync(paths.remoteDir, { recursive: true, force: true });
    const noClone = await run(['sync']);
    expect(noClone.code).toBe(0);
    expect(fs.existsSync(path.join(paths.remoteDir, 'repo.git'))).toBe(true);

    expect((await run(['remote', 'remove', '--yes'])).code).toBe(0);
    const none = await run(['sync']);
    expect(none.code).toBe(3);
    expect(none.stderr).toContain('No remote is configured; run dshenv remote add <url> first');
  });

  it('clones again when the clone follows another URL than remote.json, as after a rollback across remote add', async () => {
    const forkBare = path.join(root, 'fork.git');
    const forkWork = path.join(root, 'fork-work');
    await execa('git', ['clone', '--quiet', '--bare', team.bare, forkBare]);
    await execa('git', ['clone', '--quiet', forkBare, forkWork]);
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: forkWork });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: forkWork });
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: forkWork });
    const fork = { bare: forkBare, work: forkWork, url: `file://${forkBare}` };
    const forkHead = await commitTeamFiles(fork, {}, 'fork only');
    const config = JSON.parse(read(paths.remoteFile));
    fs.writeFileSync(paths.remoteFile, JSON.stringify({ ...config, url: fork.url }));

    const preview = await run(['sync', '--json']);
    expect(JSON.parse(preview.stdout)).toMatchObject({ status: 'pending', from: first, to: forkHead });
  });

  it('ignores files directly under skills/, which belong to no skill', async () => {
    await commitTeamFiles(team, { 'envctl/skills/README.md': '# team skills\n', 'envctl/skills/.DS_Store': 'x' }, 'skills readme');
    expect((await run(['sync', '--yes'])).code).toBe(0);
    expect(fs.existsSync(path.join(paths.skillsDir, 'README.md'))).toBe(false);
  });

  it('exits 1 with the git stderr when the remote is unreachable', async () => {
    fs.renameSync(team.bare, `${team.bare}.moved`);
    const { code, stderr } = await run(['sync']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^git fetch failed: \S/);
  });
});
