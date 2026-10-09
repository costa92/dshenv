import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

const PATCH_FILE = `# Your patch layer for this dsh profile
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: skill-filesystem
  config:
    customSkillDirs:
      - /home/me/skills
`;

describe('CLI pull', () => {
  let tempHome: string;
  const patchFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const manifest = () => loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
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
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-pull-'));
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
    fs.writeFileSync(patchFile(), PATCH_FILE);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('suggests the profile a mistyped -p was meant to be', async () => {
    expect((await run(['init'])).code).toBe(0);
    const out = await run(['pull', '-p', 'wbe']);
    expect(out.code).toBe(3);
    expect(out.stderr).toContain("did you mean 'web'?");
  });

  it('reports DSH entries in plan, pulls them, and leaves plan clean', async () => {
    expect((await run(['init'])).code).toBe(0);
    const plan = await run(['plan']);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('? [web] locale, skill-filesystem');

    const preview = await run(['pull', '--dry-run']);
    expect(preview.code).toBe(2);
    expect(preview.stdout).toContain('[web] from DSH: + locale, + skill-filesystem');
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(PATCH_FILE);

    const unconfirmed = await run(['pull']);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stdout).toContain('[web] from DSH: + locale, + skill-filesystem');
    expect(unconfirmed.stdout).not.toContain('Next: dshenv plan');
    expect(unconfirmed.stderr).toContain('Nothing was changed. Re-run with --yes to pull.');
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(PATCH_FILE);

    const pulled = await run(['pull', '--yes']);
    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toContain("(base 1, overlay 'local' 1)");
    expect(pulled.stdout).toContain("overlay 'local', now selected");
    expect(manifest().profiles.web.patches?.map((entry) => entry.id)).toEqual(['locale']);

    const after = await run(['plan']);
    expect(after.code).toBe(0);
    expect(after.stderr).toContain('overlay: local (file)');
    expect(after.stdout).not.toMatch(/Planned operations|Patch entries not in the manifest/);
    expect((await run(['pull'])).stdout).toContain('Nothing to pull');
  });

  it('takes a plugin plan reports as unmanaged, a local link into the overlay', async () => {
    const profileDir = path.join(tempHome, 'profiles', 'web');
    const source = path.join(tempHome, 'src', 'dsh-im-hellotalk');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'dsh-im-hellotalk', version: '0.1.0', dsh: { bundle: {} } }));
    fs.mkdirSync(path.join(profileDir, 'node_modules'));
    fs.symlinkSync(source, path.join(profileDir, 'node_modules', 'dsh-im-hellotalk'), 'junction');
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'dsh-im-hellotalk': `link:${source}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-im-hellotalk'] } } })
    );
    fs.writeFileSync(patchFile(), '[]\n');
    await run(['init']);

    expect((await run(['plan'])).stdout).toContain("Unmanaged plugins (not in manifest; run 'dshenv pull --yes' to manage them):\n  ? [web] dsh-im-hellotalk");
    const refused = await run(['pull', '--no-overlay']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/Plugin 'dsh-im-hellotalk' of profile 'web' has a machine-local path/);

    const preview = await run(['pull', '--dry-run']);
    expect(preview.code).toBe(2);
    expect(preview.stdout).toContain("[web] from DSH: + plugin im-hellotalk (overlay 'local')");
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'overlays', 'local.yaml'))).toBe(false);

    const pulled = await run(['pull', '--json', '--yes']);
    expect(pulled.code).toBe(0);
    expect(JSON.parse(pulled.stdout).plugins).toEqual([
      { profile: 'web', alias: 'im-hellotalk', package: 'dsh-im-hellotalk', sourceType: 'local-link', enabled: true, layer: 'overlay', overlayName: 'local' }
    ]);
    const after = await run(['plan']);
    expect(after.code).toBe(0);
    expect(after.stdout).not.toMatch(/Planned operations|Unmanaged plugins/);
  });

  it('exits 6 under --prefer skip when a conflict was left, and lists it in --json', async () => {
    expect((await run(['init'])).code).toBe(0);
    expect((await run(['pull', '--yes'])).code).toBe(0);
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace('preference: zh', 'preference: fr'));
    fs.writeFileSync(patchFile(), fs.readFileSync(patchFile(), 'utf8').replace('preference: zh', 'preference: en'));

    const out = await run(['pull', '--prefer', 'skip', '--yes']);
    expect(out.code).toBe(6);
    expect(out.stdout).toContain("! Patch entries of profile 'web' changed both in DSH and in the manifest since the last apply; skipped");
    const json = await run(['pull', '--prefer', 'skip', '--json']);
    expect(json.code).toBe(6);
    expect(JSON.parse(json.stdout).skipped).toEqual({ patchTargets: ['web'], skills: [] });
  });

  it('rejects an unknown --prefer and machine-local entries under --no-overlay', async () => {
    await run(['init']);
    expect((await run(['pull', '--prefer', 'both'])).code).toBe(3);
    const refused = await run(['pull', '--no-overlay']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/machine-local paths/);
  });

  it('says what adopt already recorded when taking over the patch entries then fails', async () => {
    await run(['capture', '--output', path.join(tempHome, 'capture.yaml')]);
    const adopted = await run(['adopt', '--from', path.join(tempHome, 'capture.yaml'), '--no-overlay', '--yes']);
    expect(adopted.code).toBe(3);
    expect(adopted.stderr).toMatch(/^Adopted 1 plugin\(s\) across profile\(s\): web, but taking over their patch entries failed: .*machine-local paths.*; fix that and run dshenv pull --yes/m);
    // The adoption itself stands: running adopt again is not needed, only the pull.
    expect(Object.keys(manifest().profiles.web.plugins)).toHaveLength(1);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'state.json'))).toBe(true);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(PATCH_FILE);
    expect((await run(['pull', '--yes'])).code).toBe(0);
  });

  it('takes the patch entries over when adopting a profile', async () => {
    const captured = await run(['capture', '--output', path.join(tempHome, 'capture.yaml')]);
    expect(captured.code).toBe(0);
    expect(fs.readFileSync(path.join(tempHome, 'capture.yaml'), 'utf8')).toContain('2 patch entries outside the manifest');

    const adopted = await run(['adopt', '--from', path.join(tempHome, 'capture.yaml'), '--yes']);
    expect(adopted.code).toBe(0);
    expect(adopted.stdout).toContain('[web] from DSH: + locale, + skill-filesystem');
    expect(manifest().profiles.web.patches?.map((entry) => entry.id)).toEqual(['locale']);
    expect((await run(['plan'])).stdout).toContain('No changes planned');
  });
});
