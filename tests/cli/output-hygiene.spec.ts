import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { unsupportedDshVersionMessage } from '../../src/dsh/version.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI output hygiene', () => {
  let tempHome: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY'];

  const run = async (args: string[], home = true) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(home ? [...args, '--dsh-home', tempHome] : args, {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };
  const useOverlay = (name: string) => {
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', `${name}.yaml`), 'apiVersion: dshenv-overlay/v1\n');
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlay-selection.json'),
      JSON.stringify({ apiVersion: 'dshenv-overlay-selection/v1', overlay: name })
    );
  };

  beforeEach(async () => {
    for (const name of ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-hygiene-'));
    await run(['init']);
  });

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('shows control characters from names as escapes, so they cannot rewrite the terminal', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      "ev\\e[8mil\\u202e":\n        package: dsh-plugin-demo\n        source: { type: npm, version: "1.0.0" }\n'
    );
    const list = await run(['plugins', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).not.toMatch(/[\u001b\u202e]/);
    expect(list.stdout).toContain('ev\\u001b[8mil\\u202e');

    const typo = await run(['enable', 'ev', '-p', 'web']);
    expect(typo.code).toBe(3);
    expect(typo.stderr).not.toMatch(/[\u001b\u202e]/);
    expect(typo.stderr).toContain('ev\\u001b[8mil\\u202e');
  });

  describe('help without a command', () => {
    it('prints help to stdout and exits 0 for dshenv --json and for a command group run bare', async () => {
      for (const args of [['--json'], ['config'], ['config', '--json'], ['tools', '--json']]) {
        const out = await run(args, false);
        expect(out.code, args.join(' ')).toBe(0);
        expect(out.stdout, args.join(' ')).toMatch(/^Usage: dshenv/);
        expect(out.stderr, args.join(' ')).toBe('');
      }
    });

    it('still reports a real usage error as JSON', async () => {
      const out = await run(['config', 'get', '--json'], false);
      expect(out.code).toBe(3);
      expect(JSON.parse(out.stderr).error.message).toMatch(/missing required argument/);
      expect(out.stderr).not.toContain('outputHelp');
    });
  });

  describe('adopt preview', () => {
    const headlessWithPlugin = () => {
      const profile = path.join(tempHome, 'profiles', 'headless');
      fs.mkdirSync(path.join(profile, 'node_modules', 'dsh-plugin-other'), { recursive: true });
      fs.writeFileSync(
        path.join(profile, 'package.json'),
        JSON.stringify({ name: 'dsh-profile-headless', private: true, dependencies: { 'dsh-plugin-other': '1.0.0' }, dsh: { profile: { bundles: ['dsh-plugin-other'] } } })
      );
      fs.writeFileSync(path.join(profile, 'node_modules', 'dsh-plugin-other', 'package.json'), JSON.stringify({ name: 'dsh-plugin-other', version: '1.0.0' }));
    };

    it('says there is nothing to adopt, exit 0, once everything in the candidate is adopted', async () => {
      headlessWithPlugin();
      const candidate = path.join(tempHome, 'capture.yaml');
      await run(['capture', '-p', 'headless', '-o', candidate]);
      expect((await run(['adopt', '-f', candidate, '--yes'])).code).toBe(0);
      await run(['capture', '-p', 'headless', '-o', candidate]);

      const again = await run(['adopt', '-f', candidate]);
      expect(again.code).toBe(0);
      expect(again.stdout).toBe('Nothing to adopt: every plugin in the candidate is already adopted.\n');
      expect(again.stderr).toBe('');
    });

    it('says the candidate declares no plugins without a dangling profile list', async () => {
      const candidate = path.join(tempHome, 'empty.yaml');
      await run(['capture', '-o', candidate]);
      const out = await run(['adopt', '-f', candidate]);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('Nothing to adopt: the candidate declares no plugins.\n');
    });
  });

  describe('next steps', () => {
    beforeEach(async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    });

    it('ends plan with the next step on stderr when something is pending', async () => {
      const plan = await run(['plan']);
      expect(plan.code).toBe(2);
      expect(plan.stderr).toBe('Next: dshenv apply --yes\n');
      expect((await run(['plan', '--json'])).stderr).toBe('');
    });

    it('ends apply --dry-run with how to apply for real', async () => {
      const dry = await run(['apply', '--dry-run']);
      expect(dry.code).toBe(2);
      expect(dry.stderr).toMatch(/Nothing was changed\. Run it again without --dry-run and with --yes to apply\.\n$/);
    });
  });

  describe('overlay banner', () => {
    it('goes to stderr, so stdout of list and plan stays parseable', async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      useOverlay('laptop');
      for (const args of [['list'], ['plan'], ['status']]) {
        const out = await run(args);
        expect(out.stdout, args.join(' ')).not.toContain('overlay: laptop');
        expect(out.stderr, args.join(' ')).toContain('overlay: laptop (file)\n');
      }
      expect((await run(['list'])).stdout).toMatch(/^PROFILE\s+ALIAS/);
    });
  });

  describe('DSHENV_PROFILE note', () => {
    beforeEach(async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      process.env.DSHENV_PROFILE = 'web';
    });

    it('is printed for a command that writes, not for one that only reads', async () => {
      expect((await run(['config', 'get', 'agent-teams'])).stderr).toBe('');
      expect((await run(['web', 'stop'])).stderr).toBe('');
      expect((await run(['disable', 'agent-teams'])).stderr).toBe("Using profile 'web' from DSHENV_PROFILE\n");
    });
  });

  describe('web start and stop without -p', () => {
    it('use the one profile the manifest declares, like runtime', async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      const stop = await run(['web', 'stop']);
      expect(stop.code).toBe(0);
      expect(stop.stdout).toBe('No dsh web started by dshenv is running for profile web.\n');
    });

    it('still ask for -p when the manifest declares several', async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      await run(['install', `${PKG}@0.1.21`, '-p', 'headless', '--new-profile']);
      const stop = await run(['web', 'stop']);
      expect(stop.code).toBe(3);
      expect(stop.stderr).toMatch(/^Missing -p, --profile <name>: choose one of headless, web/);
    });
  });

  describe('writes that change nothing', () => {
    beforeEach(async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    });

    it('say the plugin is already declared at that version', async () => {
      const again = await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      expect(again.code).toBe(0);
      expect(again.stdout).toBe(`${PKG} (agent-teams) is already declared at 0.1.21 in profile 'web' in the manifest; nothing changed.\n`);
      expect(JSON.parse((await run(['install', `${PKG}@0.1.21`, '-p', 'web', '--json'])).stdout)).toMatchObject({ status: 'installed', unchanged: true });
    });

    it('say the plugin is already enabled or disabled', async () => {
      const enabled = await run(['enable', 'agent-teams', '-p', 'web']);
      expect(enabled.stdout).toBe("Plugin 'agent-teams' in profile 'web' is already enabled in the manifest; nothing changed.\n");
      await run(['disable', 'agent-teams', '-p', 'web']);
      const disabled = await run(['disable', 'agent-teams', '-p', 'web']);
      expect(disabled.code).toBe(0);
      expect(disabled.stdout).toBe("Plugin 'agent-teams' in profile 'web' is already disabled in the manifest; nothing changed.\n");
      expect(JSON.parse((await run(['disable', 'agent-teams', '-p', 'web', '--json'])).stdout)).toMatchObject({ status: 'disabled', unchanged: true });
    });
  });

  it('shows a prerelease DSH version without a range-like wildcard', () => {
    expect(unsupportedDshVersionMessage('0.1.5-tok123')).toMatch(/^Unsupported DSH version 0\.1\.5 \(a prerelease\): /);
    expect(unsupportedDshVersionMessage('0.1.5-tok123')).not.toContain('tok123');
    expect(unsupportedDshVersionMessage('0.1.8')).toMatch(/^Unsupported DSH version 0\.1\.8: /);
  });

  it('keeps the deprecated positional ref out of source pull usage', async () => {
    const help = (await run(['source', 'pull', '--help'], false)).stdout;
    expect(help).toMatch(/^Usage: dshenv source sync \[options\] \[dir\]\n/);
    expect((await run(['source', '--help'], false)).stdout).not.toContain('targetRef');
  });
});
