import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment, type ApplyOptions } from '../../src/apply/apply.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { buildStatus, isProfileOperation } from '../../src/planner/plan.js';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';
import { loadManifest, loadState } from '../../src/manifest/files.js';
import type { EnvironmentState } from '../../src/domain.js';
import { execFileSync } from 'node:child_process';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';

// Fake DSH: `add` installs a bundle package and selects it, `remove` drops it; FAIL_ON makes adds of matching packages fail.
const FAKE_DSH = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(process.env.FAKE_DSH_VERSION ?? '0.1.7-rc.2'); process.exit(0); }
if (process.env.FAIL_ON && args.at(-1).includes(process.env.FAIL_ON)) { console.error('dsh: boom'); process.exit(7); }
const profileDir = path.join(process.env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1]);
fs.mkdirSync(profileDir, { recursive: true });
const pkgPath = path.join(profileDir, 'package.json');
const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } };
const spec = args.at(-1);
const name = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1) === -1 ? undefined : spec.indexOf('@', 1)) : spec.split('@')[0];
const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
if (args.includes('remove')) {
  delete pkg.dependencies[name];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== name);
  fs.rmSync(dir, { recursive: true, force: true });
} else {
  const version = spec.slice(name.length + 1);
  pkg.dependencies[name] = version;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: {} } }));
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg));
`;

describe('applyEnvironment ownership and recovery', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  let previousDshCli: string | undefined;
  const options: ApplyOptions = { probeHmr: async () => ({ state: 'off' }), hmrSettleMs: 0 };

  const plugin = (alias: string, pkg = alias, patch = false) =>
    `      ${alias}:\n        package: "${pkg}"\n        source: { type: npm, version: "1.0.0" }\n` +
    (patch ? `        patches:\n          - id: ${alias}\n            config: { a: 1 }\n` : '');
  const declare = (...plugins: string[]) =>
    fs.writeFileSync(
      paths.manifestFile,
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:${plugins.length > 0 ? `\n${plugins.join('')}` : ' {}\n'}`
    );
  const owned = (): string[] =>
    Object.keys((JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as { resources?: { plugin?: { web?: object } } }).resources?.plugin?.web ?? {}).sort();
  const dryRun = () => applyEnvironment(paths, { ...options, dryRun: true });
  const markHealthy = async () => {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as EnvironmentState;
    for (const record of Object.values(state.profiles.web?.plugins ?? {})) record.status = 'healthy';
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));
  };

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-ownership-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, FAKE_DSH);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    delete process.env.FAIL_ON;
    delete process.env.FAKE_DSH_VERSION;
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('applies only the profile given with profile, and keeps what it owns in the others', async () => {
    fs.mkdirSync(path.join(tempHome, 'profiles', 'headless'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', 'headless', 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const both = (web: string[], headless: string[]) =>
      fs.writeFileSync(
        paths.manifestFile,
        `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n${web.map((alias) => plugin(alias)).join('')}  headless:\n    plugins:${headless.length > 0 ? `\n${headless.map((alias) => plugin(alias)).join('')}` : ' {}\n'}`
      );
    const ownedIn = (profile: string): string[] =>
      Object.keys((JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as { resources?: { plugin?: Record<string, object> } }).resources?.plugin?.[profile] ?? {}).sort();
    const installedIn = (profile: string): string[] =>
      Object.keys((JSON.parse(fs.readFileSync(path.join(tempHome, 'profiles', profile, 'package.json'), 'utf8')) as { dependencies: object }).dependencies).sort();

    both(['aa'], ['bb']);
    const preview = await applyEnvironment(paths, { ...options, dryRun: true, profile: 'web' });
    expect(preview.plan.operations.filter(isProfileOperation).map((op) => `${op.profile}:${op.kind}`)).toEqual(['web:install']);
    await applyEnvironment(paths, { ...options, profile: 'web' });
    expect(installedIn('web')).toEqual(['aa']);
    expect(installedIn('headless')).toEqual([]);
    await applyEnvironment(paths, options);
    expect([ownedIn('web'), ownedIn('headless')]).toEqual([['aa'], ['bb']]);

    // bb leaves the headless manifest, but applying web alone must not drop its ownership, or no later apply removes it.
    both(['aa', 'cc'], []);
    await applyEnvironment(paths, { ...options, profile: 'web' });
    expect(installedIn('web')).toEqual(['aa', 'cc']);
    expect([ownedIn('web'), ownedIn('headless')]).toEqual([['aa', 'cc'], ['bb']]);
    await applyEnvironment(paths, { ...options, profile: 'headless' });
    expect(installedIn('headless')).toEqual([]);
    expect(ownedIn('headless')).toEqual([]);
  });

  it('owns a plugin it installed even when a later operation of the same apply fails', async () => {
    declare(plugin('aa'), plugin('bb'));
    process.env.FAIL_ON = 'bb';
    await expect(applyEnvironment(paths, options)).rejects.toThrow(/exited with code 7/);
    expect(owned()).toEqual(['aa']);

    delete process.env.FAIL_ON;
    await applyEnvironment(paths, options);
    expect(owned()).toEqual(['aa', 'bb']);

    declare(plugin('bb'));
    const plan = await dryRun();
    expect(plan.plan.operations.filter((op) => op.resource === 'plugin').map((op) => `${op.kind}:${op.package}`)).toEqual(['remove:aa']);
    expect(plan.plan.unmanaged).toEqual([]);
  });

  it('owns a plugin it updated even when a later operation of the same apply fails', async () => {
    // DSH installed aa and zz 0.9.0 on its own; the manifest wants 1.0.0, so apply replaces both.
    const profileDir = path.join(tempHome, 'profiles', 'web');
    for (const name of ['aa', 'zz']) {
      fs.mkdirSync(path.join(profileDir, 'node_modules', name), { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.9.0', dsh: { bundle: {} } }));
    }
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { aa: '0.9.0', zz: '0.9.0' }, dsh: { profile: { bundles: ['aa', 'zz'] } } }));
    declare(plugin('aa'), plugin('zz'));
    expect((await dryRun()).plan.operations.filter((op) => op.resource === 'plugin').map((op) => `${op.kind}:${op.package}`)).toEqual(['update:aa', 'update:zz']);
    process.env.FAIL_ON = 'zz';
    await expect(applyEnvironment(paths, options)).rejects.toThrow(/exited with code 7/);
    expect(owned()).toEqual(['aa']);
  });

  it('leaves the manifest and envctl skills alone when apply fails, restoring only lock and state', async () => {
    declare(plugin('aa'));
    fs.mkdirSync(path.join(paths.skillsDir, 'myskill'), { recursive: true });
    fs.writeFileSync(path.join(paths.skillsDir, 'myskill', 'SKILL.md'), 'v1');
    fs.writeFileSync(paths.stateFile, JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: 'before', appliedLockHash: '', profiles: {} }));
    const stateBefore = fs.readFileSync(paths.stateFile, 'utf8');

    await expect(
      applyEnvironment(paths, {
        ...options,
        // Stands in for a DSH install that runs for minutes while the user keeps editing envctl files.
        executor: async () => {
          fs.appendFileSync(paths.manifestFile, '# edited while apply ran\n');
          fs.writeFileSync(path.join(paths.skillsDir, 'myskill', 'SKILL.md'), 'v2');
          fs.mkdirSync(path.join(paths.skillsDir, 'newskill'));
          fs.writeFileSync(paths.stateFile, '{"broken": true}');
          fs.writeFileSync(paths.lockFile, '{"broken": true}');
          return { success: false, error: 'pnpm failed' };
        }
      })
    ).rejects.toThrow(/pnpm failed/);

    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toContain('# edited while apply ran');
    expect(fs.readFileSync(path.join(paths.skillsDir, 'myskill', 'SKILL.md'), 'utf8')).toBe('v2');
    expect(fs.existsSync(path.join(paths.skillsDir, 'newskill'))).toBe(true);
    expect(fs.readFileSync(paths.stateFile, 'utf8')).toBe(stateBefore);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  it('reports a failed restore instead of hiding it', async () => {
    declare(plugin('aa'));
    const error = await applyEnvironment(paths, {
      ...options,
      executor: async () => {
        // state.json can no longer be replaced by a file.
        fs.mkdirSync(path.join(paths.stateFile, 'blocker'), { recursive: true });
        return { success: false, error: 'pnpm failed' };
      }
    }).then(
      () => { throw new Error('apply should fail'); },
      (err: Error) => err
    );
    expect(error.message).toMatch(/pnpm failed/);
    expect(error.message).toMatch(/restoring lock\.json and state\.json from snapshot .+ also failed/);
    expect(error.message).toMatch(/dshenv rollback/);
  });

  it('swaps the package behind an alias in one apply, whatever the package names sort as', async () => {
    fs.writeFileSync(path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml'), '[]\n');
    declare(plugin('foo', 'zz-old', true));
    await applyEnvironment(paths, options);

    declare(plugin('foo', 'aa-new', true));
    const result = await applyEnvironment(paths, options);
    expect(result.applied).toBe(true);
    expect(fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toContain('plugin=foo');
    expect(owned()).toEqual(['aa-new']);
    expect((await dryRun()).plan.hasChanges).toBe(false);
  });

  it('keeps ownership of plugins a rolled-back apply installed, since they stay installed', async () => {
    declare(plugin('aa'));
    await applyEnvironment(paths, options);
    declare(plugin('aa'), plugin('bb'));
    const second = await applyEnvironment(paths, options);

    await rollbackEnvironment(paths, { operationId: second.operationId });
    expect(owned()).toEqual(['aa', 'bb']);

    declare(plugin('aa'));
    const plan = await dryRun();
    expect(plan.plan.operations.filter((op) => op.resource === 'plugin').map((op) => `${op.kind}:${op.package}`)).toEqual(['remove:bb']);
  });

  const handInstall = (spec: string) =>
    execFileSync(process.execPath, [path.join(tempHome, 'fake-dsh.mjs'), 'plugin', '--profile', 'web', 'add', spec], { env: { ...process.env, DSH_HOME: tempHome } });
  const pluginOps = async () => (await dryRun()).plan.operations.filter((op) => op.resource === 'plugin').map((op) => `${op.kind}:${op.package}`);
  const stateOf = (pkg: string) => (JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as EnvironmentState).profiles.web?.plugins[pkg]?.status;
  const status = async () => {
    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    return buildStatus(loadManifest(fs.readFileSync(paths.manifestFile, 'utf8')), state, await readEnvironmentInventory(paths), (await dryRun()).plan);
  };

  it('drops the ownership a rollback restores for a plugin no longer installed, so a later hand install is left alone', async () => {
    declare(plugin('aa'), plugin('bb'));
    await applyEnvironment(paths, options);
    declare(plugin('aa'));
    const removal = await applyEnvironment(paths, options);
    await rollbackEnvironment(paths, { operationId: removal.operationId });
    expect(owned()).toEqual(['aa']);

    declare(plugin('aa'));
    handInstall('bb@2.0.0');
    expect(await pluginOps()).toEqual([]);
  });

  it('drops the ownership of a plugin a failed apply already removed', async () => {
    declare(plugin('aa'), plugin('bb'));
    await applyEnvironment(paths, options);
    declare(plugin('aa'), plugin('cc'));
    process.env.FAIL_ON = 'cc';
    await expect(applyEnvironment(paths, options)).rejects.toThrow();
    delete process.env.FAIL_ON;
    expect(owned()).toEqual(['aa']);
  });

  it('owes a restart for the steps a failed apply completed', async () => {
    declare(plugin('aa'), plugin('zz'));
    await applyEnvironment(paths, options);
    await markHealthy();
    fs.writeFileSync(paths.manifestFile, fs.readFileSync(paths.manifestFile, 'utf8').replaceAll('1.0.0', '2.0.0'));
    process.env.FAIL_ON = 'zz';
    await expect(applyEnvironment(paths, options)).rejects.toThrow();
    delete process.env.FAIL_ON;
    expect(stateOf('aa')).toBe('restart-required');
    expect(stateOf('zz')).toBe('healthy');
  });

  it('keeps a restart owed when rolling back, since the running DSH is unchanged', async () => {
    declare(plugin('aa'));
    const first = await applyEnvironment(paths, options);
    await markHealthy();
    declare(plugin('aa'), plugin('bb'));
    await applyEnvironment(paths, options);
    expect(stateOf('bb')).toBe('restart-required');
    await rollbackEnvironment(paths, { operationId: first.operationId });
    expect(stateOf('bb')).toBe('restart-required');
  });

  it('reports restart-required for a removed plugin DSH still runs', async () => {
    declare(plugin('aa'), plugin('bb'));
    await applyEnvironment(paths, options);
    await markHealthy();
    declare(plugin('aa'));
    await applyEnvironment(paths, options);
    const summary = await status();
    expect(summary.status).toBe('restart-required');
    expect(summary.plugins).toContainEqual({ profile: 'web', package: 'bb', status: 'restart-required' });
  });

  it('reports restart-required for a declared plugin the inventory does not list', async () => {
    fs.writeFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-tool-z'] } } }));
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      tz:\n        package: "@deepseek-ai/dsh-tool-z"\n        source: { type: in-box }\n        enabled: false\n');
    await applyEnvironment(paths, options);
    expect(stateOf('@deepseek-ai/dsh-tool-z')).toBe('restart-required');
    expect((await status()).status).toBe('restart-required');
  });

  it('honors allowUntestedVersion from the manifest', async () => {
    process.env.FAKE_DSH_VERSION = '0.9.0';
    fs.writeFileSync(
      paths.manifestFile,
      `apiVersion: dshenv/v1\nenvironment:\n  harness:\n    allowUntestedVersion: true\nprofiles:\n  web:\n    plugins:\n${plugin('aa')}`
    );
    const result = await applyEnvironment(paths, options);
    expect(result.applied).toBe(true);
  });
});
