import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

// A fake dsh that, like DSH's loadProfile, creates a missing profile only for a template name and refuses any other.
const FAKE_DSH = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.2.0-rc.2'); process.exit(0); }
if (!args.includes('--dump-config')) process.exit(1);
const profile = args[args.indexOf('--profile') + 1];
const dir = path.join(process.env.DSH_HOME, 'profiles', profile);
const templates = { web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] };
if (!fs.existsSync(path.join(dir, 'package.json'))) {
  if (!templates[profile]) {
    process.stderr.write('Error: dsh: profile "' + profile + '" does not exist; create it with \\'dsh plugin --profile ' + profile + ' add <package>\\'\\n');
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: templates[profile] } } }, null, 2));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\\n');
}
fs.writeFileSync(path.join(dir, 'cordis.yml'), '[]\\n');
process.stdout.write('- id: hmr\\n  disabled: true\\n- id: agent-team\\n');
`;

const TEAM = '@deepseek-ai/dsh-experimental-agent-team-profile';

describe('CLI apply has DSH create a template profile that does not exist yet', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;
  const profileDir = (name: string) => path.join(tempHome, 'profiles', name);
  const writeManifest = (body: string) => fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), `apiVersion: dshenv/v1\n${body}`);
  const team = (profile: string) => `profiles:\n  ${profile}:\n    plugins:\n      team: { package: "${TEAM}", source: { type: in-box } }\n`;

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
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-create-profile-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    const fakeDsh = path.join(tempHome, 'fake-dsh.cjs');
    fs.writeFileSync(fakeDsh, FAKE_DSH);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('previews the creation without creating anything, then creates it and selects the bundle after the template ones', async () => {
    writeManifest(`${team('web')}    patches:\n      - id: agent-team\n        config: { maxMembers: 3 }\n`);

    const preview = await run(['apply']);
    expect(preview.code).toBe(2);
    expect(preview.stdout).toContain('Profiles DSH creates from its own template first:\n  + web\n');
    expect(preview.stdout).not.toContain('BLOCKED');
    expect(fs.existsSync(profileDir('web'))).toBe(false);

    const applied = await run(['apply', '--yes']);
    expect(applied.code).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir('web'), 'package.json'), 'utf8'));
    expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', TEAM]);
    expect(pkg.dependencies).toEqual({});
    expect(fs.readFileSync(path.join(profileDir('web'), 'cordis.patch.yml'), 'utf8')).toContain('maxMembers: 3');

    const plan = await run(['plan']);
    expect(plan.code).toBe(0);
  });

  it.each([
    ['corrupt', '{ not json'],
    ['without dsh.profile', JSON.stringify({ name: 'p', dependencies: {} })],
    ['missing', null]
  ])('blocks a template profile whose directory exists with a %s package.json instead of creating it', async (_label, pkg) => {
    writeManifest(`${team('web')}    patches:\n      - id: agent-team\n        config: { maxMembers: 3 }\n`);
    fs.mkdirSync(path.join(profileDir('web'), 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(profileDir('web'), 'sessions', 's1.json'), '{}');
    if (pkg !== null) fs.writeFileSync(path.join(profileDir('web'), 'package.json'), pkg);

    const preview = await run(['apply']);
    expect(preview.stdout).not.toContain('Profiles DSH creates from its own template first');
    expect(preview.stdout).toContain('BLOCKED');
    expect(preview.stdout).toContain(`Profile 'web' exists at ${profileDir('web')}`);

    const out = await run(['apply', '--yes']);
    expect(out.code).toBe(5);
    expect(out.stderr).toContain(`Profile 'web' exists at ${profileDir('web')}`);
    expect(fs.existsSync(path.join(profileDir('web'), 'sessions', 's1.json'))).toBe(true);
  });

  it('still blocks a profile whose name DSH has no template for, and says how to create it', async () => {
    writeManifest(team('mine'));
    const out = await run(['apply', '--yes']);
    expect(out.code).toBe(5);
    expect(out.stderr).toContain("Profile 'mine' does not exist yet");
    expect(out.stderr).toContain('DSH creates only its template profiles (acp, headless, sdk, sdk-minimal, web) by itself');
    expect(fs.existsSync(profileDir('mine'))).toBe(false);
  });
});
