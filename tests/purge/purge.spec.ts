import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readJournalEntries } from '../../src/io/journal.js';
import { purgePlugin } from '../../src/purge/purge.js';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { execa } from 'execa';

describe('purgePlugin', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-purge-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(
      path.join(managerDir, 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
        patches:
          - id: agent-teams
            config:
              taskPlanning: captain
`
    );
    fs.writeFileSync(
      path.join(managerDir, 'lock.json'),
      `{"apiVersion":"dshenv-lock/v1","profiles":{"web":{"plugins":{}}}}`
    );
    fs.writeFileSync(
      path.join(managerDir, 'state.json'),
      `{
  "apiVersion": "dshenv-state/v1",
  "lastApplied": "2026-01-01T00:00:00.000Z",
  "appliedLockHash": "",
  "profiles": {},
  "resources": {
    "plugin": {
      "web": {
        "@nanmicoder/dsh-agent-teams": {
          "package": "@nanmicoder/dsh-agent-teams",
          "alias": "agent-teams",
          "sourceType": "npm",
          "lockedVersion": "0.1.21",
          "adoptedAt": "2026-01-01T00:00:00.000Z",
          "adoptedBy": "test"
        }
      }
    }
  }
}`
    );
    const profileDir = path.join(tempHome, 'profiles', 'web');
    const packageDir = path.join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.21' },
        dsh: { profile: { bundles: ['@nanmicoder/dsh-agent-teams'] } }
      })
    );
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21', dsh: { bundle: {} } })
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('should refuse unmanaged plugins', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await expect(purgePlugin(paths, 'web', 'stray-pkg')).rejects.toThrow(/no ownership/);
  });

  describe('with the managed clone of a plugin apply already removed', () => {
    let cloneDir: string;
    beforeEach(async () => {
      cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
      fs.mkdirSync(cloneDir, { recursive: true });
      await execa('git', ['init', '-q'], { cwd: cloneDir });
      fs.writeFileSync(path.join(cloneDir, 'package.json'), '{"name":"demo-plugin"}');
      await execa('git', ['add', '.'], { cwd: cloneDir });
      await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], { cwd: cloneDir });
    });

    it('moves the clone to trash although apply dropped the ownership record', async () => {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      const preview = await purgePlugin(paths, 'web', 'demo-plugin', { dryRun: true });
      expect(preview.moved).toEqual([cloneDir]);
      const result = await purgePlugin(paths, 'web', 'demo-plugin');
      expect(fs.existsSync(cloneDir)).toBe(false);
      expect(result.moved).toHaveLength(1);
      expect(fs.existsSync(path.join(result.moved[0], 'package.json'))).toBe(true);
    });

    it('still refuses while the manifest declares the package', async () => {
      const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
      fs.appendFileSync(manifestFile, '      demo:\n        package: demo-plugin\n        source: { type: git, url: "https://example.invalid/demo.git" }\n');
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      await expect(purgePlugin(paths, 'web', 'demo-plugin')).rejects.toThrow(/no ownership/);
      await expect(purgePlugin(paths, 'web', 'demo')).rejects.toThrow(/no ownership/);
      expect(fs.existsSync(cloneDir)).toBe(true);
    });
  });

  it('purges the config blocks a renamed alias writes, though the ownership record keeps the old alias', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace('      agent-teams:\n', '      teams:\n').replace('id: agent-teams', 'id: teams'));
    await applyEnvironment(paths);
    const patchFile = path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
    expect(fs.readFileSync(patchFile, 'utf8')).toContain('plugin=teams');

    const result = await purgePlugin(paths, 'web', '@nanmicoder/dsh-agent-teams');
    expect(result.plugin).toBe('teams');
    expect(fs.readFileSync(patchFile, 'utf8')).not.toContain('plugin=teams');
  });

  it('refuses to purge a managed clone with untracked work and no commit yet', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', '@nanmicoder_dsh-agent-teams');
    fs.mkdirSync(cloneDir, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: cloneDir });
    fs.writeFileSync(path.join(cloneDir, 'work.js'), 'unsaved');
    await expect(purgePlugin(paths, 'web', 'agent-teams', { dryRun: true })).rejects.toThrow(/uncommitted changes/);
    expect(fs.existsSync(path.join(cloneDir, 'work.js'))).toBe(true);
  });

  it('should copy managed patch into trash and strip the live block', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await applyEnvironment(paths);
    const patchFile = path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
    expect(fs.readFileSync(patchFile, 'utf8')).toContain('dshenv:begin');

    const result = await purgePlugin(paths, 'web', 'agent-teams');
    expect(result.moved.length).toBeGreaterThan(0);
    expect(fs.readFileSync(patchFile, 'utf8')).not.toContain('dshenv:begin');
    expect(result.moved.some((item) => item.includes('cordis.patch.yml'))).toBe(true);
  });

  it('finds nothing more to purge once the managed block is gone, and creates no trash entry', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await applyEnvironment(paths);
    await purgePlugin(paths, 'web', 'agent-teams');
    const trashBefore = fs.readdirSync(paths.trashDir);

    expect((await purgePlugin(paths, 'web', 'agent-teams', { dryRun: true })).moved).toEqual([]);
    const again = await purgePlugin(paths, 'web', 'agent-teams');
    expect(again.moved).toEqual([]);
    expect(again.message).toBe('Nothing to purge for agent-teams');
    expect(fs.readdirSync(paths.trashDir)).toEqual(trashBefore);
  });

  it('resolves an alias declared only in the effective manifest', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({
        apiVersion: 'dshenv-state/v1',
        lastApplied: 'x',
        appliedLockHash: '',
        profiles: {},
        resources: {
          plugin: {
            web: {
              '@nanmicoder/dsh-agent-teams': {
                package: '@nanmicoder/dsh-agent-teams',
                alias: 'old-alias',
                sourceType: 'npm',
                adoptedAt: 'x',
                adoptedBy: 'test'
              }
            }
          }
        }
      })
    );
    const effective = {
      apiVersion: 'dshenv/v1' as const,
      profiles: {
        web: { plugins: { teams: { package: '@nanmicoder/dsh-agent-teams', enabled: true, source: { type: 'npm' as const, version: '0.1.21' } } } }
      }
    };
    await expect(purgePlugin(paths, 'web', 'teams', { dryRun: true })).rejects.toThrow(/no ownership/);
    const result = await purgePlugin(paths, 'web', 'teams', { dryRun: true, manifest: effective });
    expect(result.package).toBe('@nanmicoder/dsh-agent-teams');
  });

  it('refuses to purge a managed clone with uncommitted changes and leaves it in place', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const cloneDir = path.join(paths.managerDir, 'sources', 'web', '@nanmicoder_dsh-agent-teams');
    fs.mkdirSync(cloneDir, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: cloneDir });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: cloneDir });
    fs.writeFileSync(path.join(cloneDir, 'wip.txt'), 'unsaved work');

    await expect(purgePlugin(paths, 'web', 'agent-teams')).rejects.toThrow(/uncommitted changes/);
    await expect(purgePlugin(paths, 'web', 'agent-teams', { dryRun: true })).rejects.toThrow(/uncommitted changes/);
    expect(fs.readFileSync(path.join(cloneDir, 'wip.txt'), 'utf8')).toBe('unsaved work');
  });

  it('refuses a patch file or clone that links outside DSH_HOME and changes nothing', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-purge-outside-'));
    try {
      const outsidePatch = path.join(outside, 'cordis.patch.yml');
      const content = '# dshenv:begin profile=web plugin=agent-teams digest=x\n- id: agent-teams\n# dshenv:end profile=web plugin=agent-teams\n';
      fs.writeFileSync(outsidePatch, content);
      fs.symlinkSync(outsidePatch, path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml'));
      await expect(purgePlugin(paths, 'web', 'agent-teams')).rejects.toThrow(/symlink outside allowed root/);
      expect(fs.readFileSync(outsidePatch, 'utf8')).toBe(content);
      fs.rmSync(path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml'));

      const outsideClone = path.join(outside, 'clone');
      fs.mkdirSync(outsideClone);
      fs.writeFileSync(path.join(outsideClone, 'keep.txt'), 'keep');
      fs.mkdirSync(path.join(paths.managerDir, 'sources', 'web'), { recursive: true });
      fs.symlinkSync(outsideClone, path.join(paths.managerDir, 'sources', 'web', '@nanmicoder_dsh-agent-teams'));
      await applyEnvironment(paths);
      const patchFile = path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
      const patched = fs.readFileSync(patchFile, 'utf8');
      await expect(purgePlugin(paths, 'web', 'agent-teams')).rejects.toThrow(/symlink outside allowed root/);
      expect(fs.readFileSync(path.join(outsideClone, 'keep.txt'), 'utf8')).toBe('keep');
      // Checked before the patch block is stripped, so a refused clone leaves the patch alone.
      expect(fs.readFileSync(patchFile, 'utf8')).toBe(patched);
      // A refusal starts no purge: no trash directory, no journal entry without its end.
      expect(fs.existsSync(paths.trashDir) ? fs.readdirSync(paths.trashDir).filter((name) => name.startsWith('purge-')) : []).toEqual([]);
      expect((await readJournalEntries(paths)).filter((entry) => entry.type === 'purge-started')).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('puts the patch block back when the clone cannot be moved to trash', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await applyEnvironment(paths);
    const patchFile = path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
    const patched = fs.readFileSync(patchFile, 'utf8');
    const cloneDir = path.join(paths.managerDir, 'sources', 'web', '@nanmicoder_dsh-agent-teams');
    fs.mkdirSync(cloneDir, { recursive: true });

    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === cloneDir) throw new Error('EXDEV: cross-device link');
      return rename(from, to);
    });
    try {
      await expect(purgePlugin(paths, 'web', 'agent-teams')).rejects.toThrow(/EXDEV/);
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readFileSync(patchFile, 'utf8')).toBe(patched);
    expect(fs.existsSync(cloneDir)).toBe(true);
  });
});
