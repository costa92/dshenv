import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

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
});
