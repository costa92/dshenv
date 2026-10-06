import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as os from 'node:os';
import { execa } from 'execa';
import { runCli } from '../../src/cli.js';
import { loadLock, loadManifest, parseOverlay } from '../../src/manifest/files.js';
import { writeOverlayFixture } from '../helpers/overlay-fixture.js';

describe('CLI writes with an active overlay', () => {
  let tempHome: string;
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
  const overlayFile = () => path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml');
  const overlay = () => parseOverlay(fs.readFileSync(overlayFile(), 'utf8'), overlayFile());
  const run = async (args: string[]) => {
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    return { code, stderr };
  };
  const runOut = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-overlay-write-'));
    writeOverlayFixture(tempHome);
    await run(['overlay', 'use', 'laptop']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('refuses writes without --layer and leaves both files unchanged', async () => {
    const before = [fs.readFileSync(manifestFile(), 'utf8'), fs.readFileSync(overlayFile(), 'utf8')];
    const { code, stderr } = await run(['disable', 'shared', '--profile', 'web']);
    expect(code).toBe(3);
    expect(stderr).toMatch(/pass --layer base or --layer overlay/);
    expect([fs.readFileSync(manifestFile(), 'utf8'), fs.readFileSync(overlayFile(), 'utf8')]).toEqual(before);
  });

  it('writes enabled only into the overlay with --layer overlay', async () => {
    const baseBefore = fs.readFileSync(manifestFile(), 'utf8');
    expect((await run(['disable', 'shared', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ enabled: false });
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(baseBefore);
  });

  it('writes the base with --layer base', async () => {
    const overlayBefore = fs.readFileSync(overlayFile(), 'utf8');
    expect((await run(['disable', 'shared', '--profile', 'web', '--layer', 'base'])).code).toBe(0);
    expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.shared.enabled).toBe(false);
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(overlayBefore);
  });

  it('enables a plugin in the overlay', async () => {
    expect((await run(['disable', 'extra', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect((await run(['enable', 'extra', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.extra.enabled).toBe(true);
  });

  it('tombstones base plugins and deletes overlay-only plugins on remove', async () => {
    expect((await run(['remove', 'shared', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ remove: true });
    expect((await run(['remove', 'extra', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.extra).toBeUndefined();
  });

  it('sets one config key in the overlay', async () => {
    expect((await run(['config', 'set', 'shared', 'mode', 'solo', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared.patches).toEqual([{ id: 'shared', config: { mode: 'solo' } }]);
  });

  it('installs new plugins and overrides existing ones in the overlay', async () => {
    expect((await run(['install', 'new-plugin@3.0.0', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.['new-plugin']).toEqual({
      package: 'new-plugin',
      enabled: true,
      source: { type: 'npm', version: '3.0.0' }
    });

    expect((await run(['install', 'shared-plugin@1.5.0', '--profile', 'web', '--as', 'shared', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ source: { type: 'npm', version: '1.5.0' } });

    const clash = await run(['install', 'other-plugin@1.0.0', '--profile', 'web', '--as', 'shared', '--layer', 'overlay']);
    expect(clash.code).toBe(3);
    expect(clash.stderr).toMatch(/cannot change its package/);
  });

  it('overrides the npm version in the overlay and pins the lock', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'lock.json'),
      JSON.stringify({
        apiVersion: 'dshenv-lock/v1',
        profiles: { web: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
      })
    );
    expect((await run(['update', 'shared', '--profile', 'web', '--to', '1.1.0', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ source: { type: 'npm', version: '1.1.0' } });
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    expect(lock.profiles.web.plugins.shared.source).toMatchObject({ resolvedVersion: '1.1.0' });
  });

  it('source clone --profile --layer overlay writes the overlay, not the base, and reports the layer', async () => {
    const upstream = path.join(tempHome, 'upstream', 'demo-plugin');
    fs.mkdirSync(upstream, { recursive: true });
    await execa('git', ['init'], { cwd: upstream });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream });

    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
    const baseBefore = fs.readFileSync(manifestFile(), 'utf8');

    const noLayer = await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo']);
    expect(noLayer.code).toBe(3);
    expect(fs.existsSync(cloneDir)).toBe(false);

    const { code, stdout } = await runOut([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--layer', 'overlay', '--json'
    ]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(cloneDir, 'package.json'))).toBe(true);

    const parsed = JSON.parse(stdout) as { layer: string; overlay: string };
    expect(parsed.layer).toBe('overlay');
    expect(parsed.overlay).toBe('laptop');

    expect(overlay().profiles?.web.plugins?.demo).toEqual({
      package: 'demo-plugin',
      enabled: true,
      source: { type: 'git', url: pathToFileURL(upstream).href }
    });
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(baseBefore);

    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    const gitSource = lock.profiles.web.plugins.demo.source;
    expect(gitSource.type).toBe('git');

    const upstream2 = path.join(tempHome, 'upstream', 'demo-plugin-2');
    fs.mkdirSync(upstream2, { recursive: true });
    await execa('git', ['init'], { cwd: upstream2 });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream2 });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream2 });
    fs.writeFileSync(path.join(upstream2, 'package.json'), JSON.stringify({ name: 'demo-plugin-2', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: upstream2 });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream2 });

    const { code: textCode, stdout: textOut, stderr: textErr } = await runOut([
      'source', 'clone', upstream2, '--profile', 'web', '--as', 'demo2', '--layer', 'overlay'
    ]);
    expect(textCode).toBe(0);
    expect(textErr).toBe('');
    expect(textOut).toMatch(/\(overlay 'laptop'\)/);
  });

  it('rejects --layer overlay without an active overlay and adopt into an overlay', async () => {
    await run(['overlay', 'use', '--none']);
    expect((await run(['disable', 'shared', '--profile', 'web', '--layer', 'overlay'])).code).toBe(3);
    await run(['overlay', 'use', 'laptop']);
    const adopt = await run(['adopt', '--from', path.join(tempHome, 'missing.yaml'), '--layer', 'overlay']);
    expect(adopt.code).toBe(3);
    expect(adopt.stderr).toMatch(/adopt picks the layer itself/);
  });

  it('removes a base plugin the active overlay adjusts, leaving the overlay entry with nothing to do', async () => {
    fs.writeFileSync(overlayFile(), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      heavy:\n        enabled: false\n');
    const overlayBefore = fs.readFileSync(overlayFile(), 'utf8');
    expect((await run(['remove', 'heavy', '--profile', 'web', '--layer', 'base'])).code).toBe(0);
    expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.heavy).toBeUndefined();
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(overlayBefore);
    const listed = await runOut(['--json', 'plugins', 'list', '--profile', 'web']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain('"heavy"');
  });

  it('source clone checks the overlay and --layer before cloning', async () => {
    const upstream = path.join(tempHome, 'upstream', 'demo-plugin');
    fs.mkdirSync(upstream, { recursive: true });
    await execa('git', ['init'], { cwd: upstream });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream });
    const sourcesDir = path.join(tempHome, 'envctl', 'sources');
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'bad.yaml'), 'apiVersion: dshenv-overlay/v1\nbogus: true\n');

    for (const name of ['ghost', 'bad']) {
      const res = await run(['--overlay', name, 'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--layer', 'overlay']);
      expect(res.code).toBe(3);
      expect(fs.existsSync(sourcesDir)).toBe(false);
    }

    const target = path.join(tempHome, 'plain-clone');
    const noProfile = await run(['source', 'clone', upstream, target, '--layer', 'overlay']);
    expect(noProfile.code).toBe(3);
    expect(noProfile.stderr).toContain('--layer requires --profile for source clone');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('leaves a plugin the overlay declares to the overlay, and adopts another package under a free alias', async () => {
    const profileDir = path.join(tempHome, 'profiles', 'web');
    for (const [name, version] of [['extra-plugin', '2.0.0'], ['other-plugin', '1.0.0']]) {
      fs.mkdirSync(path.join(profileDir, 'node_modules', name), { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: {} } }));
    }
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { 'shared-plugin': '1.0.0', 'heavy-plugin': '1.0.0', 'extra-plugin': '2.0.0', 'other-plugin': '1.0.0' },
        dsh: { profile: { bundles: ['shared-plugin', 'heavy-plugin', 'extra-plugin', 'other-plugin'] } }
      })
    );
    const candidateFor = (pkg: string, version: string) => {
      const file = path.join(tempHome, `candidate-${pkg}.yaml`);
      fs.writeFileSync(
        file,
        `apiVersion: dshenv-capture/v1
manifest:
  apiVersion: dshenv/v1
  profiles:
    web:
      plugins:
        extra:
          package: ${pkg}
          enabled: true
          source: { type: npm, version: "${version}" }
lock:
  apiVersion: dshenv-lock/v1
  profiles:
    web:
      plugins:
        extra:
          package: ${pkg}
          source: { type: npm, resolvedVersion: "${version}" }
warnings: []
`
      );
      return file;
    };
    const before = fs.readFileSync(manifestFile(), 'utf8');

    // The overlay already declares extra-plugin as `extra`, so there is nothing for the base to take.
    const same = await runOut(['adopt', '--from', candidateFor('extra-plugin', '2.0.0'), '--layer', 'base']);
    expect(same.code).toBe(0);
    expect(same.stdout).toBe('Nothing to adopt: every plugin in the candidate is already adopted.\n');
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);

    // A different package goes under another alias than the one the overlay uses, which would have the overlay change its package.
    expect(await run(['adopt', '--from', candidateFor('other-plugin', '1.0.0'), '--layer', 'base', '--yes'])).toEqual({ code: 0, stderr: '' });
    expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins['extra-1'].package).toBe('other-plugin');
  });

  it('source clone --layer base checks the overlay merge and --profile before cloning', async () => {
    const upstream = path.join(tempHome, 'upstream', 'extra-plugin');
    fs.mkdirSync(upstream, { recursive: true });
    await execa('git', ['init'], { cwd: upstream });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'extra-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream });

    const before = fs.readFileSync(manifestFile(), 'utf8');
    const clash = await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'extra', '--layer', 'base']);
    expect(clash.code).toBe(3);
    expect(clash.stderr).toMatch(/cannot change package/);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources'))).toBe(false);
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);

    const target = path.join(tempHome, 'plain-clone');
    const noProfile = await run(['source', 'clone', upstream, target, '--layer', 'base']);
    expect(noProfile.code).toBe(3);
    expect(noProfile.stderr).toContain('--layer requires --profile for source clone');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses an overlay write of ${...}, as a base write is refused, and leaves the overlay loadable', async () => {
    const overlayBefore = fs.readFileSync(overlayFile(), 'utf8');
    const set = await run(['config', 'set', 'shared', 'greeting', 'hi ${USER}', '--profile', 'web', '--layer', 'overlay']);
    expect(set.code).toBe(3);
    expect(set.stderr).toMatch(/interpolations \$\{\.\.\.\} are not allowed/);
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(overlayBefore);
    expect((await run(['plugins', 'list', '--profile', 'web'])).code).toBe(0);
  });

  it('update and config set --layer base change a base plugin the overlay removes', async () => {
    expect((await run(['update', 'heavy', '--profile', 'web', '--to', '1.1.0', '--layer', 'base', '--no-npm-check'])).code).toBe(0);
    expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.heavy.source).toEqual({ type: 'npm', version: '1.1.0' });
    const set = await run(['config', 'set', 'heavy', 'mode', 'x', '--profile', 'web', '--layer', 'base']);
    expect(set.code).toBe(0);
    // The test DSH cannot dump the profile, so the patch holds only this key, and says so.
    expect(set.stderr).toMatch(/^Could not read the config DSH composes for heavy-plugin in profile 'web'/);
    expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.heavy.patches).toEqual([{ id: 'heavy', config: { mode: 'x' } }]);
  });

  it('update --layer base checks the base source, not the one the overlay sets', async () => {
    fs.writeFileSync(overlayFile(), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      shared:\n        source: { type: local-link, path: /tmp/shared }\n');
    expect((await run(['update', 'shared', '--profile', 'web', '--to', '1.1.0', '--layer', 'base', '--no-npm-check'])).code).toBe(0);
    expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.shared.source).toEqual({ type: 'npm', version: '1.1.0' });
  });

  it('install --layer overlay declares the package when the overlay only adjusts a plugin the base no longer has', async () => {
    fs.writeFileSync(overlayFile(), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      gone:\n        enabled: false\n');
    expect((await run(['install', 'gone-plugin@1.2.0', '--as', 'gone', '--profile', 'web', '--layer', 'overlay', '--no-npm-check'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.gone).toEqual({ package: 'gone-plugin', enabled: true, source: { type: 'npm', version: '1.2.0' } });
    const listed = await runOut(['--json', 'plugins', 'list', '--profile', 'web']);
    expect(listed.stdout).toContain('"gone"');
  });

  describe('with --no-overlay, against the overlay saved as selected', () => {
    it('refuses a base write that overlay could not merge onto', async () => {
      const before = fs.readFileSync(manifestFile(), 'utf8');
      const out = await run(['--no-overlay', 'install', 'other-plugin@1.0.0', '--as', 'extra', '--profile', 'web']);
      expect(out.code).toBe(3);
      expect(out.stderr).toContain("an overlay cannot change package");
      expect(out.stderr).toContain("overlay 'laptop' is selected on this machine");
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
    });

    it('refuses a pull that would declare in the base a package that overlay declares', async () => {
      const profileDir = path.join(tempHome, 'profiles', 'web');
      fs.mkdirSync(path.join(profileDir, 'node_modules', 'extra-plugin'), { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'node_modules', 'extra-plugin', 'package.json'), JSON.stringify({ name: 'extra-plugin', version: '2.0.0', dsh: { bundle: {} } }));
      const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
      pkg.dependencies['extra-plugin'] = '2.0.0';
      pkg.dsh.profile.bundles.push('extra-plugin');
      fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg));
      const before = fs.readFileSync(manifestFile(), 'utf8');
      const out = await run(['--no-overlay', 'pull', '--yes']);
      expect(out.code).toBe(3);
      expect(out.stderr).toContain("overlay 'laptop' is selected on this machine");
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
    });
  });

  it('warns when the overlay keeps a base install from taking effect', async () => {
    const removed = await run(['install', 'heavy-plugin@2.0.0', '--as', 'heavy', '--profile', 'web', '--layer', 'base', '--no-npm-check']);
    expect(removed.code).toBe(0);
    expect(removed.stderr).toBe("Overlay 'laptop' sets remove: true for heavy in profile 'web', so it stays uninstalled on this machine; use --layer overlay to change it here\n");
    fs.writeFileSync(overlayFile(), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      shared:\n        source: { type: npm, version: "1.9.0" }\n');
    const pinned = await run(['install', 'shared-plugin@2.0.0', '--as', 'shared', '--profile', 'web', '--layer', 'base', '--no-npm-check']);
    expect(pinned.stderr).toBe("Overlay 'laptop' sets the source of shared in profile 'web', so it stays at 1.9.0 on this machine; use --layer overlay to change it here\n");
  });

  it('warns when the overlay removes a plugin a base enable or disable changes', async () => {
    for (const verb of ['disable', 'enable']) {
      const out = await run([verb, 'heavy', '--profile', 'web', '--layer', 'base']);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("Overlay 'laptop' sets remove: true for heavy in profile 'web', so it stays uninstalled on this machine; use --layer overlay to change it here\n");
    }
  });
});
