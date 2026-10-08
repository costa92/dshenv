import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI surface', () => {
  let tempHome: string;

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
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
  const manifest = () => loadManifest(fs.readFileSync(manifestFile(), 'utf8'));

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-surface-'));
    await run(['init']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('status and plan', () => {
    beforeEach(async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      await run(['install', 'dsh-plugin-other@1.0.0', '-p', 'headless', '--new-profile']);
    });

    it('shows the rows of the plugin status is asked about, and counts declared profiles', async () => {
      const all = await run(['status']);
      expect(all.stdout).toContain('Profiles monitored: 2\n');
      expect(all.stdout).toMatch(/web\s+@nanmicoder\/dsh-agent-teams\s+drifted/);
      expect(all.stdout).toMatch(/headless\s+dsh-plugin-other\s+drifted/);

      const one = await run(['status', 'agent-teams']);
      expect(one.stdout).toMatch(/web\s+@nanmicoder\/dsh-agent-teams\s+drifted/);
      expect(one.stdout).not.toContain('dsh-plugin-other');
    });

    it('limits plan and status to one profile with -p', async () => {
      const plan = await run(['plan', '-p', 'web']);
      expect(plan.code).toBe(2);
      expect(plan.stdout).toContain('[web]');
      expect(plan.stdout).not.toContain('[headless]');

      const apply = await run(['apply', '-p', 'web']);
      expect(apply.code).toBe(2);
      expect(apply.stdout).toContain('[web]');
      expect(apply.stdout).not.toContain('[headless]');
      expect((await run(['apply', '-p', 'nope'])).stderr).toContain("Profile 'nope' is neither declared in the manifest nor created by DSH");

      const status = await run(['status', '-p', 'headless']);
      expect(status.stdout).toContain('dsh-plugin-other');
      expect(status.stdout).not.toContain(PKG);
    });
  });

  describe('usage errors', () => {
    it('exits 3 on a missing argument, an unknown option or an unknown command, and keeps the suggestion', async () => {
      const missing = await run(['install']);
      expect(missing.code).toBe(3);
      expect(missing.stderr).toMatch(/missing required argument 'spec'/);

      const unknownOption = await run(['plan', '--bogus']);
      expect(unknownOption.code).toBe(3);
      expect(unknownOption.stderr).toMatch(/unknown option '--bogus'/);

      const requiredOption = await run(['update', 'agent-teams', '-p', 'web']);
      expect(requiredOption.code).toBe(3);
      expect(requiredOption.stderr).toMatch(/required option '--to <version>' not specified/);

      const typo = await run(['instal']);
      expect(typo.code).toBe(3);
      expect(typo.stderr).toMatch(/Did you mean install\?/);
    });

    it('reports a usage error as JSON with --json', async () => {
      const out = await run(['install', '--json']);
      expect(out.code).toBe(3);
      expect(out.stdout).toBe('');
      const error = JSON.parse(out.stderr) as { error: { type: string; message: string; exitCode: number } };
      expect(error.error).toEqual({ type: 'ValidationError', message: "missing required argument 'spec'", exitCode: 3 });
    });

    it('exits 3 when help is asked for a command that does not exist, as running it would', async () => {
      for (const args of [['help', 'bogus'], ['bogus', '--help'], ['--dsh-home', '/tmp/x', 'bogus', '-h']]) {
        const out = await run(args, false);
        expect(out.code).toBe(3);
        expect(out.stdout).toBe('');
        expect(out.stderr).toMatch(/unknown command 'bogus'/);
      }
      expect((await run(['help', 'instal'], false)).stderr).toMatch(/Did you mean install\?/);
      const json = await run(['--json', 'help', 'bogus'], false);
      expect(JSON.parse(json.stderr.split('\n').filter(Boolean).at(-1)!).error.exitCode).toBe(3);
      for (const args of [['help', 'plan'], ['plan', '--help'], ['remote', 'sync', '--help'], ['help']]) {
        expect((await run(args, false)).code).toBe(0);
      }
    });

    it('treats help and version for an unknown subcommand as the unknown command, and shows help for a nested one', async () => {
      for (const args of [['web', 'foo', '--help'], ['plugins', 'nope', '-h'], ['help', 'web', 'foo'], ['web', 'help', 'foo'], ['foo', '--version'], ['plugins', 'config', 'nope', '--help']]) {
        const out = await run(args, false);
        expect(out.code, args.join(' ')).toBe(3);
        expect(out.stdout, args.join(' ')).toBe('');
        expect(out.stderr, args.join(' ')).toMatch(/unknown command '(foo|nope)'/);
      }
      const json = await run(['--json', 'web', 'foo', '--help'], false);
      expect(json.stdout).toBe('');
      expect(JSON.parse(json.stderr.split('\n').filter(Boolean).at(-1)!).error.exitCode).toBe(3);

      const nested = await run(['help', 'web', 'start'], false);
      expect(nested.code).toBe(0);
      expect(nested.stdout).toContain('Usage: dshenv web start');
      // A group's own help command reaches a command below it, as the top-level one does.
      const inGroup = await run(['plugins', 'help', 'config', 'set'], false);
      expect(inGroup.code).toBe(0);
      expect(inGroup.stdout).toContain('Usage: dshenv plugins config set');
      for (const args of [['web', 'start', '--help'], ['help', 'web'], ['plugins', 'config', 'set', '--help'], ['--version'], ['web', 'start', '-p', 'web', '--help']]) {
        expect((await run(args, false)).code, args.join(' ')).toBe(0);
      }
    });

    it('still exits 0 for help and version, and shows help when run without a command', async () => {
      expect((await run(['--help'], false)).code).toBe(0);
      expect((await run(['-v'], false)).code).toBe(0);
      const bare = await run([], false);
      expect(bare.code).toBe(0);
      expect(bare.stdout).toContain('Usage: dshenv');
    });
  });

  describe('help', () => {
    it('groups commands and lists examples, data flow and environment variables', async () => {
      const help = (await run(['--help'], false)).stdout;
      for (const heading of ['Getting started:', 'Everyday:', 'Plugins & tools:', 'Run & check:', 'Team & machine:', 'Authoring:', 'Maintenance:', 'Examples:', 'Environment variables:']) {
        expect(help).toContain(heading);
      }
      const group = (heading: string) => help.split(heading)[1].split(/\n\n/)[0].match(/^ {2}[a-z-]+/gm)!.map((name) => name.trim());
      expect(group('Everyday:')).toEqual(['plan', 'apply', 'pull', 'status', 'mark-restarted']);
      expect(group('Plugins & tools:')).toEqual(['install', 'update', 'remove', 'enable', 'disable', 'plugins', 'tools', 'source']);
      expect(group('Team & machine:')).toEqual(['remote', 'overlay']);
      expect(group('Run & check:')).toEqual(['web', 'verify', 'doctor']);
      expect(group('Maintenance:')).toEqual(['rollback', 'purge', 'gc', 'migrate', 'self-update']);
      const examples = help.split('Examples:')[1].split('Data flow:')[0];
      for (const example of ['dshenv pull --yes', 'dshenv verify --start -p web', 'dshenv remote add <url> --yes', 'dshenv adopt capture.yaml --yes']) {
        expect(examples).toContain(example);
      }
      // Each check says what it looks at, so the four of them can be told apart.
      const flat = help.replace(/\s+/g, ' ');
      expect(flat).toContain('plan [options] Show what apply would change');
      expect(flat).toContain('apply [options] Make DSH match the manifest');
      expect(flat).toContain('doctor Check that DSH runs and the dshenv files are readable (not whether plugins are loaded: verify)');
      expect(flat).toMatch(/remove \[options\] <alias> [^:]*purge/);
      for (const name of ['DSH_HOME', 'DSH_CLI', 'DSHENV_HOME', 'DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY', 'DSHENV_DSH_URL']) {
        expect(help).toContain(name);
      }
      expect(help).toMatch(/remote sync\s+team repository -> local envctl/);
      expect(help).toMatch(/source sync\s+upstream Git -> a plugin's managed clone/);
      expect(help).toMatch(/DSHENV_DSH_URL\s+dsh web URL that verify checks/);
      // Every command sits in a named group; none is left under commander's default heading.
      expect(help).not.toMatch(/^Commands:/m);
      expect(help).toMatch(/Getting started:[\s\S]*help \[command\][\s\S]*Everyday:/);
      // Kept for old scripts, but not advertised.
      expect(help).not.toMatch(/^\s+sync\b/m);
      expect(help).not.toMatch(/^\s+restarted\b/m);
      expect(help).not.toContain('uninstall');
      expect(help).not.toMatch(/^\s+(list|config|runtime)\b/m);
      expect(help).not.toContain('source pull');
      expect(help).toMatch(/^\s+mark-restarted\b/m);
    });

    it('shows global options in subcommand help and marks required options', async () => {
      expect((await run(['apply', '--help'], false)).stdout).toMatch(/Global Options:[\s\S]*--json/);
      expect((await run(['update', '--help'], false)).stdout).toMatch(/--to <version>\s+\(required\)/);
      const adoptHelp = (await run(['adopt', '--help'], false)).stdout;
      expect(adoptHelp).toMatch(/^Usage: dshenv adopt \[options\] <file>$/m);
      expect(adoptHelp).not.toContain('--from');
      const config = (await run(['plugins', 'config', '--help'], false)).stdout;
      expect(config).toMatch(/get \[options\] <alias> \[dottedPath\]\s+\S+/);
      expect(config).toMatch(/validate \[options\] <alias>\s+\S+/);
      expect(config).toMatch(/set \[options\] <alias> <dottedPath> <value>\s+\S+/);
      expect((await run(['remove', '--help'], false)).stdout).not.toContain('--yes');
    });
  });

  describe('list and show verbs', () => {
    it('names web list and source show in help, and keeps status as a hidden alias', async () => {
      const web = (await run(['web', '--help'], false)).stdout;
      expect(web).toMatch(/^\s+list \[options\]/m);
      expect(web).not.toMatch(/status/);
      expect(await run(['web', 'status'])).toEqual(await run(['web', 'list']));

      const source = (await run(['source', '--help'], false)).stdout;
      expect(source).toMatch(/^\s+show \[options\] \[dir\]/m);
      expect(source).toMatch(/^\s+clone \[options\] <url> \[dir\]/m);
      expect(source).toMatch(/^\s+sync \[options\] \[dir\]/m);
      expect(source).not.toMatch(/status|pull|targetDir|sourcePath/);
      expect((await run(['source', 'status', '--help'], false)).stdout).toMatch(/Usage: dshenv source show/);
      expect((await run(['source', 'pull', '--help'], false)).stdout).toMatch(/Usage: dshenv source sync/);
      // pull alone runs the other way, from DSH into the manifest, so the old name says which one it is.
      const oldName = await run(['source', 'pull', tempHome, '--yes']);
      expect(oldName.stderr).toContain("'source pull' is an old name for 'source sync', which moves a clone from its upstream Git; 'dshenv pull' takes changes made in DSH into the manifest");
      expect((await run(['source', 'sync', tempHome, '--yes'])).stderr).not.toContain('old name');
    });

    it('runs the plugin commands under plugins too, and keeps the old top-level names', async () => {
      const plugins = (await run(['plugins', '--help'], false)).stdout;
      expect(plugins.match(/^ {2}[a-z]+/gm)!.map((name) => name.trim())).toEqual(['install', 'update', 'remove', 'enable', 'disable', 'list', 'official', 'config', 'help']);
      expect((await run(['plugins', 'list', '--help'], false)).stdout).toMatch(/Usage: dshenv plugins list/);

      expect((await run(['plugins', 'install', `${PKG}@0.1.21`, '-p', 'web'])).code).toBe(0);
      expect((await run(['plugins', 'config', 'set', 'agent-teams', 'teams.max', '3', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].patches?.[0].config).toEqual({ teams: { max: 3 } });
      expect((await run(['plugins', 'disable', 'agent-teams', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);

      const listed = await run(['plugins', 'list']);
      expect(listed.stdout).toContain('agent-teams');
      expect(await run(['list'])).toEqual(listed);
      expect(await run(['config', 'get', 'agent-teams', '-p', 'web'])).toEqual(await run(['plugins', 'config', 'get', 'agent-teams', '-p', 'web']));

      expect((await run(['plugins', 'remove', 'agent-teams', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins).not.toHaveProperty('agent-teams');
    });

    it('names the runtime check verify, like apply --verify, and keeps runtime as a hidden alias', async () => {
      expect((await run(['verify', '--help'], false)).stdout).toMatch(/Usage: dshenv verify/);
      expect((await run(['runtime', '--help'], false)).stdout).toMatch(/Usage: dshenv verify/);
      expect((await run(['apply', '--verify'])).stderr).toContain('run dshenv verify to check without applying');
    });
  });

  describe('--yes', () => {
    beforeEach(async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    });

    it('previews apply and exits 2 without --yes, like apply --dry-run', async () => {
      const preview = await run(['apply']);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toContain(PKG);
      expect(preview.stderr).toMatch(/Re-run with --yes to apply/);
      expect(fs.existsSync(path.join(tempHome, 'profiles', 'web'))).toBe(false);

      expect((await run(['apply', '--dry-run'])).code).toBe(2);
    });

    it('exits 0 from apply --dry-run when nothing would change', async () => {
      await run(['remove', 'agent-teams', '-p', 'web', '-y']);
      const clean = await run(['apply', '--dry-run']);
      expect(clean.code).toBe(0);
      expect((await run(['apply'])).code).toBe(0);
    });

    it('previews gc without --yes', async () => {
      const trash = path.join(tempHome, 'envctl', 'trash', 'old');
      fs.mkdirSync(trash, { recursive: true });
      const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      fs.utimesSync(trash, old, old);
      const preview = await run(['gc']);
      expect(preview.code).toBe(2);
      expect(preview.stderr).toMatch(/Re-run with --yes/);
      expect(fs.existsSync(trash)).toBe(true);
      expect((await run(['gc', '--yes'])).code).toBe(0);
      expect(fs.existsSync(trash)).toBe(false);
      expect((await run(['gc'])).code).toBe(0);
    });

    it('previews adopt without --yes and writes nothing', async () => {
      fs.mkdirSync(path.join(tempHome, 'profiles', 'headless'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, 'profiles', 'headless', 'package.json'),
        JSON.stringify({ name: 'dsh-profile-headless', private: true, dependencies: { 'dsh-plugin-other': '1.0.0' }, dsh: { profile: { bundles: ['dsh-plugin-other'] } } })
      );
      fs.mkdirSync(path.join(tempHome, 'profiles', 'headless', 'node_modules', 'dsh-plugin-other'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, 'profiles', 'headless', 'node_modules', 'dsh-plugin-other', 'package.json'),
        JSON.stringify({ name: 'dsh-plugin-other', version: '1.0.0' })
      );
      const candidate = path.join(tempHome, 'capture.yaml');
      const captured = await run(['capture', '-p', 'headless', '-o', candidate]);
      expect(captured.stderr).toBe('');
      const before = fs.readFileSync(manifestFile(), 'utf8');

      const both = await run(['adopt', candidate, '-f', candidate]);
      expect(both.code).toBe(3);
      expect(both.stderr).toContain('Give the capture file once');
      const neither = await run(['adopt']);
      expect(neither.code).toBe(3);
      expect(neither.stderr).toContain("missing required argument 'file'");

      const preview = await run(['adopt', candidate]);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toContain('dsh-plugin-other');
      expect(preview.stderr).toMatch(/Re-run with --yes to adopt/);
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);

      const dryRun = await run(['adopt', '-f', candidate, '--yes', '--dry-run']);
      expect(dryRun.code).toBe(2);
      expect(dryRun.stderr).toMatch(/without --dry-run and with --yes to adopt/);
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);

      expect((await run(['adopt', '-f', candidate, '--yes'])).code).toBe(0);
      expect(manifest().profiles.headless.plugins).toHaveProperty('plugin-other');
    });

    it('says in help that every --yes command only previews without it', async () => {
      for (const args of [['apply'], ['adopt'], ['pull'], ['rollback'], ['gc'], ['purge'], ['remote', 'add'], ['remote', 'sync'], ['remote', 'remove']]) {
        const help = (await run([...args, '--help'], false)).stdout.replace(/\s+/g, ' ');
        expect(help, args.join(' ')).toMatch(/-y, --yes [^-]*without it [a-z ]+ only previews/);
        expect(help, args.join(' ')).toMatch(/--dry-run [^-]*exit code 2/);
      }
    });

    it('still accepts -y on remove, where there is nothing to confirm', async () => {
      expect((await run(['remove', 'agent-teams', '-p', 'web', '-y'])).code).toBe(0);
      expect(manifest().profiles.web.plugins).toEqual({});
    });
  });

  describe('renamed commands', () => {
    it('runs mark-restarted, and restarted still works', async () => {
      expect((await run(['mark-restarted'])).stdout).toMatch(/Cleared restart-required for 0 plugin/);
      expect((await run(['restarted'])).code).toBe(0);
    });

    it('runs remote sync, and the top-level sync still works', async () => {
      expect((await run(['remote', '--help'], false)).stdout).toMatch(/^\s+sync \[options\]/m);
      const remote = await run(['remote', 'sync']);
      const top = await run(['sync']);
      expect(remote.code).toBe(3);
      expect(remote.stderr).toMatch(/No remote is configured/);
      expect(top).toEqual(remote);
    });

    it('treats uninstall as remove', async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      expect((await run(['uninstall', 'agent-teams', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins).toEqual({});
    });
  });

  describe('list and overlays', () => {
    it('lists plugins as a table with a header, and says what to do when there are none', async () => {
      const empty = await run(['list']);
      expect(empty.stdout).toBe('No plugins declared. Add one with: dshenv install <spec> -p <profile>\n');

      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      const lines = (await run(['list'])).stdout.trimEnd().split('\n');
      expect(lines[0]).toMatch(/^PROFILE\s+ALIAS\s+PACKAGE\s+VERSION\s+ENABLED\s+INSTALLED$/);
      expect(lines[1]).toMatch(/^web\s+agent-teams\s+@nanmicoder\/dsh-agent-teams\s+0\.1\.21\s+yes\s+no$/);
    });

    it('creates an overlay that loads, refuses to overwrite one, and lists it', async () => {
      expect((await run(['overlay', 'list'])).stdout).toBe('No overlays. Create one with: dshenv overlay create <name>\n');

      const created = await run(['overlay', 'create', 'laptop']);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'));
      expect((await run(['plan', '--overlay', 'laptop'])).code).toBe(0);

      const again = await run(['overlay', 'create', 'laptop']);
      expect(again.code).toBe(3);
      expect(again.stderr).toMatch(/already exists/);
      expect((await run(['overlay', 'list'])).stdout).toBe('  laptop\n');
      expect((await run(['overlay', 'create', '../x'])).code).toBe(3);
    });
  });
});
