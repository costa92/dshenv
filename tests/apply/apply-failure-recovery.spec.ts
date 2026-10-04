import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment, type ApplyOptions } from '../../src/apply/apply.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { markRestarted } from '../../src/restart/restart.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';

const hint = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/rollback/rollback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rollback/rollback.js')>();
  return {
    ...actual,
    lastSuccessfulApply: async (...args: Parameters<typeof actual.lastSuccessfulApply>) => {
      if (hint.fail) throw new Error('EACCES: backups unreadable');
      return actual.lastSuccessfulApply(...args);
    }
  };
});

// Fake DSH: `add` installs a bundle package; FAIL_ON makes adds of matching packages fail.
const FAKE_DSH = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
if (process.env.FAIL_ON && args.at(-1).includes(process.env.FAIL_ON)) { console.error('dsh: boom'); process.exit(7); }
const profileDir = path.join(process.env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1]);
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const spec = args.at(-1);
if (spec.startsWith('link:')) {
  const source = spec.slice('link:'.length);
  const name = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).name;
  pkg.dependencies[name] = spec;
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.symlinkSync(source, path.join(profileDir, 'node_modules', name), 'junction');
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  process.exit(0);
}
const name = spec.split('@')[0];
const dir = path.join(profileDir, 'node_modules', name);
pkg.dependencies[name] = spec.slice(name.length + 1);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: spec.slice(name.length + 1), dsh: { bundle: {} } }));
if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
fs.writeFileSync(pkgPath, JSON.stringify(pkg));
`;

describe('applyEnvironment failure recovery', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  let previousDshCli: string | undefined;
  const options: ApplyOptions = { probeHmr: async () => ({ state: 'off' }), hmrSettleMs: 0 };

  const plugin = (alias: string) => `      ${alias}:\n        package: "${alias}"\n        source: { type: npm, version: "1.0.0" }\n`;
  const manifest = (...plugins: string[]) => `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n${plugins.join('')}`;
  const overlay = (...plugins: string[]) => `apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n${plugins.join('')}`;
  const overlayFile = () => path.join(paths.overlaysDir, 'laptop.yaml');

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-recovery-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, FAKE_DSH);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    hint.fail = false;
    delete process.env.FAIL_ON;
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('names the failed step, its operation and how to get back to the manifest last applied', async () => {
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa')));
    const good = await applyEnvironment(paths, options);

    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa'), plugin('bb'), plugin('cc')));
    process.env.FAIL_ON = 'cc';
    const failure = await applyEnvironment(paths, options).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/^Apply execution failed at \[web\] install cc \(cc\), step 2 of 2: DSH plugin command exited with code 7/);
    expect(message).toMatch(/\nApply apply-[0-9a-f]{12} put lock\.json and state\.json back; plugins it installed before failing stay installed: bb\.\n/);
    expect(message).toContain(
      `The manifest still declares what failed: fix it and apply again, or go back to the manifest apply ${good.operationId} applied (dropping every manifest change made since) with: dshenv rollback ${good.operationId} --yes`
    );
  });

  it('keeps the digest of a local plugin installed before the failure, so the next plan does not reinstall it', async () => {
    const source = path.join(tempHome, 'src', 'aa-local');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'aa-local', version: '1.0.0', dsh: { bundle: {} } }));
    const local = `      aa-local:\n        package: aa-local\n        source: { type: local-link, path: ${JSON.stringify(source)} }\n`;
    fs.writeFileSync(paths.manifestFile, manifest(local, plugin('zz')));
    process.env.FAIL_ON = 'zz';
    await expect(applyEnvironment(paths, options)).rejects.toThrow(/install zz/);

    const lock = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8'));
    expect(lock.profiles.web.plugins['aa-local'].source.digest).toMatch(/^[0-9a-f]{64}$/);
    const preview = await applyEnvironment(paths, { ...options, dryRun: true });
    expect(preview.plan.operations.filter((op) => op.resource === 'plugin').map((op) => `${op.kind} ${op.alias}`)).toEqual(['install zz']);
  });

  it('does not report a failed restore when only looking up the way back fails', async () => {
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa'), plugin('bb')));
    process.env.FAIL_ON = 'bb';
    hint.fail = true;
    const message = ((await applyEnvironment(paths, options).catch((err: Error) => err)) as Error).message;
    expect(message).toMatch(/put lock\.json and state\.json back/);
    expect(message).not.toMatch(/also failed/);
  });

  it('rolls back past a failed apply that already undid itself, to the last apply that changed something', async () => {
    const goodManifest = manifest(plugin('aa'));
    fs.writeFileSync(paths.manifestFile, goodManifest);
    const good = await applyEnvironment(paths, options);

    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa'), plugin('bb')));
    process.env.FAIL_ON = 'bb';
    await expect(applyEnvironment(paths, options)).rejects.toThrow(/install bb/);

    const result = await rollbackEnvironment(paths);
    expect(result.snapshotId.endsWith(good.operationId!)).toBe(true);
    expect(result.message).toMatch(
      /^Restored the envctl files saved when apply-[0-9a-f]{12} started \(snapshot [^)]+\): the manifest it applied, with lock\.json and state\.json from before it ran; the files it replaced are saved as snapshot /
    );
    expect(result.message).toMatch(/skipped apply-[0-9a-f]{12}, which failed and had already undone its own changes/);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(goodManifest);
  });

  it('does not bring back a restart-required that mark-restarted cleared after the snapshot was taken', async () => {
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa')));
    await applyEnvironment(paths, options);
    const status = () => JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')).profiles.web.plugins;
    expect(status().aa.status).toBe('restart-required');
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa'), plugin('bb')));
    await applyEnvironment(paths, options);
    await markRestarted(paths);
    expect(status().aa.status).toBe('healthy');

    await rollbackEnvironment(paths);
    expect(status().aa.status).toBe('healthy');
  });

  it('saves the active overlay in the snapshot and restores it on rollback', async () => {
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa')));
    const goodOverlay = overlay(plugin('bb'));
    fs.writeFileSync(overlayFile(), goodOverlay);
    const withOverlay: ApplyOptions = { ...options, overlay: { name: 'laptop', via: 'flag' } };
    await applyEnvironment(paths, withOverlay);

    fs.writeFileSync(overlayFile(), overlay(plugin('bb'), plugin('cc')));
    process.env.FAIL_ON = 'cc';
    await expect(applyEnvironment(paths, withOverlay)).rejects.toThrow(/install cc/);

    await rollbackEnvironment(paths);
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(goodOverlay);
  });

  it('keeps the overlay a rollback overwrites in its own snapshot, so rolling back again brings it back', async () => {
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa')));
    fs.writeFileSync(overlayFile(), overlay(plugin('bb')));
    const withOverlay: ApplyOptions = { ...options, overlay: { name: 'laptop', via: 'flag' } };
    const good = await applyEnvironment(paths, withOverlay);
    // Edited after the apply, like `dshenv install ... --layer overlay`.
    const edited = overlay(plugin('bb'), plugin('dd'));
    fs.writeFileSync(overlayFile(), edited);

    const result = await rollbackEnvironment(paths, { operationId: good.operationId });
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(overlay(plugin('bb')));
    await rollbackEnvironment(paths, { operationId: result.backupSnapshotId });
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(edited);
  });
});
