import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { createEnvironmentSnapshot } from '../../src/io/backup.js';
import { appendJournalEntry } from '../../src/io/journal.js';
import { acquireEnvironmentLock } from '../../src/io/lock.js';

describe('CLI apply', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-apply-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });

    fs.writeFileSync(
      path.join(managerDir, 'manifest.yaml'),
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

    fs.writeFileSync(
      path.join(managerDir, 'lock.json'),
      `{
  "apiVersion": "dshenv-lock/v1",
  "profiles": {
    "web": {
      "plugins": {
        "agent-teams": {
          "package": "@nanmicoder/dsh-agent-teams",
          "source": {
            "type": "npm",
            "resolvedVersion": "0.1.21"
          }
        }
      }
    }
  }
}`
    );

    fs.writeFileSync(
      path.join(managerDir, 'state.json'),
      `{
  "apiVersion": "dshenv-state/v1",
  "lastApplied": "2026-01-01T00:00:00.000Z",
  "appliedLockHash": "",
  "profiles": {}
}`
    );
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function configureFakeDsh(): void {
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.7-rc.2');
  process.exit(0);
}
const profile = args[args.indexOf('--profile') + 1];
const spec = args.at(-1);
const packageName = spec.slice(0, spec.indexOf('@', 1));
const version = spec.slice(packageName.length + 1);
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const packageDir = path.join(profileDir, 'node_modules', ...packageName.split('/'));
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-' + profile,
  private: true,
  dependencies: { [packageName]: version },
  dsh: { profile: { bundles: [packageName] } }
}));
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version, dsh: { bundle: {} } }));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  }

  it('should support dry-run apply via CLI apply --dry-run', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['apply', '--dry-run', '--dsh-home', tempHome], io);
    expect(code).toBe(2);
    expect(stdout).toMatch(/^\[DRY-RUN\] Planned operations:\n/);
    expect(stdout.match(/Planned operations:/g)).toHaveLength(1);
    expect(stdout).toContain('@nanmicoder/dsh-agent-teams');
  });

  it('should apply changes via CLI apply --yes', async () => {
    configureFakeDsh();
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['apply', '--yes', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('Successfully applied');
    // What ran, not what was planned.
    expect(stdout).toContain('Applied operations:\n  + [web] @nanmicoder/dsh-agent-teams');
    expect(stdout).not.toContain('Planned operations');
    const profile = JSON.parse(fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8'));
    expect(profile.dependencies).toEqual({ '@nanmicoder/dsh-agent-teams': '0.1.21' });
  });

  describe('after an apply that was killed before it finished', () => {
    const operationId = 'apply-0123456789ab';
    const run = async (args: string[]) => {
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      return { code, stderr };
    };
    const warning =
      `Warning: the previous apply ${operationId} was interrupted, so state.json may have lost which plugins need a DSH restart; ` +
      'run dshenv apply --yes again, then restart DSH';

    beforeEach(async () => {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      await createEnvironmentSnapshot(paths, operationId);
      await appendJournalEntry(paths, { operationId, type: 'apply-started', timestamp: new Date().toISOString() });
    });

    it('warns on plan, status and apply until an apply finishes', async () => {
      configureFakeDsh();
      expect(await run(['plan'])).toMatchObject({ code: 2, stderr: expect.stringContaining(warning) });
      expect((await run(['status'])).stderr).toContain(warning);
      const applied = await run(['apply', '--yes']);
      expect(applied.code).toBe(0);
      expect(applied.stderr).toContain(warning);
      expect((await run(['plan'])).stderr).not.toContain('Warning: the previous apply');
    });

    it('does not take a running apply for an interrupted one', async () => {
      const handle = await acquireEnvironmentLock(resolveEnvironmentPaths({ cliDshHome: tempHome }));
      try {
        expect((await run(['plan'])).stderr).not.toContain('Warning: the previous apply');
      } finally {
        await handle.release();
      }
      expect((await run(['plan'])).stderr).toContain(warning);
    });
  });

  it('only previews apply without --yes', async () => {
    configureFakeDsh();
    let stderr = '';
    const io = {
      stdout: () => {},
      stderr: (chunk: string) => {
        stderr += chunk;
      }
    };

    const code = await runCli(['apply', '--dsh-home', tempHome], io);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Re-run with --yes to apply/);
    expect(fs.existsSync(path.join(tempHome, 'profiles', 'web', 'package.json'))).toBe(false);
  });
});
