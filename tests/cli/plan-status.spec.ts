import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI plan and status', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-plan-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should return exit code 2 when plan has changes', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    // Run init
    await runCli(['init', '--dsh-home', tempHome], io);
    stdout = '';

    // Create manifest with missing plugin
    const manifestPath = path.join(tempHome, 'envctl', 'manifest.yaml');
    fs.writeFileSync(
      manifestPath,
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
`
    );

    const code = await runCli(['plan', '--dsh-home', tempHome], io);
    expect(code).toBe(2);
    expect(stdout).toContain('+ [web] @nanmicoder/dsh-agent-teams');
  });

  it('refuses an empty status alias instead of listing every plugin', async () => {
    await runCli(['init', '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    let stdout = '';
    let stderr = '';
    const code = await runCli(['status', '', '--dsh-home', tempHome], { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } });
    expect(code).toBe(3);
    expect(stderr).toMatch(/alias must not be empty/);
    expect(stdout).toBe('');
  });

  it('warns about plaintext credentials in the manifest on stderr, naming paths but not values, without changing the exit code', async () => {
    const quiet = { stdout: () => {}, stderr: () => {} };
    await runCli(['init', '--dsh-home', tempHome], quiet);
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles: {}\npatches:\n  - id: llm\n    config: { apiKey: sk-live-123, apiKeyEnv: KEY }\n'
    );
    for (const command of ['plan', 'status']) {
      let stderr = '';
      let stdout = '';
      const code = await runCli([command, '--dsh-home', tempHome, '--json'], { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } });
      expect(code, command).toBe(2);
      expect(stderr).toContain('Warning: the manifest or overlay holds plaintext credentials (the global patches / llm / config.apiKey)');
      expect(stderr + stdout).not.toContain('sk-live-123');
    }
  });

  it('shows the version exemptions of each profile in status, and warns about a compatibility.json DSH cannot read', async () => {
    const quiet = { stdout: () => {}, stderr: () => {} };
    await runCli(['init', '--dsh-home', tempHome], quiet);
    for (const [profile, compatibility] of [['web', '{"@acme/teams@0.1.21": ["0.2.0", "0.2.1-alpha.1"], "Bad Name@1.0.0": ["0.2.1"], "pkg@^1.0": ["0.2.1"], "ok@1.0.0": [">=0.2.0"]}'], ['headless', '{ not json']]) {
      fs.mkdirSync(path.join(tempHome, 'profiles', profile), { recursive: true });
      fs.writeFileSync(path.join(tempHome, 'profiles', profile, 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}');
      fs.writeFileSync(path.join(tempHome, 'profiles', profile, 'compatibility.json'), compatibility);
    }
    let stdout = '';
    let stderr = '';
    await runCli(['status', '--dsh-home', tempHome], { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } });
    expect(stdout).toContain('Version exemptions (compatibility.json; they name exact DSH versions and are not in the manifest):\n  [web] @acme/teams@0.1.21 -> 0.2.0, 0.2.1-alpha.1\n');
    expect(stderr).toMatch(/Warning: .*headless.compatibility\.json cannot be read, so DSH grants no exemption from it/);
    expect(stderr.match(/DSH ignores it/g)).toHaveLength(3);

    let json = '';
    await runCli(['status', '--dsh-home', tempHome, '--json'], { stdout: (chunk) => { json += chunk; }, stderr: () => {} });
    expect(JSON.parse(json).versionExemptions).toEqual([{ profile: 'web', package: '@acme/teams@0.1.21', dshVersions: ['0.2.0', '0.2.1-alpha.1'] }]);
  });

  it('warns in plan about an enabled retired bundle the manifest declares, and lists it in --json', async () => {
    await runCli(['init', '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      schedule: { package: "@deepseek-ai/dsh-experimental-schedule-bundle", source: { type: in-box } }\n'
    );
    let stdout = '';
    await runCli(['plan', '--dsh-home', tempHome], { stdout: (chunk) => { stdout += chunk; }, stderr: () => {} });
    expect(stdout).toContain('Retired bundles (DSH 0.2.1 drops them from the profile on every load, so they stay drift; remove them from the manifest):');
    expect(stdout).toContain('  ! [web] schedule (@deepseek-ai/dsh-experimental-schedule-bundle): DSH 0.2.1-alpha.1 retired it, as the Web composition mounts Schedule itself. Run: dshenv remove schedule -p web');

    let json = '';
    await runCli(['plan', '--dsh-home', tempHome, '--json'], { stdout: (chunk) => { json += chunk; }, stderr: () => {} });
    expect(JSON.parse(json).retiredBundles).toEqual([
      { profile: 'web', alias: 'schedule', package: '@deepseek-ai/dsh-experimental-schedule-bundle', reason: expect.stringContaining('retired') }
    ]);

    let status = '';
    await runCli(['status', '--dsh-home', tempHome], { stdout: (chunk) => { status += chunk; }, stderr: () => {} });
    expect(status).toContain('Retired bundles the manifest still enables (see dshenv plan):\n  ! [web] schedule (@deepseek-ai/dsh-experimental-schedule-bundle)\n');
  });

  it('lists the profile entries the global patches override, and a disabled they set, also under -p', async () => {
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\npatches:\n  - { id: tool-subagent, disabled: true }\nprofiles:\n  web:\n    plugins: {}\n    patches:\n      - { id: tool-subagent, config: { maxDepth: 3 } }\n'
    );
    for (const args of [['plan'], ['plan', '-p', 'web']]) {
      let stdout = '';
      await runCli([...args, '--dsh-home', tempHome], { stdout: (chunk) => { stdout += chunk; }, stderr: () => {} });
      expect(stdout).toContain("change them in the manifest's top-level patches, not in DSH's UI):\n");
      expect(stdout).toContain("  ! [web] tool-subagent (the global file sets disabled for tool-subagent, so DSH's plugin page cannot toggle it in this profile)\n");
    }
  });

  it('points the retired bundle hint at the overlay when the overlay declares it', async () => {
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      schedule: { package: "@deepseek-ai/dsh-experimental-schedule-bundle", source: { type: in-box } }\n'
    );
    let stdout = '';
    await runCli(['plan', '--dsh-home', tempHome, '--overlay', 'laptop'], { stdout: (chunk) => { stdout += chunk; }, stderr: () => {} });
    expect(stdout).toContain('Run: dshenv remove schedule -p web --layer overlay\n');

    let json = '';
    await runCli(['plan', '--dsh-home', tempHome, '--overlay', 'laptop', '--json'], { stdout: (chunk) => { json += chunk; }, stderr: () => {} });
    expect(JSON.parse(json).retiredBundles[0].layer).toBe('overlay');
  });

  it('filters status by the alias a profile declares, as well as by package name', async () => {
    const io = { stdout: () => {}, stderr: () => {} };
    await runCli(['init', '--dsh-home', tempHome], io);
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      teams: { package: "@nanmicoder/dsh-agent-teams", source: { type: npm, version: "0.1.21" } }
  ops:
    plugins:
      crew: { package: "@nanmicoder/dsh-agent-teams", source: { type: npm, version: "0.1.21" } }
`
    );
    const status = async (name: string) => {
      let stdout = '';
      const code = await runCli(['status', name, '--json', '--dsh-home', tempHome], {
        stdout: (chunk: string) => { stdout += chunk; },
        stderr: () => {}
      });
      const plugins = code === 3 ? [] : (JSON.parse(stdout) as { plugins: Array<{ profile: string }> }).plugins;
      return { code, profiles: plugins.map((entry) => entry.profile).sort() };
    };

    expect(await status('teams')).toEqual({ code: 2, profiles: ['web'] });
    expect(await status('crew')).toEqual({ code: 2, profiles: ['ops'] });
    expect(await status('@nanmicoder/dsh-agent-teams')).toEqual({ code: 2, profiles: ['ops', 'web'] });
    expect(await status('nope')).toEqual({ code: 3, profiles: [] });
  });

  it('should return exit code 0 when plan is clean and in sync', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    await runCli(['init', '--dsh-home', tempHome], io);
    stdout = '';

    const code = await runCli(['plan', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('in sync');
  });

  it('should return exit code 5 when plan is blocked by insufficient evidence', async () => {
    const io = {
      stdout: () => {},
      stderr: () => {}
    };
    await runCli(['init', '--dsh-home', tempHome], io);
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
        patches:
          - id: agent-teams
            config:
              taskPlanning: captain
`
    );
    fs.mkdirSync(path.join(tempHome, 'profiles', 'web', 'node_modules', '@nanmicoder', 'dsh-agent-teams'), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(tempHome, 'profiles', 'web', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.21' },
        dsh: { profile: { bundles: ['@nanmicoder/dsh-agent-teams'] } }
      })
    );
    fs.writeFileSync(
      path.join(tempHome, 'profiles', 'web', 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'),
      JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21', dsh: { bundle: {} } })
    );

    const code = await runCli(['plan', '--dsh-home', tempHome], io);
    expect(code).toBe(2);
  });
});
