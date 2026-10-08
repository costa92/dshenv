import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { loadState, loadLock, serializeLock } from '../../src/manifest/files.js';

describe('applyEnvironment', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-test-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });

    // Write empty manifest and lock
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
`
    );

    fs.writeFileSync(
      path.join(managerDir, 'lock.json'),
      `{
  "apiVersion": "dshenv-lock/v1",
  "profiles": {
    "web": {
      "plugins": {
        "agent-teams": {
          "package": "@nanmicoder/dsh-agent-teams",
          "source": {
            "type": "npm",
            "resolvedVersion": "0.1.21"
          }
        }
      }
    }
  }
}`
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
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function installDeclaredPlugin(): void {
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
  }

  it('should perform dry-run apply without modifying state', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const res = await applyEnvironment(paths, { dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.plan.hasChanges).toBe(true);

    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.lastApplied).toBe('2026-01-01T00:00:00.000Z');
  });

  it('takes ownership of a plugin it installed, so removing it from the manifest removes it', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '2026-01-01T00:00:00.000Z', appliedLockHash: '', profiles: {} })
    );
    await applyEnvironment(paths, {
      dryRun: false,
      executor: async () => {
        installDeclaredPlugin();
        return { success: true };
      }
    });

    const owned = loadState(fs.readFileSync(paths.stateFile, 'utf8')).resources?.plugin?.web?.['@nanmicoder/dsh-agent-teams'];
    expect(owned).toMatchObject({ package: '@nanmicoder/dsh-agent-teams', alias: 'agent-teams', sourceType: 'npm', lockedVersion: '0.1.21' });

    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    const res = await applyEnvironment(paths, { dryRun: true });
    expect(res.plan.operations.filter((op) => op.resource === 'plugin').map((op) => [op.kind, op.package])).toEqual([['remove', '@nanmicoder/dsh-agent-teams']]);
  });

  it('takes ownership of a plugin DSH already had when apply updates it to the declared version', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '2026-01-01T00:00:00.000Z', appliedLockHash: '', profiles: {} })
    );
    installDeclaredPlugin();
    const installedPackage = path.join(tempHome, 'profiles', 'web', 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json');
    fs.writeFileSync(installedPackage, JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.20', dsh: { bundle: {} } }));

    const res = await applyEnvironment(paths, {
      dryRun: false,
      executor: async () => {
        installDeclaredPlugin();
        return { success: true };
      }
    });
    expect(res.plan.operations.map((op) => op.kind)).toContain('update');

    const owned = loadState(fs.readFileSync(paths.stateFile, 'utf8')).resources?.plugin?.web?.['@nanmicoder/dsh-agent-teams'];
    expect(owned).toMatchObject({ alias: 'agent-teams', lockedVersion: '0.1.21', adoptedBy: res.operationId });

    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    const removal = await applyEnvironment(paths, { dryRun: true });
    expect(removal.plan.operations.filter((op) => op.resource === 'plugin').map((op) => [op.kind, op.package])).toEqual([['remove', '@nanmicoder/dsh-agent-teams']]);
  });

  it('records the new version of an owned plugin apply updated, and keeps when it was first owned', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
    state.resources.plugin.web['@nanmicoder/dsh-agent-teams'].lockedVersion = '0.1.20';
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));
    installDeclaredPlugin();
    const installedPackage = path.join(tempHome, 'profiles', 'web', 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json');
    fs.writeFileSync(installedPackage, JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.20', dsh: { bundle: {} } }));

    const res = await applyEnvironment(paths, {
      dryRun: false,
      executor: async () => {
        installDeclaredPlugin();
        return { success: true };
      }
    });
    expect(res.plan.operations.map((op) => op.kind)).toContain('update');

    const owned = loadState(fs.readFileSync(paths.stateFile, 'utf8')).resources?.plugin?.web?.['@nanmicoder/dsh-agent-teams'];
    expect(owned).toMatchObject({ lockedVersion: '0.1.21', adoptedAt: '2026-01-01T00:00:00.000Z', adoptedBy: 'test' });
  });

  it('should apply changes, create snapshot, journal and update state.json', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const res = await applyEnvironment(paths, {
      dryRun: false,
      executor: async () => {
        installDeclaredPlugin();
        return { success: true };
      }
    });

    expect(res.applied).toBe(true);
    expect(res.operationId).toBeDefined();

    // Verify snapshot created
    expect(fs.existsSync(paths.backupsDir)).toBe(true);
    const backups = fs.readdirSync(paths.backupsDir);
    expect(backups.length).toBeGreaterThan(0);

    // Verify state updated
    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.lastApplied).not.toBe('2026-01-01T00:00:00.000Z');
    expect(Date.now() - Date.parse(state.lastApplied)).toBeLessThan(60_000);
    // The hash identifies the lock that was applied, so a later lock edit shows up as unapplied.
    expect(state.appliedLockHash).toBe(crypto.createHash('sha256').update(serializeLock(loadLock(fs.readFileSync(paths.lockFile, 'utf8')))).digest('hex'));

    // Verify journal appended
    const journalFile = path.join(paths.logsDir, 'journal.jsonl');
    expect(fs.existsSync(journalFile)).toBe(true);
    const journal = fs.readFileSync(journalFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(journal).toContainEqual(expect.objectContaining({ operationId: res.operationId, type: 'apply-completed' }));
  });

  it('should reject a successful executor when the environment remains drifted', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });

    await expect(applyEnvironment(paths, {
      executor: async () => ({ success: true })
    })).rejects.toThrow('environment still has pending operations');

    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.lastApplied).toBe('2026-01-01T00:00:00.000Z');
  });

  it('should execute install operations through the configured DSH CLI by default', async () => {
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.7-rc.2');
  process.exit(0);
}
const profile = args[args.indexOf('--profile') + 1];
const spec = args.at(-1);
const packageName = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1)) : spec.split('@')[0];
const version = spec.slice(packageName.length + 1);
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const packageDir = path.join(profileDir, 'node_modules', ...packageName.split('/'));
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-' + profile,
  private: true,
  dependencies: { [packageName]: version },
  dsh: { profile: { bundles: [packageName] } }
}));
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version, dsh: { bundle: {} } }));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);

    expect(result.applied).toBe(true);
    const profile = JSON.parse(fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8'));
    expect(profile.dependencies).toEqual({ '@nanmicoder/dsh-agent-teams': '0.1.21' });
    const appliedState = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(appliedState.profiles.web.plugins['@nanmicoder/dsh-agent-teams'].status).toBe('restart-required');
    expect(appliedState.profiles.web.plugins['@nanmicoder/dsh-agent-teams'].installedVersion).toBe('0.1.21');
  });

  it('should record the verified installed version instead of dropping it when marking restart-required', async () => {
    installDeclaredPlugin();
    const manifestPath = path.join(tempHome, 'envctl', 'manifest.yaml');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('enabled: true', 'enabled: false'));
    const statePath = path.join(tempHome, 'envctl', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      profiles: Record<string, { plugins: Record<string, unknown> }>;
    };
    state.profiles = {
      web: {
        plugins: {
          '@nanmicoder/dsh-agent-teams': {
            package: '@nanmicoder/dsh-agent-teams',
            status: 'healthy',
            installedVersion: '0.1.20',
            lastVerified: '2026-01-01T00:00:00.000Z'
          }
        }
      }
    };
    fs.writeFileSync(statePath, JSON.stringify(state));

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.plan.operations.map((op) => op.kind)).toEqual(['disable']);

    const entry = loadState(fs.readFileSync(paths.stateFile, 'utf8')).profiles.web.plugins['@nanmicoder/dsh-agent-teams'];
    expect(entry.status).toBe('restart-required');
    expect(entry.installedVersion).toBe('0.1.21');
    expect(entry.lastVerified).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('should refuse install when the DSH runtime version is unsupported', async () => {
    const fakeDsh = path.join(tempHome, 'bad-version-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.70');
  process.exit(0);
}
process.exit(0);
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await expect(applyEnvironment(paths)).rejects.toThrow(
      'Unsupported DSH version 0.1.70: dshenv supports DSH 0.1.7, 0.2.0, 0.2.1 (e.g. 0.2.0-rc.2). Point DSH_CLI at a supported DSH, or pass --allow-untested-dsh to use this one anyway.'
    );
    // Refused before it started: no snapshot for rollback to pick, no journal entry.
    expect(fs.existsSync(paths.backupsDir) ? fs.readdirSync(paths.backupsDir) : []).toEqual([]);
    expect(fs.existsSync(path.join(paths.logsDir, 'journal.jsonl'))).toBe(false);
    // A preview checks the version too, so it does not promise a plan the real apply then refuses.
    await expect(applyEnvironment(paths, { dryRun: true })).rejects.toThrow(/^Unsupported DSH version 0\.1\.70:/);
    await expect(applyEnvironment(paths, { dryRun: true, allowUntested: true })).resolves.toMatchObject({ dryRun: true });
  });

  it('should enable an installed plugin by updating dsh.profile.bundles without invoking DSH CLI', async () => {
    installDeclaredPlugin();
    const profileJson = path.join(tempHome, 'profiles', 'web', 'package.json');
    const profile = JSON.parse(fs.readFileSync(profileJson, 'utf8')) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    profile.dsh.profile.bundles = [];
    fs.writeFileSync(profileJson, JSON.stringify(profile, null, 2));

    const marker = path.join(tempHome, 'dsh-was-called');
    const fakeDsh = path.join(tempHome, 'must-not-run.mjs');
    fs.writeFileSync(fakeDsh, `import fs from 'node:fs'; if (process.argv.includes('--dump-config')) process.exit(1); fs.writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    const next = JSON.parse(fs.readFileSync(profileJson, 'utf8')) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(next.dsh.profile.bundles).toContain('@nanmicoder/dsh-agent-teams');
    expect(next.dependencies['@nanmicoder/dsh-agent-teams']).toBe('0.1.21');
  });

  it('should disable an installed plugin by removing it from bundles and keeping the dependency', async () => {
    installDeclaredPlugin();
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: false
        source:
          type: npm
          version: "0.1.21"
`
    );

    const marker = path.join(tempHome, 'dsh-was-called');
    const fakeDsh = path.join(tempHome, 'must-not-run.mjs');
    fs.writeFileSync(fakeDsh, `import fs from 'node:fs'; if (process.argv.includes('--dump-config')) process.exit(1); fs.writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    const next = JSON.parse(
      fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
    expect(next.dsh.profile.bundles).not.toContain('@nanmicoder/dsh-agent-teams');
    expect(next.dependencies['@nanmicoder/dsh-agent-teams']).toBe('0.1.21');
  });

  it('should uninstall an owned plugin removed from the manifest via DSH CLI', async () => {
    installDeclaredPlugin();
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins: {}
`
    );

    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(
      fakeDsh,
      `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.7-rc.2');
  process.exit(0);
}
if (!args.includes('remove')) process.exit(2);
const profile = args[args.indexOf('--profile') + 1];
const packageName = args.at(-1);
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const pkgJsonPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
delete pkg.dependencies[packageName];
fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
const packageDir = path.join(profileDir, 'node_modules', ...packageName.split('/'));
fs.rmSync(packageDir, { recursive: true, force: true });
`
    );
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(result.plan.operations[0]?.kind).toBe('remove');

    const profile = JSON.parse(
      fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
    expect(profile.dependencies['@nanmicoder/dsh-agent-teams']).toBeUndefined();
    expect(profile.dsh.profile.bundles).not.toContain('@nanmicoder/dsh-agent-teams');

    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.resources?.plugin?.web?.['@nanmicoder/dsh-agent-teams']).toBeUndefined();
  });

  it('should restore the lock file when apply execution fails', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const original = fs.readFileSync(paths.lockFile, 'utf8');

    await expect(
      applyEnvironment(paths, {
        executor: async () => {
          fs.writeFileSync(paths.lockFile, 'corrupted\n');
          return { success: false, error: 'injected failure' };
        }
      })
    ).rejects.toThrow(/injected failure/);

    expect(fs.readFileSync(paths.lockFile, 'utf8')).toBe(original);
  });

  it('should write managed patches during apply configure', async () => {
    installDeclaredPlugin();
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
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

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(result.plan.operations[0]?.kind).toBe('configure');
    const patchFile = path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
    const content = fs.readFileSync(patchFile, 'utf8');
    expect(content).toContain('# dshenv:begin profile=web plugin=agent-teams');
    expect(content).toContain('taskPlanning: captain');

    const second = await applyEnvironment(paths);
    expect(second.applied).toBe(false);
    expect(second.plan.hasChanges).toBe(false);
  });

  it('should install and disable a new plugin in a single apply, leaving its patch out while it is disabled', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: false
        source:
          type: npm
          version: "0.1.21"
        patches:
          - id: agent-teams
            config:
              taskPlanning: captain
`
    );
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.7-rc.2');
  process.exit(0);
}
const profile = args[args.indexOf('--profile') + 1];
const spec = args.at(-1);
const packageName = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1)) : spec.split('@')[0];
const version = spec.slice(packageName.length + 1);
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const packageDir = path.join(profileDir, 'node_modules', ...packageName.split('/'));
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-' + profile,
  private: true,
  dependencies: { [packageName]: version },
  dsh: { profile: { bundles: [packageName] } }
}));
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version, dsh: { bundle: {} } }));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(result.plan.operations.map((op) => op.kind)).toEqual(['install', 'disable']);

    const profile = JSON.parse(
      fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8')
    ) as { dsh: { profile: { bundles: string[] } } };
    expect(profile.dsh.profile.bundles).not.toContain('@nanmicoder/dsh-agent-teams');
    // DSH does not load a disabled plugin, so its patch would fail with "entry not found".
    const patchFile = path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
    expect(fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '').not.toContain('taskPlanning');

    const second = await applyEnvironment(paths);
    expect(second.plan.hasChanges).toBe(false);
  });

  it.each([
    ['https://example.com/demo.git', 'git+https://example.com/demo.git'],
    ['file:///srv/git/demo', 'git+file:///srv/git/demo'],
    ['ssh://git@example.com/demo.git', 'git+ssh://git@example.com/demo.git'],
    ['git+https://example.com/demo.git', 'git+https://example.com/demo.git'],
    ['git://example.com/demo.git', 'git://example.com/demo.git'],
    ['git@example.com:team/demo.git', 'git@example.com:team/demo.git']
  ])('should reinstall a git plugin from %s at the locked commit after the lock moves', async (url, expectedSpec) => {
    const oldCommit = 'a'.repeat(40);
    const newCommit = 'b'.repeat(40);
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo:
        package: demo-plugin
        source:
          type: git
          url: "${url}"
`
    );
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'lock.json'),
      JSON.stringify({
        apiVersion: 'dshenv-lock/v1',
        profiles: {
          web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'git', url, commit: newCommit } } } }
        }
      })
    );
    const profileDir = path.join(tempHome, 'profiles', 'web');
    const writeInstalled = (spec: string): void => {
      fs.mkdirSync(path.join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, 'package.json'),
        JSON.stringify({ dependencies: { 'demo-plugin': spec }, dsh: { profile: { bundles: ['demo-plugin'] } } })
      );
      fs.writeFileSync(
        path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'),
        JSON.stringify({ name: 'demo-plugin', version: '0.1.0', dsh: { bundle: {} } })
      );
    };
    writeInstalled(`${url}#${oldCommit}`);

    const received = path.join(tempHome, 'dsh-received-spec');
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.7-rc.2');
  process.exit(0);
}
const spec = args.at(-1);
fs.writeFileSync(${JSON.stringify(received)}, spec);
const pkgJsonPath = path.join(process.env.DSH_HOME, 'profiles', 'web', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
pkg.dependencies['demo-plugin'] = spec;
fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(result.plan.operations.map((op) => op.kind)).toEqual(['update']);
    // pnpm reads a bare file:// or non-hosted https:// URL as a local path or tarball, not a Git repository.
    expect(fs.readFileSync(received, 'utf8')).toBe(`${expectedSpec}#${newCommit}`);

    const second = await applyEnvironment(paths);
    expect(second.plan.hasChanges).toBe(false);
  });

  it('should reinstall a local-file plugin when its source changes and record the digest in the lock', async () => {
    const sourceDir = path.join(tempHome, 'src', 'demo');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.0', dsh: { bundle: {} } }));
    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'export const v = 1;\n');
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo:
        package: demo-plugin
        source:
          type: local-file
          path: ${JSON.stringify(sourceDir)}
`
    );
    fs.writeFileSync(path.join(tempHome, 'envctl', 'lock.json'), JSON.stringify({ apiVersion: 'dshenv-lock/v1', profiles: {} }));
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'demo-plugin': `file:${sourceDir}` }, dsh: { profile: { bundles: ['demo-plugin'] } } })
    );
    fs.writeFileSync(
      path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '0.1.0', dsh: { bundle: {} } })
    );

    const calls = path.join(tempHome, 'dsh-calls');
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.7-rc.2');
  process.exit(0);
}
if (args.includes('--dump-config')) process.exit(1);
fs.appendFileSync(${JSON.stringify(calls)}, args.at(-1) + '\\n');
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });

    // No digest recorded yet: the installed copy cannot be proven current, so it is reinstalled once.
    const first = await applyEnvironment(paths);
    expect(first.plan.operations.map((op) => op.kind)).toEqual(['update']);
    const firstDigest = loadLock(fs.readFileSync(paths.lockFile, 'utf8')).profiles.web.plugins.demo.source;
    expect(firstDigest).toMatchObject({ type: 'local-file', path: sourceDir, digest: expect.any(String) });

    expect((await applyEnvironment(paths)).plan.hasChanges).toBe(false);

    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'export const v = 2;\n');
    const third = await applyEnvironment(paths);
    expect(third.plan.operations.map((op) => op.kind)).toEqual(['update']);
    const thirdDigest = loadLock(fs.readFileSync(paths.lockFile, 'utf8')).profiles.web.plugins.demo.source;
    expect(thirdDigest).not.toEqual(firstDigest);
    expect(fs.readFileSync(calls, 'utf8')).toBe(`file:${sourceDir}\nfile:${sourceDir}\n`);
  });
});
