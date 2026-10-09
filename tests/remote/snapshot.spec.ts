import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cloneRemoteRepo, fetchBranch } from '../../src/remote/git.js';
import { loadLock } from '../../src/manifest/files.js';
import { lockEntryDigest } from '../../src/remote/lock-entries.js';
import { compareRemoteKeys, sha256Hex } from '../../src/remote/schema.js';
import { MAX_REMOTE_FILES, MAX_REMOTE_FILE_BYTES, MAX_REMOTE_TOTAL_BYTES, loadRemoteSnapshot } from '../../src/remote/snapshot.js';
import { TEAM_LOCK, TEAM_MANIFEST, TEAM_OVERLAY, commitTeamFiles, createTeamRepo } from '../helpers/team-repo.js';

describe('loadRemoteSnapshot', () => {
  let root: string;
  let repoDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-snapshot-'));
    repoDir = path.join(root, 'repo.git');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function snapshotOf(files: Record<string, string>, remotePath = 'envctl') {
    const team = await createTeamRepo(root, files);
    await cloneRemoteRepo(team.url, repoDir);
    return loadRemoteSnapshot(repoDir, await fetchBranch(repoDir, 'main'), remotePath);
  }

  it('adopts only the manifest, the lock and top-level overlays', async () => {
    const snapshot = await snapshotOf({
      'envctl/manifest.yaml': TEAM_MANIFEST,
      'envctl/lock.json': TEAM_LOCK,
      'envctl/overlays/team.yaml': TEAM_OVERLAY,
      'envctl/overlays/nested/deep.yaml': TEAM_OVERLAY,
      'envctl/overlays/notes.txt': 'notes\n',
      'envctl/state.json': '{}\n',
      'envctl/overlay-selection.json': '{}\n',
      'envctl/dshenv.lock': '{}\n',
      'envctl/backups/x/manifest.yaml': 'old\n',
      'envctl/sources/web/p/package.json': '{}\n',
      'manifest.yaml': 'outside the path\n'
    });
    expect(Object.keys(snapshot.files).sort(compareRemoteKeys)).toEqual(['manifest.yaml', 'overlays/team.yaml']);
    expect(snapshot.digests).toEqual({
      'manifest.yaml': sha256Hex(TEAM_MANIFEST),
      'overlays/team.yaml': sha256Hex(TEAM_OVERLAY)
    });
    expect(snapshot.files['manifest.yaml'].toString('utf8')).toBe(TEAM_MANIFEST);
    expect(snapshot.manifest.profiles.web.plugins.shared.package).toBe('shared-plugin');
    expect(snapshot.lock).toEqual(loadLock(TEAM_LOCK));
    expect(snapshot.lockEntries).toEqual({ web: { shared: lockEntryDigest(loadLock(TEAM_LOCK).profiles.web.plugins.shared) } });
  });

  it('reads the repository root with path "."', async () => {
    const snapshot = await snapshotOf(
      { 'manifest.yaml': TEAM_MANIFEST, 'overlays/team.yaml': TEAM_OVERLAY, 'envctl/manifest.yaml': 'ignored\n' },
      '.'
    );
    expect(Object.keys(snapshot.files).sort(compareRemoteKeys)).toEqual(['manifest.yaml', 'overlays/team.yaml']);
    expect(snapshot.lock).toBeNull();
    expect(snapshot.lockEntries).toEqual({});
  });

  it('refuses a commit without a manifest', async () => {
    await expect(snapshotOf({ 'envctl/lock.json': TEAM_LOCK })).rejects.toThrow(/has no envctl\/manifest\.yaml/);
  });

  it.each([
    ['manifest', { 'envctl/manifest.yaml': 'apiVersion: nope\n' }, /Remote file envctl\/manifest\.yaml: Invalid manifest schema/],
    ['lock', { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/lock.json': '{' }, /Remote file envctl\/lock\.json: Invalid JSON in lock file/],
    [
      'overlay schema',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/overlays/bad.yaml': 'apiVersion: dshenv-overlay/v1\nunknown: 1\n' },
      /Remote file envctl\/overlays\/bad\.yaml: Invalid overlay schema/
    ],
    [
      'unmergeable overlay',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/bad.yaml': 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      ghost:\n        package: ghost-plugin\n'
      },
      /Remote file envctl\/overlays\/bad\.yaml: .*must declare package and source/
    ],
    [
      'overlay name',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/overlays/bad name.yaml': 'apiVersion: dshenv-overlay/v1\n' },
      /Remote overlay envctl\/overlays\/bad name\.yaml has an invalid name/
    ],
    [
      'lock with a local-link entry',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: { web: { plugins: { mine: { package: 'mine', source: { type: 'local-link', path: '/home/someone/mine' } } } } }
        })
      },
      /Remote file envctl\/lock\.json: Lock entry 'web\/mine' has a local-link source; a team lock cannot pin machine-local paths/
    ],
    [
      'lock with a local-file entry',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: { cli: { plugins: { pkg: { package: 'pkg', source: { type: 'local-file', path: '/tmp/pkg', digest: 'abc' } } } } }
        })
      },
      /Lock entry 'cli\/pkg' has a local-file source/
    ],
    [
      'manifest with a local-file plugin',
      {
        'envctl/manifest.yaml': `${TEAM_MANIFEST}      mine:\n        package: mine\n        source: { type: local-file, path: /home/someone/mine }\n`
      },
      /^Remote file envctl\/manifest\.yaml: Plugin 'web\/mine' has a local-file source; a team configuration cannot reference machine-local paths$/
    ],
    [
      'overlay with a local-link plugin',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/dev.yaml':
          'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      shared:\n        source: { type: local-link, path: /etc }\n'
      },
      /^Remote file envctl\/overlays\/dev\.yaml: Plugin 'web\/shared' has a local-link source; a team configuration cannot reference machine-local paths$/
    ],
    [
      'manifest naming a DSH checkout',
      { 'envctl/manifest.yaml': `apiVersion: dshenv/v1\nenvironment:\n  harness:\n    sourceDir: /home/someone/.dsh/envctl/skills/x\n${TEAM_MANIFEST.split('\n').slice(1).join('\n')}` },
      /^Remote file envctl\/manifest\.yaml: environment\.harness\.sourceDir names a machine-local DSH checkout that dshenv runs; set it in a local overlay, not in a team configuration$/
    ],
    [
      'manifest naming a source root',
      { 'envctl/manifest.yaml': `apiVersion: dshenv/v1\nenvironment:\n  sourceRoot: /home/someone/src\n${TEAM_MANIFEST.split('\n').slice(1).join('\n')}` },
      /environment\.sourceRoot names a machine-local path/
    ],
    [
      'overlay naming a DSH checkout',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/dev.yaml': 'apiVersion: dshenv-overlay/v1\nenvironment:\n  harness:\n    sourceDir: /tmp/evil\n'
      },
      /^Remote file envctl\/overlays\/dev\.yaml: environment\.harness\.sourceDir names a machine-local DSH checkout/
    ],
    [
      'manifest with a git plugin at a local path',
      { 'envctl/manifest.yaml': `${TEAM_MANIFEST}      mine:\n        package: mine\n        source: { type: git, url: /home/someone/mine.git }\n` },
      /^Remote file envctl\/manifest\.yaml: Plugin 'web\/mine' has a Git URL on this machine; a team configuration cannot reference machine-local paths$/
    ],
    [
      'overlay with a git plugin at a file URL',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/dev.yaml':
          'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      shared:\n        source: { type: git, url: "file:///etc/x.git" }\n'
      },
      /Plugin 'web\/shared' has a Git URL on this machine/
    ],
    [
      'manifest with a git plugin at a pnpm link: path',
      { 'envctl/manifest.yaml': `${TEAM_MANIFEST}      evil:\n        package: evil\n        source: { type: git, url: "link:../../envctl/skills/evil/pkg", commit: abc1234 }\n` },
      /^Remote file envctl\/manifest\.yaml: Plugin 'web\/evil' has a Git URL on this machine/
    ],
    [
      'lock with a git entry at a single-slash file: path',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: { web: { plugins: { mine: { package: 'mine', source: { type: 'git', url: 'file:/etc/x', commit: 'a'.repeat(40) } } } } }
        })
      },
      /Lock entry 'web\/mine' has a Git URL on this machine/
    ],
    [
      'lock with a git entry at a relative path',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: { web: { plugins: { mine: { package: 'mine', source: { type: 'git', url: '../mine', commit: 'a'.repeat(40) } } } } }
        })
      },
      /^Remote file envctl\/lock\.json: Lock entry 'web\/mine' has a Git URL on this machine; a team lock cannot pin machine-local paths$/
    ],
    [
      'manifest with a JavaScript expression in a profile patch',
      {
        'envctl/manifest.yaml': `${TEAM_MANIFEST}    patches:\n      - id: persona\n        disabled: { __jsExpr: "process.exit()" }\n`
      },
      /^Remote file envctl\/manifest\.yaml: Profile 'web' patch has a JavaScript expression \(__jsExpr\) that DSH would run; set it in a local overlay, not in a team configuration$/
    ],
    [
      'manifest with a JavaScript expression in a plugin patch',
      {
        'envctl/manifest.yaml': `${TEAM_MANIFEST}        patches:\n          - id: shared\n            config: { nested: [{ when: { __jsExpr: "1" } }] }\n`
      },
      /^Remote file envctl\/manifest\.yaml: Plugin 'web\/shared' patch has a JavaScript expression \(__jsExpr\)/
    ],
    [
      'manifest with a JavaScript expression in a global patch',
      {
        'envctl/manifest.yaml': `${TEAM_MANIFEST}patches:\n  - id: persona\n    disabled: { __jsExpr: "process.exit()" }\n`
      },
      /^Remote file envctl\/manifest\.yaml: Global patch has a JavaScript expression \(__jsExpr\)/
    ],
    [
      'overlay with a JavaScript expression in a global patch',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/dev.yaml': 'apiVersion: dshenv-overlay/v1\npatches:\n  - id: persona\n    disabled: { __jsExpr: "1" }\n'
      },
      /^Remote file envctl\/overlays\/dev\.yaml: Global patch has a JavaScript expression \(__jsExpr\)/
    ],
    [
      'overlay with a JavaScript expression in a profile patch',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/dev.yaml': 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    patches:\n      - id: persona\n        disabled: { __jsExpr: "1" }\n'
      },
      /^Remote file envctl\/overlays\/dev\.yaml: Profile 'web' patch has a JavaScript expression \(__jsExpr\)/
    ],
    [
      'manifest with a plaintext credential in a plugin patch',
      {
        'envctl/manifest.yaml': `${TEAM_MANIFEST}        patches:\n          - id: shared\n            config: { apiKey: sk-team-123 }\n`
      },
      /^Remote file envctl\/manifest\.yaml: Holds plaintext credentials \(profile 'web' \/ plugin shared \/ config\.apiKey\), which a team configuration must not carry; use an \*Env key/
    ],
    [
      'overlay with a plaintext credential in a global patch',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/dev.yaml': 'apiVersion: dshenv-overlay/v1\npatches:\n  - id: llm\n    config: { clientSecret: s }\n'
      },
      /^Remote file envctl\/overlays\/dev\.yaml: Holds plaintext credentials \(the global patches \/ llm \/ config\.clientSecret\)/
    ],
    [
      'pair of overlays differing only by case',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/overlays/Team.yaml': TEAM_OVERLAY, 'envctl/overlays/team.yaml': TEAM_OVERLAY },
      /^Remote overlays envctl\/overlays\/Team\.yaml and envctl\/overlays\/team\.yaml differ only by case$/
    ],
    [
      'pair of skills differing only by case',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/skills/Review/SKILL.md': '# a\n', 'envctl/skills/review/SKILL.md': '# b\n' },
      /^Remote skill paths envctl\/skills\/Review and envctl\/skills\/review differ only by case$/
    ],
    [
      'pair of skill files differing only by case',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/skills/review/README.md': '# a\n', 'envctl/skills/review/readme.md': '# b\n' },
      /^Remote skill paths envctl\/skills\/review\/README\.md and envctl\/skills\/review\/readme\.md differ only by case$/
    ],
    [
      'skill file under node_modules',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/skills/review/SKILL.md': '# a\n', 'envctl/skills/review/lib/node_modules/dep/index.js': '1\n' },
      /^Remote skill file envctl\/skills\/review\/lib\/node_modules\/dep\/index\.js is never copied into DSH/
    ],
    [
      'lock with an entry the team does not declare',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: {
            web: {
              plugins: {
                shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } },
                mine: { package: 'mine', source: { type: 'npm', resolvedVersion: '1.0.0' } }
              }
            }
          }
        })
      },
      /^Remote file envctl\/lock\.json: lock entry 'web\/mine' is declared by neither the team manifest nor a team overlay; remove it from the team lock$/
    ],
    [
      'lock with an entry for a profile the team does not declare',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/team.yaml': TEAM_OVERLAY,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: { cli: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
        })
      },
      /lock entry 'cli\/shared' is declared by neither the team manifest nor a team overlay/
    ],
    [
      'skill file named .tmp-*',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/skills/review/SKILL.md': '# a\n', 'envctl/skills/review/.tmp-data': '1\n' },
      /^Remote skill file envctl\/skills\/review\/\.tmp-data is never copied into DSH/
    ]
  ])('refuses an invalid %s', async (_label, files, message) => {
    await expect(snapshotOf(files)).rejects.toThrow(message);
  });

  it.each(['https://example.com/team/demo.git', 'git+ssh://git@example.com/demo.git', 'git@github.com:acme/demo.git', 'github:acme/demo'])(
    'accepts a git plugin at %j',
    async (url) => {
      const snapshot = await snapshotOf({
        'envctl/manifest.yaml': `${TEAM_MANIFEST}      demo:\n        package: demo\n        source: { type: git, url: "${url}" }\n`
      });
      expect(snapshot.manifest.profiles.web.plugins.demo.source).toMatchObject({ url });
    }
  );

  it('accepts a lock entry only a team overlay declares', async () => {
    const snapshot = await snapshotOf({
      'envctl/manifest.yaml': TEAM_MANIFEST,
      'envctl/overlays/dev.yaml':
        'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      extra:\n        package: extra-plugin\n        source: { type: npm, version: "2.0.0" }\n',
      'envctl/lock.json': JSON.stringify({
        apiVersion: 'dshenv-lock/v1',
        profiles: { web: { plugins: { extra: { package: 'extra-plugin', source: { type: 'npm', resolvedVersion: '2.0.0' } } } } }
      })
    });
    expect(Object.keys(snapshot.lockEntries.web)).toEqual(['extra']);
  });

  it('refuses a team file larger than the limit before reading it', async () => {
    await expect(snapshotOf({ 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/skills/big/SKILL.md': 'x'.repeat(MAX_REMOTE_FILE_BYTES + 1) })).rejects.toThrow(
      `Remote file envctl/skills/big/SKILL.md is ${MAX_REMOTE_FILE_BYTES + 1} bytes, more than the ${MAX_REMOTE_FILE_BYTES} dshenv reads from a team repository`
    );
  });

  it('refuses team files larger than the limit together', async () => {
    const files: Record<string, string> = { 'envctl/manifest.yaml': TEAM_MANIFEST };
    const size = MAX_REMOTE_FILE_BYTES - 1;
    for (let index = 0; index * size <= MAX_REMOTE_TOTAL_BYTES; index++) {
      files[`envctl/skills/big/part-${index}.md`] = String(index).repeat(size / String(index).length | 0);
    }
    await expect(snapshotOf(files)).rejects.toThrow(/^Remote path envctl holds \d+ bytes, more than the 104857600 dshenv reads from a team repository$/);
  }, 60_000);

  it('refuses more team files than the limit', async () => {
    const files: Record<string, string> = { 'envctl/manifest.yaml': TEAM_MANIFEST };
    for (let index = 0; index < MAX_REMOTE_FILES; index++) {
      files[`envctl/skills/many/f${index}.md`] = '';
    }
    await expect(snapshotOf(files)).rejects.toThrow(
      `Remote path envctl holds ${MAX_REMOTE_FILES + 1} files, more than the ${MAX_REMOTE_FILES} dshenv reads from a team repository`
    );
  }, 60_000);

  it('refuses a symlink in place of an adopted file', async () => {
    const team = await createTeamRepo(root, { 'envctl/real.yaml': TEAM_MANIFEST });
    fs.symlinkSync('real.yaml', path.join(team.work, 'envctl', 'manifest.yaml'));
    const commit = await commitTeamFiles(team, {}, 'symlink');
    await cloneRemoteRepo(team.url, repoDir);
    await fetchBranch(repoDir, 'main');
    await expect(loadRemoteSnapshot(repoDir, commit, 'envctl')).rejects.toThrow('Remote file envctl/manifest.yaml must be a regular file');
  });

  it('refuses a symlink in place of the team lock', async () => {
    const team = await createTeamRepo(root, { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/real.json': TEAM_LOCK });
    fs.symlinkSync('real.json', path.join(team.work, 'envctl', 'lock.json'));
    const commit = await commitTeamFiles(team, {}, 'symlink');
    await cloneRemoteRepo(team.url, repoDir);
    await fetchBranch(repoDir, 'main');
    await expect(loadRemoteSnapshot(repoDir, commit, 'envctl')).rejects.toThrow('Remote file envctl/lock.json must be a regular file');
  });
});
