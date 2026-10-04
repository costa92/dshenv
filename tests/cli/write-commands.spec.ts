import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest, serializeManifest } from '../../src/manifest/files.js';
import { OverlaySchema } from '../../src/overlay/schema.js';
import { parse as parseYaml } from 'yaml';

const PKG = '@nanmicoder/dsh-agent-teams';
const NEXT = 'Next: dshenv plan, then dshenv apply --yes.';

describe('CLI manifest write commands', () => {
  let tempHome: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY', 'DSHENV_DSH_URL', 'DSHENV_NPM_CHECK', 'DSH_CLI', 'PATH'];

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };
  const manifestText = () => fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');
  const manifest = () => loadManifest(manifestText());
  const overlay = (name: string) => OverlaySchema.parse(parseYaml(fs.readFileSync(path.join(tempHome, 'envctl', 'overlays', `${name}.yaml`), 'utf8')));
  const createProfile = (name: string) => {
    fs.mkdirSync(path.join(tempHome, 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', name, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}` }));
  };
  const useOverlay = (name: string) => {
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', `${name}.yaml`), 'apiVersion: dshenv-overlay/v1\n');
    process.env.DSHENV_OVERLAY = name;
  };

  beforeEach(async () => {
    for (const name of ENV) saved[name] = process.env[name];
    for (const name of ['DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY', 'DSHENV_DSH_URL']) delete process.env[name];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-write-'));
    await run(['init']);
    createProfile('web');
    await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
  });

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('output', () => {
    it('says each write changed the manifest and names the step that changes DSH', async () => {
      const cases: Array<[string[], string]> = [
        [['disable', 'agent-teams', '-p', 'web'], "Disabled plugin 'agent-teams' in profile 'web'"],
        [['enable', 'agent-teams', '-p', 'web'], "Enabled plugin 'agent-teams' in profile 'web'"],
        [['update', 'agent-teams', '--to', '0.1.22', '-p', 'web'], "Set agent-teams in profile 'web' to 0.1.22"],
        [['config', 'set', 'agent-teams', 'taskPlanning', 'captain', '-p', 'web'], "Set agent-teams config taskPlanning in profile 'web'"],
        [['config', 'unset', 'agent-teams', 'taskPlanning', '-p', 'web'], "Removed agent-teams config taskPlanning in profile 'web'"],
        [['remove', 'agent-teams', '-p', 'web'], "Removed plugin 'agent-teams' from profile 'web'"]
      ];
      for (const [args, text] of cases) {
        const out = await run(args);
        expect(out.code, args.join(' ')).toBe(0);
        expect(out.stdout, args.join(' ')).toBe(`${text} in the manifest. ${NEXT}\n`);
      }
    });

    it('points update on a Git or local plugin to what moves it instead', async () => {
      fs.writeFileSync(
        path.join(tempHome, 'envctl', 'manifest.yaml'),
        'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n' +
          '      demo:\n        package: demo\n        source: { type: git, url: "https://example.com/demo.git" }\n' +
          '      mine:\n        package: mine\n        source: { type: local-link, path: "/tmp/mine" }\n'
      );
      const git = await run(['update', 'demo', '--to', '1.0.0', '-p', 'web']);
      expect(git.code).toBe(3);
      expect(git.stderr).toContain('update --to currently supports npm sources only (got git); move a Git plugin with dshenv source sync -p web --as demo [--ref <ref>]');
      const local = await run(['update', 'mine', '--to', '1.0.0', '-p', 'web']);
      expect(local.code).toBe(3);
      expect(local.stderr).toContain('update --to currently supports npm sources only (got local-link); plan and apply pick up changes in a local source by themselves');
    });

    it('says an install over an existing alias changed its version', async () => {
      const out = await run(['install', `${PKG}@0.1.22`, '-p', 'web']);
      expect(out.stdout).toBe(`Changed agent-teams in profile 'web' from 0.1.21 to 0.1.22 in the manifest. ${NEXT}\n`);
      const same = await run(['install', `${PKG}@0.1.22`, '-p', 'web']);
      expect(same.stdout).toBe(`${PKG} (agent-teams) is already declared at 0.1.22 in profile 'web' in the manifest; nothing changed.\n`);
    });

    it('refuses an install whose alias already names another package, in the base and in an overlay', async () => {
      const base = await run(['install', 'dsh-plugin-other@1.0.0', '-p', 'web', '--as', 'agent-teams']);
      expect(base.code).toBe(3);
      expect(base.stderr).toMatch(/Alias 'agent-teams' is '@nanmicoder\/dsh-agent-teams' in profile 'web'.*--as/);
      expect(manifest().profiles.web.plugins['agent-teams'].package).toBe(PKG);

      useOverlay('laptop');
      await run(['install', 'dsh-plugin-demo@1.0.0', '-p', 'web', '--as', 'bar', '--layer', 'overlay']);
      const layered = await run(['install', 'dsh-plugin-other@3.0.0', '-p', 'web', '--as', 'bar', '--layer', 'overlay']);
      expect(layered.code).toBe(3);
      expect(layered.stderr).toMatch(/Alias 'bar' is 'dsh-plugin-demo' in profile 'web'.*--as/);
      expect(overlay('laptop').profiles?.web?.plugins?.bar).toMatchObject({ package: 'dsh-plugin-demo', source: { type: 'npm', version: '1.0.0' } });
    });

    it('records a git fragment as the commit when it is one, and as the ref otherwise', async () => {
      const commit = 'a'.repeat(40);
      expect((await run(['install', `git+https://example.invalid/dsh-plugin-x.git#${commit}`, '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins.x.source).toEqual({ type: 'git', url: 'https://example.invalid/dsh-plugin-x.git', commit });
      expect((await run(['install', 'git+https://example.invalid/dsh-plugin-y.git#v1.2.0', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins.y.source).toEqual({ type: 'git', url: 'https://example.invalid/dsh-plugin-y.git', ref: 'v1.2.0' });
      expect((await run(['install', 'git+https://example.invalid/dsh-plugin-z.git', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins.z.source).toEqual({ type: 'git', url: 'https://example.invalid/dsh-plugin-z.git' });
    });

    it('keeps the JSON of a write as it was', async () => {
      const out = JSON.parse((await run(['disable', 'agent-teams', '-p', 'web', '--json'])).stdout);
      expect(out).toEqual({ status: 'disabled', profile: 'web', alias: 'agent-teams' });
    });
  });

  describe('profile names', () => {
    it('refuses a profile no one declared or created, suggesting the close one, until --new-profile', async () => {
      const before = manifestText();
      const typo = await run(['install', `${PKG}@0.1.21`, '-p', 'wbe']);
      expect(typo.code).toBe(3);
      expect(typo.stderr).toBe(
        "Profile 'wbe' is neither declared in the manifest nor created by DSH; did you mean 'web'? (known profiles: web); pass --new-profile to add it as a new profile\n"
      );
      expect(manifestText()).toBe(before);

      const created = await run(['install', `${PKG}@0.1.21`, '-p', 'wbe', '--new-profile']);
      expect(created.code).toBe(0);
      expect(manifest().profiles.wbe.plugins['agent-teams']).toBeDefined();
    });

    it('lets a profile DSH created but the manifest does not declare yet be written', async () => {
      createProfile('headless');
      expect((await run(['install', `${PKG}@0.1.21`, '-p', 'headless'])).code).toBe(0);
    });

    it('names a profile the manifest does not declare instead of calling it a missing plugin', async () => {
      const out = await run(['disable', 'agent-teams', '-p', 'wbe']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe("Profile 'wbe' is not declared in the manifest; did you mean 'web'? (declared: web)\n");
    });

    it('says on stderr when the profile came from DSHENV_PROFILE, but not in --json output', async () => {
      process.env.DSHENV_PROFILE = 'web';
      const out = await run(['disable', 'agent-teams']);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("Using profile 'web' from DSHENV_PROFILE\n");
      const json = await run(['enable', 'agent-teams', '--json']);
      expect(json.stderr).toBe('');
      expect(JSON.parse(json.stdout).status).toBe('enabled');
    });

    it('refuses install without -p and names the profiles, as JSON with --json', async () => {
      const out = await run(['install', `${PKG}@0.1.21`]);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('Missing -p, --profile <name>: choose one of web, or set DSHENV_PROFILE\n');
      const json = await run(['install', `${PKG}@0.1.21`, '--json']);
      expect(json.code).toBe(3);
      expect(JSON.parse(json.stderr)).toEqual({
        error: { type: 'ValidationError', message: 'Missing -p, --profile <name>: choose one of web, or set DSHENV_PROFILE', exitCode: 3 }
      });
    });

    it('reports a broken overlay selection instead of claiming there is no profile', async () => {
      const out = await run(['disable', 'agent-teams', '--overlay', 'nope']);
      expect(out.code).toBe(3);
      expect(out.stderr).not.toMatch(/no profile exists yet/);
      expect(out.stderr).toMatch(/nope/);
    });

    it('refuses a filter -p naming no known profile, instead of reporting it in sync', async () => {
      for (const args of [['plan'], ['status'], ['list'], ['mark-restarted'], ['web', 'status']]) {
        const typo = await run([...args, '-p', 'wbe']);
        expect(typo.code, args.join(' ')).toBe(3);
        expect(typo.stderr, args.join(' ')).toBe("Profile 'wbe' is neither declared in the manifest nor created by DSH; did you mean 'web'? (known profiles: web)\n");
        expect((await run([...args, '-p', 'web'])).code, args.join(' ')).not.toBe(3);
      }
    });

    it('never applies DSHENV_PROFILE to the commands where -p only filters', async () => {
      createProfile('headless');
      await run(['install', `${PKG}@0.1.21`, '-p', 'headless']);
      process.env.DSHENV_PROFILE = 'web';
      const listed = JSON.parse((await run(['list', '--json'])).stdout) as { plugins: Array<{ profile: string }> };
      expect(listed.plugins.map((row) => row.profile).sort()).toEqual(['headless', 'web']);
      for (const args of [['pull', '--dry-run'], ['capture', '-o', path.join(tempHome, 'cap.yaml')], ['overlay', 'show'], ['restarted'], ['web', 'status']]) {
        const out = await run(args);
        expect(out.stderr, args.join(' ')).not.toMatch(/from DSHENV_PROFILE/);
      }
    });
  });

  describe('runtime profile selection', () => {
    it('says a profile it cannot check came from DSHENV_PROFILE', async () => {
      process.env.DSHENV_PROFILE = 'other';
      const out = await run(['runtime']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe("Profile 'other' (from DSHENV_PROFILE) is not declared in the manifest (declared: web)\n");
    });

    it('offers only declared profiles when -p is missing', async () => {
      createProfile('headless');
      await run(['install', `${PKG}@0.1.21`, '-p', 'sdk', '--new-profile']);
      const out = await run(['runtime']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('Missing -p, --profile <name>: choose one of sdk, web, or set DSHENV_PROFILE\n');
    });

    it('still says so when the manifest declares no profile', async () => {
      await run(['remove', 'agent-teams', '-p', 'web']);
      fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'apiVersion: dshenv/v1\nprofiles: {}\n');
      const out = await run(['runtime']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('The manifest declares no profiles\n');
    });
  });

  describe('plugin names', () => {
    it('takes the package name for its alias, and suggests the alias for a typo', async () => {
      expect((await run(['disable', PKG, '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);
      const typo = await run(['enable', 'agent-team', '-p', 'web']);
      expect(typo.code).toBe(3);
      expect(typo.stderr).toBe("Plugin 'agent-team' not found in profile 'web'; did you mean 'agent-teams'? (aliases: agent-teams)\n");
    });

    it('changes a base plugin the overlay removes when writing the base', async () => {
      useOverlay('laptop');
      fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams: { remove: true }\n');
      const out = await run(['disable', 'agent-teams', '-p', 'web', '--layer', 'base']);
      expect(out.code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);
      expect((await run(['enable', 'agent-teams', '-p', 'web', '--layer', 'overlay'])).code).toBe(3);
    });

    it('says a plugin only the overlay declares must be written there', async () => {
      useOverlay('laptop');
      await run(['install', 'dsh-plugin-demo@1.0.0', '-p', 'web', '--as', 'teams2', '--layer', 'overlay']);
      const base = await run(['disable', 'teams2', '-p', 'web', '--layer', 'base']);
      expect(base.code).toBe(3);
      expect(base.stderr).toBe("Plugin 'teams2' is declared in overlay 'laptop', not in the base manifest; use --layer overlay\n");
    });
  });

  describe('config', () => {
    beforeEach(async () => {
      await run(['config', 'set', 'agent-teams', 'team.lead', 'captain', '-p', 'web']);
    });

    it('refuses the path given twice, and a key the config does not have', async () => {
      const twice = await run(['config', 'get', 'agent-teams', 'team.lead', '--path', 'team', '-p', 'web']);
      expect(twice.code).toBe(3);
      expect(twice.stderr).toMatch(/Give the config path once/);

      const missing = await run(['config', 'get', 'agent-teams', 'tema', '-p', 'web', '--json']);
      expect(missing.code).toBe(3);
      expect(missing.stdout).toBe('');
      expect(JSON.parse(missing.stderr)).toEqual({
        error: { type: 'ValidationError', message: "The config of 'agent-teams' in profile 'web' has no 'tema'; did you mean 'team'?", exitCode: 3 }
      });
    });

    it('refuses a source pull ref given both ways', async () => {
      const out = await run(['source', 'pull', tempHome, 'v1', '--ref', 'v2']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('Give the ref once: with --ref or as the second argument, not both\n');
    });

    it('unsets one key and drops parents it leaves empty', async () => {
      await run(['config', 'set', 'agent-teams', 'mode', 'fast', '-p', 'web']);
      expect((await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].patches?.[0].config).toEqual({ mode: 'fast' });
      const again = await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web']);
      expect(again.code).toBe(3);
      expect(again.stderr).toBe("The config of 'agent-teams' in profile 'web' has no 'team.lead'\n");
    });

    it('unsets a key the overlay sets, but not one the base sets', async () => {
      useOverlay('laptop');
      await run(['config', 'set', 'agent-teams', 'mode', 'fast', '-p', 'web', '--layer', 'overlay']);
      expect((await run(['config', 'unset', 'agent-teams', 'mode', '-p', 'web', '--layer', 'overlay'])).code).toBe(0);
      // A patch left with nothing to set is dropped, not kept as `config: {}`.
      expect(overlay('laptop').profiles?.web?.plugins?.['agent-teams']?.patches).toBeUndefined();
      const base = await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web', '--layer', 'overlay']);
      expect(base.code).toBe(3);
      expect(base.stderr).toBe("'team.lead' of 'agent-teams' is set in the base manifest, which an overlay cannot remove; use --layer base\n");
    });

    it('warns about a key DSH does not compose for the plugin but sets it, and --force keeps quiet', async () => {
      const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
      fs.writeFileSync(
        fakeDsh,
        `if (process.argv.includes('--dump-config')) { process.stdout.write(${JSON.stringify(`- id: agent-teams\n  name: '${PKG}'\n  config:\n    taskPlanning: auto\n    team: {}\n`)}); process.exit(0); }\nprocess.exit(1);\n`
      );
      process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
      // DSH composes only the keys that have defaults, so a key it does not show can still be real.
      const typo = await run(['config', 'set', 'agent-teams', 'taskPlaning', 'captain', '-p', 'web']);
      expect(typo.code).toBe(0);
      expect(typo.stderr).toBe(
        `'taskPlaning' is not among the keys DSH composes for ${PKG} (taskPlanning, team); did you mean 'taskPlanning'? Set it anyway; pass --force to skip this check\n`
      );
      expect(manifest().profiles.web.plugins['agent-teams'].patches?.[0].config).toMatchObject({ taskPlaning: 'captain' });
      expect((await run(['config', 'set', 'agent-teams', 'taskPlanning', 'captain', '-p', 'web'])).stderr).toBe('');
      expect((await run(['config', 'set', 'agent-teams', 'maxRounds', '3', '-p', 'web', '--force'])).stderr).toBe('');
    });

    describe('copies the config DSH composes into a new patch, since DSH replaces the whole config with it', () => {
      const fakeDump = (rows: string) => {
        const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
        fs.writeFileSync(fakeDsh, `if (process.argv.includes('--dump-config')) { process.stdout.write(${JSON.stringify(rows)}); process.exit(0); }\nprocess.exit(1);\n`);
        process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
      };
      const ROW = `- id: agent-teams\n  name: '${PKG}'\n  config:\n    stateDir: .agent-teams\n    memberProvider: spawn\n    when: !!js 'ctx.ready'\n`;
      // Start without the patch the enclosing beforeEach sets.
      beforeEach(async () => {
        expect((await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web'])).code).toBe(0);
        expect(manifest().profiles.web.plugins['agent-teams'].patches).toBeUndefined();
      });

      it('in the base, keeping the plugin defaults beside the key set', async () => {
        fakeDump(ROW);
        expect(await run(['config', 'set', 'agent-teams', 'stateDir', '.sd', '-p', 'web'])).toMatchObject({ code: 0, stderr: '' });
        expect(manifest().profiles.web.plugins['agent-teams'].patches).toEqual([
          { id: 'agent-teams', config: { stateDir: '.sd', memberProvider: 'spawn', when: { __jsExpr: 'ctx.ready' } } }
        ]);
        // The patch now restates the config; later writes change only their key.
        fakeDump(`- id: agent-teams\n  name: '${PKG}'\n  config:\n    stateDir: .sd\n`);
        expect((await run(['config', 'set', 'agent-teams', 'memberProvider', 'fork', '-p', 'web'])).code).toBe(0);
        expect(manifest().profiles.web.plugins['agent-teams'].patches?.[0].config).toEqual({ stateDir: '.sd', memberProvider: 'fork', when: { __jsExpr: 'ctx.ready' } });
      });

      it('in the overlay', async () => {
        fakeDump(ROW);
        useOverlay('laptop');
        expect((await run(['config', 'set', 'agent-teams', 'stateDir', '.sd', '-p', 'web', '--layer', 'overlay'])).code).toBe(0);
        expect(overlay('laptop').profiles?.web?.plugins?.['agent-teams'].patches).toEqual([
          { id: 'agent-teams', config: { stateDir: '.sd', memberProvider: 'spawn', when: { __jsExpr: 'ctx.ready' } } }
        ]);
      });

      it('says the defaults are dropped when DSH has no config for the plugin yet', async () => {
        fakeDump('- id: other\n  name: other-plugin\n  config: {}\n');
        const out = await run(['config', 'set', 'agent-teams', 'stateDir', '.sd', '-p', 'web']);
        expect(out.code).toBe(0);
        expect(out.stderr).toBe(
          `DSH has no config for ${PKG} in profile 'web' yet, so the patch holds only stateDir; DSH replaces the plugin's whole config with it, dropping its defaults. To keep them: config unset it, apply, then config set it again\n`
        );
        expect(manifest().profiles.web.plugins['agent-teams'].patches?.[0].config).toEqual({ stateDir: '.sd' });
      });
    });

    it('refuses __proto__, prototype and constructor in a path and never reaches inherited keys', async () => {
      for (const args of [
        ['config', 'set', 'agent-teams', '__proto__.polluted', 'yes', '-p', 'web'],
        ['config', 'set', 'agent-teams', 'team.constructor.prototype', 'yes', '-p', 'web', '--force'],
        ['config', 'unset', 'agent-teams', '__proto__.toString', '-p', 'web'],
        ['config', 'get', 'agent-teams', 'constructor', '-p', 'web']
      ]) {
        const out = await run(args);
        expect(out.code, args.join(' ')).toBe(3);
        expect(out.stderr).toMatch(/^Invalid config path: /);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(typeof Object.prototype.toString).toBe('function');

      const inherited = await run(['config', 'unset', 'agent-teams', 'toString', '-p', 'web']);
      expect(inherited.code).toBe(3);
      expect(inherited.stderr).toBe("The config of 'agent-teams' in profile 'web' has no 'toString'\n");
      expect((await run(['config', 'get', 'agent-teams', 'hasOwnProperty', '-p', 'web'])).code).toBe(3);
    });

    it('refuses an empty config path instead of printing the whole config', async () => {
      const out = await run(['config', 'get', 'agent-teams', '', '-p', 'web']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('Invalid config path: \n');
    });

    it('unsets a key from any declared patch and drops a patch it leaves empty', async () => {
      const doc = manifest();
      doc.profiles.web.plugins['agent-teams'].patches = [
        { id: 'agent-teams', config: { team: { lead: 'captain' } } },
        { id: 'agent-teams-extra', config: { mode: 'fast' } }
      ];
      fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), serializeManifest(doc));
      expect((await run(['config', 'unset', 'agent-teams', 'mode', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].patches).toEqual([{ id: 'agent-teams', config: { team: { lead: 'captain' } } }]);
      expect((await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].patches).toBeUndefined();
    });
  });

  describe('DSHENV_LAYER', () => {
    it('picks the layer while an overlay is active, says so, and refuses overlay without one', async () => {
      process.env.DSHENV_LAYER = 'overlay';
      const before = manifestText();
      // Like --layer overlay: a change meant for this machine must not land in the base the team shares.
      const none = await run(['disable', 'agent-teams', '-p', 'web']);
      expect(none.code).toBe(3);
      expect(none.stderr).toBe('--layer overlay requires an active overlay (use --overlay or dshenv overlay use) (from DSHENV_LAYER)\n');
      expect(manifestText()).toBe(before);
      process.env.DSHENV_LAYER = 'base';
      const base = await run(['disable', 'agent-teams', '-p', 'web']);
      expect(base.code).toBe(0);
      expect(base.stderr).toBe('');
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);

      process.env.DSHENV_LAYER = 'overlay';
      useOverlay('laptop');
      const out = await run(['enable', 'agent-teams', '-p', 'web']);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("Using layer 'overlay' from DSHENV_LAYER\n");
      expect(overlay('laptop').profiles?.web?.plugins?.['agent-teams']?.enabled).toBe(true);
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);

      // An explicit --layer wins, so DSHENV_LAYER is not mentioned.
      expect((await run(['disable', 'agent-teams', '-p', 'web', '--layer', 'base'])).stderr).not.toMatch(/DSHENV_LAYER/);
    });

    it('refuses an invalid value while an overlay is active, and says where it came from', async () => {
      process.env.DSHENV_LAYER = 'top';
      // Without an overlay the variable has no effect, so it cannot break a write.
      expect((await run(['disable', 'agent-teams', '-p', 'web'])).code).toBe(0);
      useOverlay('laptop');
      const out = await run(['disable', 'agent-teams', '-p', 'web']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe("Invalid --layer 'top'; expected base or overlay (from DSHENV_LAYER)\n");
    });

    it('warns when the active overlay keeps a base write from taking effect', async () => {
      useOverlay('laptop');
      fs.writeFileSync(
        path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'),
        'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams:\n        enabled: true\n'
      );
      const out = await run(['disable', 'agent-teams', '-p', 'web', '--layer', 'base']);
      expect(out.code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);
      expect(out.stderr).toBe(
        "Overlay 'laptop' sets enabled: true for agent-teams in profile 'web', so it stays enabled on this machine; use --layer overlay to change it here\n"
      );
      expect((await run(['disable', 'agent-teams', '-p', 'web', '--layer', 'base', '--json'])).stderr).toBe('');
    });

    it('warns when the overlay keeps a base update or config write from taking effect', async () => {
      useOverlay('laptop');
      fs.writeFileSync(
        path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'),
        'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams:\n        source: { type: npm, version: "0.1.30" }\n        patches:\n          - id: agent-teams\n            config: { stateDir: .o }\n'
      );
      const update = await run(['update', 'agent-teams', '--to', '0.1.22', '-p', 'web', '--layer', 'base', '--no-npm-check']);
      expect(update.code).toBe(0);
      expect(update.stderr).toBe(
        "Overlay 'laptop' sets the source of agent-teams in profile 'web', so it stays at 0.1.30 on this machine; use --layer overlay to change it here\n"
      );
      const set = await run(['config', 'set', 'agent-teams', 'stateDir', '.b', '-p', 'web', '--layer', 'base', '--force']);
      expect(set.code).toBe(0);
      expect(set.stderr).toBe(
        "Overlay 'laptop' sets stateDir of agent-teams in profile 'web', so it stays \".o\" on this machine; use --layer overlay to change it here\n"
      );
      const unset = await run(['config', 'unset', 'agent-teams', 'stateDir', '-p', 'web', '--layer', 'base']);
      expect(unset.code).toBe(0);
      expect(unset.stderr).toBe(
        "Overlay 'laptop' sets stateDir of agent-teams in profile 'web', so it stays \".o\" on this machine; use --layer overlay to change it here\n"
      );
      // Writes the overlay does not override say nothing.
      expect((await run(['config', 'set', 'agent-teams', 'other', '1', '-p', 'web', '--layer', 'base', '--force'])).stderr).toBe('');
    });

    it('hides --layer on adopt, which only writes the base', async () => {
      expect((await run(['adopt', '--help'])).stdout).not.toMatch(/--layer/);
      expect((await run(['install', '--help'])).stdout).toMatch(/--layer <layer>\s+layer to write when an overlay is active: base or\s+overlay \(default: \$DSHENV_LAYER\)/);
    });
  });
});

// Stands in for npm on PATH; POSIX only, as Windows would need a .cmd shim.
describe.skipIf(process.platform === 'win32')('CLI install checks npm', () => {
  let tempHome: string;
  const saved: Record<string, string | undefined> = {};

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };
  const fakeNpm = (script: string) => {
    const bin = path.join(tempHome, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
    delete process.env.DSHENV_NPM_CHECK;
  };

  beforeEach(async () => {
    for (const name of ['PATH', 'DSHENV_NPM_CHECK']) saved[name] = process.env[name];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-npm-'));
    await run(['init']);
  });

  afterEach(() => {
    for (const name of ['PATH', 'DSHENV_NPM_CHECK']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const npmCalls = () => {
    const log = path.join(tempHome, 'npm-calls.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  };
  // Every fake npm records its arguments, then runs the case body on "$*".
  const npmCases = (body: string) => fakeNpm(`echo "$*" >> '${path.join(tempHome, 'npm-calls.log')}'\ncase "$*" in\n${body}\nesac`);

  it('refuses a version npm does not have and names the latest', async () => {
    npmCases(`*@9.9.9*) exit 0 ;;\n*) echo 0.1.22 ;;`);
    const out = await run(['install', `${PKG}@9.9.9`, '-p', 'web']);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe(`npm has no version 9.9.9 of ${PKG}; the latest is 0.1.22\n`);
  });

  it('tells a missing version from a missing package when npm answers E404 for both', async () => {
    // npm 10 answers E404 for a version it does not have, as for a package it does not have.
    npmCases(`*@9.9.9*) echo "npm error code E404" >&2; exit 1 ;;\n*) echo 0.1.22 ;;`);
    const out = await run(['install', `${PKG}@9.9.9`, '-p', 'web']);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe(`npm has no version 9.9.9 of ${PKG}; the latest is 0.1.22\n`);
    expect(npmCalls()).toEqual([`view --fetch-retries=0 -- ${PKG}@9.9.9 version`, `view --fetch-retries=0 -- ${PKG} version`]);
  });

  it('warns but goes ahead for a package npm cannot see, which may be private', async () => {
    npmCases(`*) echo "npm error code E404" >&2; exit 1 ;;`);
    const out = await run(['install', '@acme/private-plugin@1.0.0', '-p', 'web', '--new-profile']);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe(
      'npm cannot see @acme/private-plugin (a private package needs npm credentials); apply fails if it does not exist. Skip this check with --no-npm-check or DSHENV_NPM_CHECK=off\n'
    );
  });

  it('warns but goes ahead when npm refuses the credentials', async () => {
    npmCases(`*) echo "npm error code E403" >&2; exit 1 ;;`);
    const out = await run(['install', `${PKG}@0.1.21`, '-p', 'web', '--new-profile', '--json']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).npmCheck).toBe('unverified');
  });

  it('warns and goes ahead when npm cannot be asked', async () => {
    npmCases(`*) echo "npm error code ENOTFOUND" >&2; exit 1 ;;`);
    const out = await run(['install', `${PKG}@0.1.21`, '-p', 'web', '--new-profile']);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe(
      `Could not check ${PKG}@0.1.21 on npm (npm view failed); apply fails if it does not exist. Skip this check with --no-npm-check or DSHENV_NPM_CHECK=off\n`
    );
  });

  it('accepts a version npm has and says so in --json', async () => {
    npmCases(`*) echo '"0.1.21"' ;;`);
    const out = await run(['install', `${PKG}@0.1.21`, '-p', 'web', '--new-profile', '--json']);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout).npmCheck).toBe('verified');
  });

  it('never hands npm a package name that could read as an option', async () => {
    npmCases(`*) echo '"1.0.0"' ;;`);
    for (const spec of ['--registry=https://evil.example@1.0.0', '-x@1.0.0', 'UPPER@1.0.0']) {
      let stderr = '';
      // After `--` commander hands even an option-like spec to install.
      const code = await runCli(['--dsh-home', tempHome, 'install', '-p', 'web', '--new-profile', '--', spec], {
        stdout: () => {},
        stderr: (chunk) => {
          stderr += chunk;
        }
      });
      expect(code, spec).toBe(3);
      expect(stderr).toMatch(/^Invalid npm package name/);
    }
    expect(npmCalls()).toEqual([]);
  });

  it('skips the check with --no-npm-check', async () => {
    npmCases(`*) echo "npm error code E404" >&2; exit 1 ;;`);
    const out = await run(['install', `${PKG}@9.9.9`, '-p', 'web', '--new-profile', '--no-npm-check', '--json']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).npmCheck).toBe('skipped');
    expect(npmCalls()).toEqual([]);
  });

  it('checks update --to the same way', async () => {
    npmCases(`*@0.1.21*) echo '"0.1.21"' ;;\n*@9.9.9*) echo "npm error code E404" >&2; exit 1 ;;\n*) echo 0.1.22 ;;`);
    expect((await run(['install', `${PKG}@0.1.21`, '-p', 'web', '--new-profile'])).code).toBe(0);
    const missing = await run(['update', 'agent-teams', '--to', '9.9.9', '-p', 'web']);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toBe(`npm has no version 9.9.9 of ${PKG}; the latest is 0.1.22\n`);
    const skipped = await run(['update', 'agent-teams', '--to', '9.9.9', '-p', 'web', '--no-npm-check', '--json']);
    expect(skipped.code).toBe(0);
    expect(JSON.parse(skipped.stdout)).toMatchObject({ status: 'updated', version: '9.9.9', npmCheck: 'skipped' });
  });
});
