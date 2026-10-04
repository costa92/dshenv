import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { calculateSourceDigest } from '../../src/source/local.js';
import { loadManifest } from '../../src/manifest/files.js';

describe('CLI adopt', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-adopt-'));
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams'), { recursive: true });

    fs.writeFileSync(
      path.join(webProfile, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@nanmicoder/dsh-agent-teams': '^0.1.21'
        },
        dsh: {
          profile: {
            bundles: ['@nanmicoder/dsh-agent-teams']
          }
        }
      })
    );

    fs.writeFileSync(
      path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'),
      JSON.stringify({
        name: '@nanmicoder/dsh-agent-teams',
        version: '0.1.21',
        _resolved: 'https://registry.npmjs.org/@nanmicoder/dsh-agent-teams/-/dsh-agent-teams-0.1.21.tgz'
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should adopt candidate manifest via CLI adopt --from <file>', async () => {
    const candidatePath = path.join(tempHome, 'candidate.yaml');
    fs.writeFileSync(
      candidatePath,
      `apiVersion: dshenv-capture/v1
manifest:
  apiVersion: dshenv/v1
  profiles:
    web:
      plugins:
        agent-teams:
          package: "@nanmicoder/dsh-agent-teams"
          enabled: true
          source:
            type: npm
            version: "0.1.21"
lock:
  apiVersion: dshenv-lock/v1
  profiles:
    web:
      plugins:
        agent-teams:
          package: "@nanmicoder/dsh-agent-teams"
          source:
            type: npm
            resolvedVersion: "0.1.21"
warnings: []
`
    );

    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['adopt', '--from', candidatePath, '--dsh-home', tempHome, '--yes'], io);
    expect(code).toBe(0);
    expect(stdout).toContain('Adopted');
    expect(stdout).toContain('@nanmicoder/dsh-agent-teams');

    stdout = '';
    expect(await runCli(['adopt', '--from', candidatePath, '--dsh-home', tempHome, '--yes'], io)).toBe(0);
    expect(stdout).toContain('Nothing to adopt: every plugin in the candidate is already adopted.');
    expect(stdout).not.toContain('Adopted');
  });

  describe('with a plugin linked from a local checkout', () => {
    let source: string;
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } });
      return { code, stdout, stderr };
    };
    const envctl = (...parts: string[]) => path.join(tempHome, 'envctl', ...parts);

    beforeEach(async () => {
      source = path.join(tempHome, 'src', 'local-tool');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'local-tool', version: '1.0.0', dsh: { bundle: {} } }));
      fs.writeFileSync(path.join(source, 'index.js'), 'export default {};\n');
      const webProfile = path.join(tempHome, 'profiles', 'web');
      fs.symlinkSync(source, path.join(webProfile, 'node_modules', 'local-tool'), 'junction');
      const pkg = JSON.parse(fs.readFileSync(path.join(webProfile, 'package.json'), 'utf8'));
      pkg.dependencies['local-tool'] = `link:${source}`;
      pkg.dsh.profile.bundles.push('local-tool');
      fs.writeFileSync(path.join(webProfile, 'package.json'), JSON.stringify(pkg));
      expect((await run(['init'])).code).toBe(0);
      expect((await run(['capture', '-o', path.join(tempHome, 'candidate.yaml')])).code).toBe(0);
    });

    it('puts it into the local overlay with its digest, as pull does, so plan is clean', async () => {
      const preview = await run(['adopt', path.join(tempHome, 'candidate.yaml')]);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toMatch(/local-tool \(local-tool\) \[local-link\] into an overlay/);

      const out = await run(['adopt', path.join(tempHome, 'candidate.yaml'), '--yes']);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/\+ plugin local-tool \(overlay 'local'\)/);
      expect(out.stdout).toContain("went into overlay 'local', now selected");
      expect(out.stdout.match(/Next: dshenv plan/g)).toHaveLength(1);
      expect(fs.readFileSync(envctl('manifest.yaml'), 'utf8')).not.toContain('local-tool');
      expect(fs.readFileSync(envctl('overlays', 'local.yaml'), 'utf8')).toContain(source);
      const lock = JSON.parse(fs.readFileSync(envctl('lock.json'), 'utf8'));
      expect(lock.profiles.web.plugins['local-tool'].source.digest).toMatch(/^[0-9a-f]{64}$/);
      const state = JSON.parse(fs.readFileSync(envctl('state.json'), 'utf8'));
      expect(Object.keys(state.resources.plugin.web).sort()).toEqual(['@nanmicoder/dsh-agent-teams', 'local-tool']);

      const plan = await run(['plan']);
      expect(plan.stdout).not.toMatch(/local-tool/);
      expect(plan.code).toBe(0);
    });

    it('keeps the base entry of a plugin linked here and records the link in the local overlay', async () => {
      fs.writeFileSync(
        envctl('manifest.yaml'),
        'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      tool:\n        package: local-tool\n        source: { type: npm, version: "1.0.0" }\n'
      );
      const preview = await run(['adopt', path.join(tempHome, 'candidate.yaml')]);
      expect(preview.stdout).toMatch(/local-tool \(tool\) \[local-link\] into an overlay/);

      const out = await run(['adopt', path.join(tempHome, 'candidate.yaml'), '--yes']);
      expect(out.code).toBe(0);
      expect(fs.readFileSync(envctl('manifest.yaml'), 'utf8')).not.toContain(source);
      expect(loadManifest(fs.readFileSync(envctl('manifest.yaml'), 'utf8')).profiles.web.plugins.tool.source).toEqual({ type: 'npm', version: '1.0.0' });
      expect(fs.readFileSync(envctl('overlays', 'local.yaml'), 'utf8')).toContain(source);
      const lock = JSON.parse(fs.readFileSync(envctl('lock.json'), 'utf8'));
      expect(lock.profiles.web.plugins.tool.source).toEqual({ type: 'local-link', path: source, digest: await calculateSourceDigest(source) });
      const plan = await run(['plan']);
      expect(plan.stdout).not.toMatch(/tool/);
      expect(plan.code).toBe(0);
    });

    it('keeps the lock digest of a local plugin the base already declares as it is installed', async () => {
      fs.writeFileSync(
        envctl('manifest.yaml'),
        `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      local-tool:\n        package: local-tool\n        source: { type: local-link, path: ${JSON.stringify(source)} }\n`
      );
      expect((await run(['adopt', path.join(tempHome, 'candidate.yaml'), '--yes'])).code).toBe(0);
      const lockFile = envctl('lock.json');
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      lock.profiles.web.plugins['local-tool'].source.digest = await calculateSourceDigest(source);
      fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
      const again = await run(['adopt', path.join(tempHome, 'candidate.yaml'), '--yes']);
      expect(again.stdout).toContain('Nothing to adopt: every plugin in the candidate is already adopted.');
      expect(JSON.parse(fs.readFileSync(lockFile, 'utf8'))).toEqual(lock);
      expect((await run(['plan'])).code).toBe(0);
    });

    it('refuses under --no-overlay before writing anything', async () => {
      const before = fs.readFileSync(envctl('manifest.yaml'), 'utf8');
      const out = await run(['--no-overlay', 'adopt', path.join(tempHome, 'candidate.yaml'), '--yes']);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/machine-local path.*overlay/);
      expect(fs.readFileSync(envctl('manifest.yaml'), 'utf8')).toBe(before);
      expect(fs.existsSync(envctl('overlays', 'local.yaml'))).toBe(false);
    });
  });

  it('leaves a plugin the active overlay already declares where it is, in the preview and with --yes', async () => {
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], {
        stdout: (chunk) => { stdout += chunk; },
        stderr: (chunk) => { stderr += chunk; }
      });
      return { code, stdout, stderr };
    };
    await run(['init']);
    await run(['overlay', 'create', 'local']);
    await run(['overlay', 'use', 'local']);
    expect((await run(['install', '@nanmicoder/dsh-agent-teams@0.1.21', '-p', 'web', '--layer', 'overlay', '--no-npm-check'])).code).toBe(0);
    const candidate = path.join(tempHome, 'capture.yaml');
    expect((await run(['capture', '-o', candidate])).code).toBe(0);
    const base = fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');

    // adopt only writes the base, so an active overlay needs no --layer.
    const preview = await run(['adopt', candidate]);
    expect(preview.stderr).toBe('');
    expect(preview.stdout).toBe('Nothing to adopt: every plugin in the candidate is already adopted.\n');
    expect(preview.code).toBe(0);

    expect((await run(['adopt', candidate, '--yes'])).code).toBe(0);
    expect((await run(['adopt', candidate, '--layer', 'base'])).code).toBe(0);
    expect(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).toBe(base);
  });

  describe('with an alias the active overlay adds for another package', () => {
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } });
      return { code, stdout, stderr };
    };
    const baseAliases = () =>
      Object.keys(loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web?.plugins ?? {});

    beforeEach(async () => {
      expect((await run(['init'])).code).toBe(0);
      expect((await run(['capture', '-o', path.join(tempHome, 'candidate.yaml')])).code).toBe(0);
      fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, 'envctl', 'overlays', 'mine.yaml'),
        'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams:\n        package: other-teams\n        source: { type: npm, version: "1.0.0" }\n'
      );
      expect((await run(['overlay', 'use', 'mine'])).code).toBe(0);
    });

    it('adopt puts the plugin under a free alias', async () => {
      const out = await run(['adopt', path.join(tempHome, 'candidate.yaml'), '--yes']);
      expect(out.stderr).toBe('');
      expect(out.code).toBe(0);
      expect(baseAliases()).toEqual(['agent-teams-1']);
    });

    it('pull puts the plugin under a free alias', async () => {
      const out = await run(['pull', '--yes']);
      expect(out.stderr).toBe('');
      expect(out.code).toBe(0);
      expect(baseAliases()).toEqual(['agent-teams-1']);
    });
  });
});
