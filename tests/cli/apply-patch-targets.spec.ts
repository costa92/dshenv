import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

// A fake dsh whose rows are hmr, locale and skill-filesystem: like DSH's include, it names every patch entry of the
// profile and global files that targets another id. Hot reload is off.
const FAKE_DSH = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
if (!args.includes('--dump-config')) process.exit(1);
const home = process.env.DSH_HOME;
const profile = args[args.indexOf('--profile') + 1];
const rows = new Set(['hmr', 'locale', 'skill-filesystem', ...(profile === 'acp' ? ['client-hmr'] : [])]);
const files = [path.join(home, 'profiles', profile, 'cordis.patch.yml'), path.join(home, 'cordis.patch.yml')];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/^- id: (\\S+)$/gm)) {
    if (!rows.has(match[1])) process.stderr.write('dsh: [' + file + '] patch: entry ' + JSON.stringify(match[1]) + ' not found\\n');
  }
}
if (process.env.FAKE_DSH_SKIP_BUNDLE) process.stderr.write('dsh: skipping profile bundle "@acme/broken": Error: Cannot find module\\n');
fs.writeFileSync(path.join(home, 'profiles', profile, 'cordis.yml'), '[]\\n');
process.stdout.write('- id: hmr\\n  disabled: true\\n');
`;

describe('CLI apply checks patch ids against DSH', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;
  const patchFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const homePatchFile = () => path.join(tempHome, 'cordis.patch.yml');
  const writeManifest = (body: string) => fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), `apiVersion: dshenv/v1\n${body}`);

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-patch-targets-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
    // An entry DSH already skips today, which is no reason to stop an apply.
    fs.writeFileSync(patchFile(), '- id: legacy\n  config: {}\n');
    const fakeDsh = path.join(tempHome, 'fake-dsh.cjs');
    fs.writeFileSync(fakeDsh, FAKE_DSH);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    delete process.env.FAKE_DSH_SKIP_BUNDLE;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('lists in the preview every id DSH would skip, marking the ones this apply adds, and leaves DSH_HOME untouched', async () => {
    writeManifest('profiles:\n  web:\n    patches:\n      - id: locale\n        config: { preference: zh }\n      - id: time-context\n        config: {}\n');
    const before = fs.readFileSync(patchFile(), 'utf8');

    const out = await run(['apply']);
    expect(out.code).toBe(2);
    expect(out.stdout).toContain('Patch entries DSH would skip, as no row has their id:\n');
    expect(out.stdout).toContain('  ! [web] legacy (its cordis.patch.yml)\n');
    expect(out.stdout).toContain('  ! [web] time-context (its cordis.patch.yml) (new: apply --yes stops on it)\n');
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8')).toContain('bundles');

    const json = JSON.parse((await run(['apply', '--json'])).stdout);
    expect(json.patchTargets.added).toEqual([{ profile: 'web', layer: 'profile', id: 'time-context' }]);
  });

  it('stops apply --yes before writing anything when an id it adds matches no row', async () => {
    writeManifest('profiles:\n  web:\n    patches:\n      - id: time-context\n        config: {}\n');
    const before = fs.readFileSync(patchFile(), 'utf8');

    const out = await run(['apply', '--yes']);
    expect(out.code).toBe(3);
    expect(out.stderr).toContain('Apply stopped before changing anything: DSH would skip these patch entries, as no row has their id: [web] time-context (its cordis.patch.yml)');
    expect(out.stderr).not.toContain('legacy');
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'backups'))).toBe(false);
  });

  it('applies when only ids DSH already skipped stay unmatched', async () => {
    writeManifest('profiles:\n  web:\n    patches:\n      - id: locale\n        config: { preference: zh }\n');
    const out = await run(['apply', '--yes']);
    expect(out.code).toBe(0);
    expect(fs.readFileSync(patchFile(), 'utf8')).toContain('preference: zh');
  });

  it('checks global entries against every profile, and names the profiles whose hot reload is off as needing a restart', async () => {
    writeManifest('profiles: {}\npatches:\n  - id: nosuch\n    config: {}\n');
    const preview = await run(['apply']);
    expect(preview.stdout).toContain('  ! [web] nosuch (the global cordis.patch.yml) (new: apply --yes stops on it)\n');
    expect(fs.existsSync(homePatchFile())).toBe(false);
    expect((await run(['apply', '--yes'])).code).toBe(3);

    writeManifest('profiles: {}\npatches:\n  - id: locale\n    config: { preference: en }\n');
    const out = await run(['apply', '--yes']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Restart DSH to load:\n  [web] configure global patches (hot reload is off for profile web)\n');
  });

  it('reports in status and doctor the bundles DSH skips, which plan counts as in sync', async () => {
    writeManifest('profiles: {}\n');
    process.env.FAKE_DSH_SKIP_BUNDLE = '1';
    const status = await run(['status']);
    expect(status.code).toBe(5);
    expect(status.stdout).toContain('Environment Status: degraded');
    expect(status.stdout).toContain('Bundles DSH skips when it loads the profile:\n  ! [web] @acme/broken: Error: Cannot find module\n');
    expect(JSON.parse((await run(['status', '--json'])).stdout).skippedBundles).toEqual([
      { profile: 'web', package: '@acme/broken', reason: 'Error: Cannot find module' }
    ]);

    const doctor = await run(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('Profile bundles:\n  ! [web] @acme/broken is skipped: Error: Cannot find module\n');

    delete process.env.FAKE_DSH_SKIP_BUNDLE;
    expect((await run(['status'])).stdout).not.toContain('Bundles DSH skips');
  });

  const addProfile = (name: string) => {
    fs.mkdirSync(path.join(tempHome, 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', name, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  };

  it('does not judge a profile whose plugins this apply changes, since their rows are not there yet', async () => {
    writeManifest(
      'profiles:\n  web:\n    plugins:\n      teams: { package: "@acme/teams", source: { type: npm, version: "1.0.0" } }\n' +
        '    patches:\n      - id: teams-row\n        config: {}\n'
    );
    const out = await run(['apply']);
    expect(out.stdout).not.toContain('teams-row');
    expect(out.stdout).toContain('Patch ids not checked: web: its plugins change in this apply, so DSH cannot show its rows yet');
  });

  it('lets a global entry through when some profile has its row, and stops only when none has', async () => {
    addProfile('acp');
    writeManifest('profiles: {}\npatches:\n  - id: client-hmr\n    disabled: true\n');
    const preview = await run(['apply']);
    expect(preview.stdout).toContain('  ! [web] client-hmr (the global cordis.patch.yml)\n');
    expect(preview.stdout).not.toContain('(new: apply --yes stops on it)');
    expect((await run(['apply', '--yes'])).code).toBe(0);
  });

  it('lets an id DSH already skips move from the profile file to the global one', async () => {
    writeManifest('profiles: {}\npatches:\n  - id: legacy\n    config: {}\n');
    const preview = await run(['apply']);
    expect(preview.stdout).toContain('  ! [web] legacy (the global cordis.patch.yml)\n');
    expect(preview.stdout).not.toContain('(new: apply --yes stops on it)');
  });

  it('ignores a dangling link in DSH_HOME instead of failing', async () => {
    fs.symlinkSync(path.join(tempHome, 'nowhere'), path.join(tempHome, 'stale-link'));
    writeManifest('profiles:\n  web:\n    patches:\n      - id: time-context\n        config: {}\n');
    const out = await run(['apply']);
    expect(out.code).toBe(2);
    expect(out.stdout).toContain('time-context (its cordis.patch.yml) (new: apply --yes stops on it)');
  });
});
