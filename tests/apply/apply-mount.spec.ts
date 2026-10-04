import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { readMounts } from '../../src/patch/mount.js';

const PKG = '@acme/plain';

// A plugin package without dsh.bundle: DSH skips it in the bundle list, so dshenv mounts it through an insert row.
describe('apply a plugin that is not a DSH bundle', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  let previousDshCli: string | undefined;
  const profileDir = () => path.join(tempHome, 'profiles', 'web');
  const profileJson = () => JSON.parse(fs.readFileSync(path.join(profileDir(), 'package.json'), 'utf8'));
  const mounts = () => readMounts(fs.readFileSync(path.join(profileDir(), 'cordis.patch.yml'), 'utf8'), 'web');
  const declare = (plugin: string) =>
    fs.writeFileSync(paths.manifestFile, `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n${plugin}`);
  const plain = (enabled: boolean) =>
    `      plain:\n        package: "${PKG}"\n        enabled: ${enabled}\n        source: { type: npm, version: "1.0.0" }\n`;

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-mount-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.mkdirSync(profileDir(), { recursive: true });
    fs.writeFileSync(path.join(profileDir(), 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
    fs.writeFileSync(path.join(profileDir(), 'cordis.patch.yml'), '# user header\n[]\n');
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    // Like DSH, plugin add installs a package without dsh.bundle but leaves the bundle list alone.
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
if (args.includes('--dump-config')) process.exit(1);
const profile = args[args.indexOf('--profile') + 1];
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const spec = args.at(-1);
const name = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1) === -1 ? undefined : spec.indexOf('@', 1)) : spec.split('@')[0];
const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
if (args.includes('remove')) {
  delete pkg.dependencies[name];
  fs.rmSync(dir, { recursive: true, force: true });
} else {
  const version = spec.slice(name.length + 1);
  pkg.dependencies[name] = version;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('mounts it in the same apply that installs it, and switches the mount on and off', async () => {
    declare(plain(true));
    expect((await applyEnvironment(paths)).applied).toBe(true);
    expect(profileJson().dependencies).toEqual({ [PKG]: '1.0.0' });
    expect(profileJson().dsh.profile.bundles).toEqual([]);
    expect(mounts()).toEqual({ plain: PKG });
    expect(fs.readFileSync(path.join(profileDir(), 'cordis.patch.yml'), 'utf8').startsWith('# user header\n')).toBe(true);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.operations).toEqual([]);

    declare(plain(false));
    await applyEnvironment(paths);
    expect(mounts()).toEqual({});
    expect(profileJson().dsh.profile.bundles).toEqual([]);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.operations).toEqual([]);

    declare(plain(true));
    await applyEnvironment(paths);
    expect(mounts()).toEqual({ plain: PKG });

    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    await applyEnvironment(paths);
    expect(profileJson().dependencies).toEqual({});
    expect(mounts()).toEqual({});
  });

  const patchFile = () => fs.readFileSync(path.join(profileDir(), 'cordis.patch.yml'), 'utf8');
  const withPatch = (alias: string) =>
    `      ${alias}:\n        package: "${PKG}"\n        source: { type: npm, version: "1.0.0" }\n        patches:\n          - id: ${alias}\n            config: { a: 1 }\n`;

  it('moves the mount and patches to the new alias when only the alias is renamed', async () => {
    declare(withPatch('foo'));
    await applyEnvironment(paths);
    expect(mounts()).toEqual({ foo: PKG });

    declare(withPatch('bar'));
    await applyEnvironment(paths);
    expect(mounts()).toEqual({ bar: PKG });
    expect(patchFile()).not.toContain('plugin=foo');
    expect(patchFile()).toContain('plugin=bar');
    expect((await applyEnvironment(paths, { dryRun: true })).plan.operations).toEqual([]);
  });

  it('clears the blocks of a plugin it does not own once the manifest drops it, and leaves the package installed', async () => {
    execFileSync(process.execPath, [path.join(tempHome, 'fake-dsh.mjs'), 'plugin', '--profile', 'web', 'add', `${PKG}@1.0.0`], { env: { ...process.env, DSH_HOME: tempHome } });
    declare(withPatch('plain'));
    await applyEnvironment(paths);
    expect(patchFile()).toContain('plugin=plain');

    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    const plan = (await applyEnvironment(paths, { dryRun: true })).plan;
    expect(plan.operations.map((op) => `${op.kind}:${'alias' in op ? op.alias : ''}`)).toEqual(['configure:plain']);
    await applyEnvironment(paths);
    expect(patchFile()).not.toContain('plugin=plain');
    expect(mounts()).toEqual({});
    expect(profileJson().dependencies).toEqual({ [PKG]: '1.0.0' });
    expect((await applyEnvironment(paths, { dryRun: true })).plan.operations).toEqual([]);
  });
});
