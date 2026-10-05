import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

const DUMPS: Record<string, string> = {
  web: `- id: web
  name: '@deepseek-ai/dsh-web'
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
`,
  headless: `- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetchMaxOutputChars: 1000
`
};

describe('CLI tools', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const manifest = () => loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-tools-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    for (const profile of Object.keys(DUMPS)) {
      fs.mkdirSync(path.join(tempHome, 'profiles', profile), { recursive: true });
      fs.writeFileSync(path.join(tempHome, 'profiles', profile, 'package.json'), '{}');
    }
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
const args = process.argv.slice(2);
const dumps = ${JSON.stringify(DUMPS)};
if (args.includes('--dump-config')) { process.stdout.write(dumps[args[args.indexOf('--profile') + 1]]); process.exit(0); }
process.exit(1);
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('lists the tools an agent of the default preset gets, by category', async () => {
    const result = await run(['tools', 'list', '-p', 'web']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Tools in profile 'web', preset 'standard' (default)");
    expect(result.stdout).toMatch(/Terminal\n {2}~ tool-bash +@deepseek-ai\/dsh-tool-bash +off when process\.platform === 'win32'/);
    expect(result.stdout).toMatch(/Network\n {2}\+ tool-web/);

    const json = JSON.parse((await run(['tools', 'list', '-p', 'web', '--json'])).stdout);
    expect(json.tools).toContainEqual(expect.objectContaining({ id: 'tool-web', category: 'network', state: 'on' }));
  });

  it('refuses --preset with --all, which lists every preset already', async () => {
    const out = await run(['tools', 'list', '-p', 'web', '--all', '--preset', 'nosuch']);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/--all.*every preset.*--preset/);
  });

  it('turns a preset tool off by pinning the whole preset in the manifest, and plan says so', async () => {
    const result = await run(['tools', 'disable', 'tool-web', '-p', 'web']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Disabled tool 'tool-web' in preset 'standard' of profile 'web'/);
    expect(result.stdout).toMatch(/pinned.*DSH upgrades/);

    const [patch] = manifest().profiles.web.patches!;
    expect(patch).toMatchObject({ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset' });
    const plugins = (patch.config as { plugins: Record<string, unknown>[] }).plugins;
    expect(plugins[0].disabled).toEqual({ __jsExpr: "process.platform === 'win32'" });
    expect(plugins[1]).toMatchObject({ id: 'tool-web', disabled: true });

    expect((await run(['plan'])).stdout).toMatch(/Pinned agent presets[^\n]*\n {2}! \[web\] preset-standard/);
  });

  it('reads, sets and unsets a tool config with get, set and unset, like plugins config', async () => {
    const help = (await run(['tools', 'config', '--help'])).stdout;
    expect(help).toMatch(/^\s+get \[options\] <tool> \[dottedPath\]/m);
    expect(help).toMatch(/^\s+set \[options\] <tool> <dottedPath> <value>/m);
    expect(help).toMatch(/^\s+unset \[options\] <tool> <dottedPath>/m);
    expect(help).toMatch(/^Usage: dshenv tools config \[command\]$/m);

    expect((await run(['tools', 'config', 'get', 'tool-web', '-p', 'headless'])).stdout).toContain('"fetchMaxOutputChars": 1000');
    expect((await run(['tools', 'config', 'set', 'tool-web', 'search.maxResults', '3', '-p', 'headless'])).code).toBe(0);
    expect((await run(['tools', 'config', 'get', 'tool-web', 'search.maxResults', '-p', 'headless'])).stdout.trim()).toBe('3');

    const unset = await run(['tools', 'config', 'unset', 'tool-web', 'search', '-p', 'headless']);
    expect(unset.code).toBe(0);
    expect(unset.stdout).toContain("Removed search of tool 'tool-web'");
    expect(manifest().profiles.headless.patches).toEqual([{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetchMaxOutputChars: 1000 } }]);

    const missing = await run(['tools', 'config', 'unset', 'tool-web', 'nosuch', '-p', 'headless']);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain("The config of 'tool-web' has no 'nosuch'");
  });

  it('writes a small patch for a top-level tool and reads or sets its config', async () => {
    expect((await run(['tools', 'config', 'tool-web', '-p', 'headless'])).stdout).toContain('"fetchMaxOutputChars": 1000');
    const set = await run(['tools', 'config', 'tool-web', 'search.maxResults', '3', '-p', 'headless']);
    expect(set.code).toBe(0);
    expect(manifest().profiles.headless.patches).toEqual([
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetchMaxOutputChars: 1000, search: { maxResults: 3 } } }
    ]);
    expect((await run(['tools', 'config', 'tool-web', 'search.maxResults', '-p', 'headless'])).stdout.trim()).toBe('3');

    await run(['tools', 'disable', 'tool-web', '-p', 'headless']);
    expect(manifest().profiles.headless.patches).toEqual([
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetchMaxOutputChars: 1000, search: { maxResults: 3 } }, disabled: true }
    ]);
  });

  it('refuses a base-layer write the active overlay would override', async () => {
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlays', 'local.yaml'),
      `apiVersion: dshenv-overlay/v1
profiles:
  web:
    patches:
      - id: preset-standard
        name: '@deepseek-ai/dsh-agent-preset'
        config:
          id: standard
          machineOnly: /home/me
          plugins:
            - id: tool-web
              name: '@deepseek-ai/dsh-tool-web'
`
    );
    expect((await run(['tools', 'disable', 'tool-web', '-p', 'web', '--overlay', 'local'])).stderr).toMatch(/--layer base or --layer overlay/);
    // A wrong id is the first thing to fix, before choosing where to write it.
    expect((await run(['tools', 'disable', 'web', '-p', 'web', '--overlay', 'local'])).stderr).toMatch(/^'web' is not a tool in profile 'web'; did you mean 'tool-web'\?/);
    const refused = await run(['tools', 'disable', 'tool-web', '-p', 'web', '--overlay', 'local', '--layer', 'base']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/overlay 'local' declares 'preset-standard'.*--layer overlay/);
    expect(manifest().profiles.web.patches).toBeUndefined();

    const json = JSON.parse((await run(['tools', 'config', 'tool-web', 'x.y', '1', '-p', 'web', '--overlay', 'local', '--layer', 'overlay', '--json'])).stdout);
    expect(json.status).toBe('set');
  });

  describe('a base write does not copy into the shared base what DSH composes from elsewhere', () => {
    const LOCAL_ROW = `- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  config:\n    storeDir: /home/me/private\n`;
    const dumping = (dump: string) => {
      const fakeDsh = path.join(tempHome, 'fake-dsh-2.mjs');
      fs.writeFileSync(fakeDsh, `if (process.argv.includes('--dump-config')) { process.stdout.write(${JSON.stringify(dump)}); process.exit(0); }\nprocess.exit(1);\n`);
      process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
    };
    const manifestText = () => fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');

    it('refuses while a dshenv patch the base does not declare is in effect, as an applied overlay leaves it', async () => {
      dumping(LOCAL_ROW);
      fs.writeFileSync(
        path.join(tempHome, 'profiles', 'headless', 'cordis.patch.yml'),
        `# dshenv:begin profile=headless plugin=@profile digest=x\n- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  config:\n    storeDir: /home/me/private\n# dshenv:end profile=headless plugin=@profile\n`
      );
      const before = manifestText();
      const out = await run(['--no-overlay', 'tools', 'config', 'set', 'tool-web', 'foo', '1', '-p', 'headless']);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/holds a dshenv patch for 'tool-web' that the base manifest does not declare.*--layer overlay/);
      expect(manifestText()).toBe(before);
    });

    it('refuses to copy a machine-local path into the base', async () => {
      dumping(LOCAL_ROW);
      const before = manifestText();
      const out = await run(['tools', 'config', 'set', 'tool-web', 'foo', '1', '-p', 'headless']);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/machine-local paths.*--layer overlay/);
      expect(manifestText()).toBe(before);
    });
  });

  it('keeps both edits when two commands change the same preset at once', async () => {
    const results = await Promise.all([
      run(['tools', 'disable', 'tool-web', '-p', 'web']),
      run(['tools', 'enable', 'tool-bash', '-p', 'web'])
    ]);
    expect(results.map((result) => [result.code, result.stderr])).toEqual([[0, ''], [0, '']]);
    const plugins = (manifest().profiles.web.patches![0].config as { plugins: Record<string, unknown>[] }).plugins;
    expect(plugins).toEqual([
      expect.objectContaining({ id: 'tool-bash', disabled: false }),
      expect.objectContaining({ id: 'tool-web', disabled: true })
    ]);
  });

  it('refuses a profile that does not exist yet and a tool outside the composition', async () => {
    const missing = await run(['tools', 'list', '-p', 'nope']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/Profile 'nope' does not exist/);
    expect(fs.existsSync(path.join(tempHome, 'profiles', 'nope'))).toBe(false);

    const unknown = await run(['tools', 'enable', 'tool-lsp', '-p', 'web']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toMatch(/'tool-lsp' is not a tool in profile 'web'.*see dshenv tools list --all -p web/);
  });

  it('switches only the rows tools list shows, suggesting the closest tool for a typo', async () => {
    const layer = await run(['tools', 'disable', 'web', '-p', 'web']);
    expect(layer.code).toBe(3);
    expect(layer.stderr).toMatch(/^'web' is not a tool in profile 'web'; did you mean 'tool-web'\?/);
    const typo = await run(['tools', 'disable', 'tool-wbe', '-p', 'web']);
    expect(typo.code).toBe(3);
    expect(typo.stderr).toMatch(/did you mean 'tool-web'\?/);
    expect(manifest().profiles.web.patches).toBeUndefined();
  });

  it('resets a tool by dropping the patch that changes it', async () => {
    await run(['tools', 'disable', 'tool-web', '-p', 'web']);
    expect(manifest().profiles.web.patches).toHaveLength(1);
    const reset = await run(['tools', 'reset', 'tool-web', '-p', 'web']);
    expect(reset.code).toBe(0);
    expect(reset.stdout).toBe(
      "Removed patch 'preset-standard', which pinned preset 'standard': every tool change in that preset is reset. Next: dshenv plan, then dshenv apply --yes.\n"
    );
    expect(manifest().profiles.web.patches).toBeUndefined();
    const again = await run(['tools', 'reset', 'tool-web', '-p', 'web']);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/has no patch in the manifest; nothing to reset/);

    await run(['tools', 'disable', 'tool-web', '-p', 'headless']);
    expect(manifest().profiles.headless.patches?.map((patch) => patch.id)).toEqual(['tool-web']);
    expect((await run(['tools', 'reset', 'tool-web', '-p', 'headless'])).stdout).toMatch(/^Removed patch 'tool-web' for tool 'tool-web' in profile 'headless'/);
    expect(manifest().profiles.headless.patches).toBeUndefined();
  });

  it('resets a base patch in an overlay once, and a second reset leaves the tombstone in place', async () => {
    await run(['tools', 'disable', 'tool-web', '-p', 'headless']);
    const overlayFile = path.join(tempHome, 'envctl', 'overlays', 'local.yaml');
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.writeFileSync(overlayFile, 'apiVersion: dshenv-overlay/v1\n');
    const reset = (layer: string) => run(['tools', 'reset', 'tool-web', '-p', 'headless', '--overlay', 'local', '--layer', layer]);

    expect((await reset('overlay')).stdout).toMatch(/^Removed patch 'tool-web'/);
    const tombstoned = fs.readFileSync(overlayFile, 'utf8');
    expect(tombstoned).toMatch(/id: tool-web\n\s+remove: true/);
    // Dropping the tombstone would bring the base patch back while saying it was removed.
    const again = await reset('overlay');
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/nothing to reset/);
    expect(fs.readFileSync(overlayFile, 'utf8')).toBe(tombstoned);
    // A tombstone is not an overlay patch the base write would hide, so the base can be cleaned up too.
    expect((await reset('base')).code).toBe(0);
    expect(manifest().profiles.headless?.patches).toBeUndefined();
  });

  it('leaves an overlay untouched when it has nothing to reset', async () => {
    const overlayFile = path.join(tempHome, 'envctl', 'overlays', 'local.yaml');
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.writeFileSync(overlayFile, 'apiVersion: dshenv-overlay/v1\n');
    const out = await run(['tools', 'reset', 'tool-web', '-p', 'headless', '--overlay', 'local', '--layer', 'overlay']);
    expect(out.stdout).toMatch(/nothing to reset/);
    expect(fs.readFileSync(overlayFile, 'utf8')).toBe('apiVersion: dshenv-overlay/v1\n');
  });

  it('refuses a config key the tool does not have, like config get', async () => {
    const out = await run(['tools', 'config', 'tool-web', 'fetchMaxOutputChar', '-p', 'headless']);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/has no 'fetchMaxOutputChar'; did you mean 'fetchMaxOutputChars'\?/);
    const json = await run(['tools', 'config', 'tool-web', 'nosuch', '-p', 'headless', '--json']);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.stderr).error).toMatchObject({ type: 'ValidationError', exitCode: 3 });
  });
});
