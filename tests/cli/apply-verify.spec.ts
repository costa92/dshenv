import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { startFakeDshWeb, type FakeDshWeb, type FakeDshWebOptions } from '../helpers/fake-dsh-web.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI apply --verify', () => {
  let tempHome: string;
  let fake: FakeDshWeb | undefined;
  let previousUrl: string | undefined;
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

  const bundle = (overrides: Record<string, unknown> = {}) => ({
    name: PKG,
    version: '0.1.21',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [{ rowId: 'agent-teams', moduleName: PKG, entryId: 'include:agent-teams' }],
    overrides: [],
    ...overrides
  });
  const entry = (fiberPhase: string | null) => ({ entryId: 'include:agent-teams', moduleName: PKG, enabled: true, fiberPhase, patchId: 'agent-teams' });

  const serve = async (options: FakeDshWebOptions): Promise<void> => {
    fake = await startFakeDshWeb(options);
    process.env.DSHENV_DSH_URL = fake.url;
  };

  beforeEach(() => {
    previousUrl = process.env.DSHENV_DSH_URL;
    previousDshCli = process.env.DSH_CLI;
    delete process.env.DSHENV_DSH_URL;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-apply-verify-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams:\n        package: "${PKG}"\n        enabled: true\n        source: { type: npm, version: "0.1.21" }\n`
    );
    // Installed but not in the bundle list, so apply enables it without installing anything.
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', ...PKG.split('/')), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', ...PKG.split('/'), 'package.json'), JSON.stringify({ name: PKG, version: '0.1.21', dsh: { bundle: {} } }));
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { [PKG]: '0.1.21' }, dsh: { profile: { bundles: [] } } }));
    // Fake dsh that reports hot reload on.
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    const dump = "- id: hmr\n  name: '@deepseek-ai/dsh-hmr'\n  disabled: !!js '!ctx.get(''profileContext'')'\n";
    fs.writeFileSync(fakeDsh, `
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
if (args.includes('--dump-config')) { process.stdout.write(${JSON.stringify(dump)}); process.exit(0); }
process.exit(1);
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    if (previousUrl === undefined) delete process.env.DSHENV_DSH_URL;
    else process.env.DSHENV_DSH_URL = previousUrl;
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('checks the applied profile in its running dsh web and exits 0 once the plugin is loaded', async () => {
    await serve({ bundles: [bundle()], plugins: [entry('active')] });
    const out = await run(['apply', '--yes', '--verify']);
    expect(out.code).toBe(0);
    expect(out.stdout.indexOf('Successfully applied changes')).toBeLessThan(out.stdout.indexOf('Runtime check for profile web'));
    expect(out.stdout).toContain(`  loaded  agent-teams  ${PKG}\n`);
    expect(`${out.stdout}${out.stderr}`).not.toContain('SECRET-TOKEN-123');
  });

  it('refuses an invalid --verify-timeout before applying anything', async () => {
    const lockFile = path.join(tempHome, 'envctl', 'lock.json');
    const before = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null;
    for (const value of ['', 'abc', '-1', '1e3', '5s']) {
      const out = await run(['apply', '--yes', '--verify', '--verify-timeout', value]);
      expect(out.code, value).toBe(3);
      expect(out.stderr).toContain(`Invalid --verify-timeout value: ${value}`);
    }
    expect(fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null).toBe(before);
  });

  it('waits up to --verify-timeout for DSH to hot-reload, then exits 2 while the plugin is still loading', async () => {
    await serve({ bundles: [bundle()], plugins: [entry('loading')] });
    const started = Date.now();
    const out = await run(['apply', '--yes', '--verify', '--verify-timeout', '1']);
    expect(out.code).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(out.stdout).toContain('loading');
    const lists = fake!.requests.filter((request) => JSON.stringify(request.body ?? '').includes('listPlugins'));
    expect(lists.length).toBeGreaterThan(1);
  });

  it('has verify wait the same way with --timeout, and check once without it', async () => {
    await serve({ bundles: [bundle()], plugins: [entry('loading')] });
    const lists = () => fake!.requests.filter((request) => JSON.stringify(request.body ?? '').includes('listPlugins')).length;

    const once = await run(['verify', '-p', 'web']);
    expect(once.code).toBe(2);
    expect(lists()).toBe(1);

    const started = Date.now();
    const waited = await run(['verify', '-p', 'web', '--timeout', '1']);
    expect(waited.code).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(lists()).toBeGreaterThan(2);

    expect((await run(['verify', '-p', 'web', '--timeout', 'soon'])).code).toBe(3);
  });

  it('exits 5 at once when the applied plugin failed to load, since hot reload will not change that', async () => {
    await serve({ bundles: [bundle()], plugins: [entry('failed')] });
    const started = Date.now();
    expect((await run(['apply', '--yes', '--verify', '--verify-timeout', '5'])).code).toBe(5);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('keeps asking about a plugin that owes a restart, since DSH may still hot-reload it, and reports it at the timeout', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'state.json'),
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '', appliedLockHash: '', profiles: { web: { plugins: { [PKG]: { package: PKG, status: 'restart-required' } } } } })
    );
    await serve({ bundles: [bundle({ enabled: false })], plugins: [] });
    const out = await run(['apply', '--yes', '--verify', '--verify-timeout', '1']);
    expect(out.code).toBe(5);
    expect(out.stdout).toContain('not-loaded');
    const lists = fake!.requests.filter((request) => JSON.stringify(request.body ?? '').includes('listPlugins'));
    expect(lists.length).toBeGreaterThan(1);
  });

  it('says a profile was not verified when no dsh web runs for it, and keeps the apply exit code', async () => {
    const out = await run(['apply', '--yes', '--verify']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Successfully applied changes');
    expect(out.stderr).toContain('Not verified: no dsh web is running for profile web; run dshenv web start -p web, or set DSHENV_DSH_URL');
  });

  it('does not check every changed profile against the one dsh web DSHENV_DSH_URL names', async () => {
    fs.appendFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `  cli:\n    plugins:\n      agent-teams:\n        package: "${PKG}"\n        enabled: true\n        source: { type: npm, version: "0.1.21" }\n`
    );
    fs.cpSync(path.join(tempHome, 'profiles', 'web'), path.join(tempHome, 'profiles', 'cli'), { recursive: true });
    await serve({ bundles: [bundle()], plugins: [entry('active')] });
    const out = await run(['--json', 'apply', '--yes', '--verify']);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout) as { verify: Array<{ profile: string; skipped?: string }> };
    expect(parsed.verify.map((item) => item.profile).sort()).toEqual(['cli', 'web']);
    for (const item of parsed.verify) {
      expect(item.skipped).toContain('DSHENV_DSH_URL names one dsh web');
    }
    expect(fake!.requests).toHaveLength(0);
  });

  it('adds the checks to --json output', async () => {
    await serve({ bundles: [bundle()], plugins: [entry('active')] });
    const out = await run(['--json', 'apply', '--yes', '--verify']);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout) as { applied: boolean; verify: unknown };
    expect(parsed.applied).toBe(true);
    expect(parsed.verify).toEqual([
      { profile: 'web', endpoint: new URL(fake!.origin).host, results: [{ alias: 'agent-teams', package: PKG, expected: 'enabled', result: 'loaded' }] }
    ]);
  });

  it('refuses --verify without --yes, since a preview changes nothing to verify', async () => {
    const out = await run(['apply', '--verify']);
    expect(out.code).toBe(3);
    expect(out.stderr).toContain('--verify checks what apply --yes changed');
  });

  it('refuses --verify with --dry-run even when --yes is given', async () => {
    const out = await run(['apply', '--dry-run', '--yes', '--verify']);
    expect(out.code).toBe(3);
    expect(out.stderr).toContain('--verify cannot be used with --dry-run');
  });

  it('passes --allow-remote on to the check of a non-loopback dsh web', async () => {
    process.env.DSHENV_DSH_URL = 'http://10.0.0.5:3080/?token=SECRET-TOKEN-123';
    // Allowed, the plain-http check comes next, before anything is sent.
    const allowed = await run(['--json', 'apply', '--yes', '--verify', '--allow-remote']);
    expect(allowed.stdout).toContain('over plain http');
    expect(`${allowed.stdout}${allowed.stderr}`).not.toContain('SECRET-TOKEN-123');
    expect((await run(['apply', '--yes', '--allow-remote'])).stderr).toContain('--allow-remote applies only with --verify');
  });
});
