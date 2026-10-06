import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import { runCli } from '../../src/cli.js';
import { startFakeDshWeb, type FakeDshWeb } from '../helpers/fake-dsh-web.js';
import { alive, reaped } from '../helpers/process.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI web', () => {
  let tempHome: string;
  let fake: FakeDshWeb;
  let previousDshCli: string | undefined;
  let previousUrl: string | undefined;

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
  const recordFile = (profile = 'web') => path.join(tempHome, 'envctl', 'run', `${profile}.json`);
  const record = (profile = 'web') => JSON.parse(fs.readFileSync(recordFile(profile), 'utf8')) as { pid: number; url: string };
  // Windows has no process groups; there the fake dsh web is node itself, with nothing under it.
  const killDsh = (pid: number) => process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  const withEnv = async (name: string, value: string, fn: () => Promise<void>) => {
    const previous = process.env[name];
    process.env[name] = value;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  };
  // Stands in for dsh web: prints the fake server's URL like DSH does, then serves until stopped.
  const fakeDsh = (body: string, version = '0.1.7-rc.2'): void => {
    const file = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(file, `if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }\n${body}`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, file]);
  };
  const serving = () => fakeDsh(`console.log('dsh web: ${fake.url}'); setInterval(() => {}, 1000);`);

  beforeEach(async () => {
    previousDshCli = process.env.DSH_CLI;
    previousUrl = process.env.DSHENV_DSH_URL;
    delete process.env.DSHENV_DSH_URL;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-web-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams:\n        package: "${PKG}"\n        enabled: true\n        source: { type: npm, version: "0.1.21" }\n`
    );
    fs.mkdirSync(path.join(tempHome, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: { [PKG]: '0.1.21' } }));
    fake = await startFakeDshWeb({
      bundles: [{ name: PKG, version: '0.1.21', enabled: true, installed: true, optional: false, removable: true, rows: [{ rowId: 'agent-teams', moduleName: PKG, entryId: 'include:agent-teams' }], overrides: [] }],
      plugins: [{ entryId: 'include:agent-teams', moduleName: PKG, enabled: true, fiberPhase: 'active', patchId: 'agent-teams' }]
    });
  });

  afterEach(async () => {
    if (fs.existsSync(recordFile())) {
      try {
        killDsh(record().pid);
      } catch {
        // Already stopped.
      }
    }
    await fake.close();
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    if (previousUrl === undefined) delete process.env.DSHENV_DSH_URL;
    else process.env.DSHENV_DSH_URL = previousUrl;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('starts dsh web in the background, prints its URL once, and records it privately', async () => {
    serving();
    const started = await run(['web', 'start', '-p', 'web']);
    expect(started.code).toBe(0);
    expect(started.stdout).toMatch(/^Started dsh web for profile web \(pid \d+\)\n/);
    expect(started.stdout).toContain(`  URL: ${fake.url}\n`);
    expect(started.stdout).toContain(`  Log: ${path.join(tempHome, 'envctl', 'run', 'web.log')}\n`);
    expect(started.stdout).toContain('Stop it with: dshenv web stop -p web\n');
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32') expect(fs.statSync(recordFile()).mode & 0o777).toBe(0o600);
    expect(alive(record().pid)).toBe(true);

    const again = await run(['web', 'start', '-p', 'web']);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^dsh web for profile web is already running \(pid \d+\)\n/);
    expect(again.stdout).toContain(`  URL: ${fake.url}\n`);

    // Asked for another port, it says so rather than hand back the one it is on.
    const port = Number(new URL(fake.url).port);
    expect((await run(['web', 'start', '-p', 'web', '--port', String(port)])).code).toBe(0);
    const other = await run(['web', 'start', '-p', 'web', '--port', String(port === 65000 ? 65001 : 65000)]);
    expect(other.code).toBe(3);
    expect(other.stderr).toContain(`dsh web for profile web is already running on port ${port}; stop it first (dshenv web stop -p web) to start it on port`);
  });

  it('lets runtime use the dsh web it started when DSHENV_DSH_URL is not set', async () => {
    serving();
    await run(['web', 'start', '-p', 'web']);
    const out = await run(['runtime', '-p', 'web']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`  loaded  agent-teams  ${PKG}\n`);
    expect(out.stdout).not.toContain('SECRET-TOKEN-123');
  });

  it('reports status without the token, and stops dsh web with everything it started', async () => {
    serving();
    expect((await run(['web', 'status'])).stdout).toBe('No dsh web started by dshenv.\n');
    await run(['web', 'start', '-p', 'web']);
    const { pid } = record();

    const status = await run(['web', 'status']);
    expect(status.stdout).toBe(`web  running  pid ${pid}  ${fake.origin.replace('http://', '')}\n`);
    expect(status.stdout).not.toContain('SECRET-TOKEN-123');
    const json = JSON.parse((await run(['web', 'status', '--json'])).stdout);
    expect(json).toEqual({ webs: [expect.objectContaining({ profile: 'web', pid, running: true, endpoint: fake.origin.replace('http://', '') })] });
    expect(JSON.stringify(json)).not.toContain('SECRET-TOKEN-123');
    expect((await run(['web', 'status', '-p', 'web'])).stdout).toBe(status.stdout);
    fs.mkdirSync(path.join(tempHome, 'profiles', 'other'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', 'other', 'package.json'), '{}');
    expect((await run(['web', 'status', '-p', 'other'])).stdout).toBe('No dsh web started by dshenv for profile other.\n');
    expect(JSON.parse((await run(['web', 'status', '-p', 'other', '--json'])).stdout)).toEqual({ webs: [] });

    const stopped = await run(['web', 'stop', '-p', 'web']);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toBe(`Stopped dsh web for profile web (pid ${pid})\n`);
    expect(await reaped(pid)).toBe(true);
    expect(fs.existsSync(recordFile())).toBe(false);
    expect((await run(['web', 'stop', '-p', 'web'])).stdout).toBe('No dsh web started by dshenv is running for profile web.\n');
  });

  it('notices a dsh web that stopped on its own, and starts a new one in its place', async () => {
    serving();
    await run(['web', 'start', '-p', 'web']);
    const { pid } = record();
    killDsh(pid);
    expect(await reaped(pid)).toBe(true);

    expect((await run(['web', 'status'])).stdout).toBe(`web  not running  pid ${pid}\n`);
    const runtime = await run(['runtime', '-p', 'web']);
    expect(runtime.code).toBe(3);
    expect(runtime.stderr).toMatch(/DSHENV_DSH_URL is not set and no dsh web started by 'dshenv web start' is running for profile web/);

    const restarted = await run(['web', 'start', '-p', 'web']);
    expect(restarted.stdout).toMatch(/^Started dsh web/);
    expect(record().pid).not.toBe(pid);
    expect((await run(['web', 'stop', '-p', 'web'])).stdout).toMatch(/^Stopped/);
  });

  it('refuses a profile that does not exist yet and explains a profile without a web app', async () => {
    serving();
    const missing = await run(['web', 'start', '-p', 'nope']);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toBe("Profile 'nope' does not exist (known profiles: web)\n");

    fakeDsh(`console.error("error: unknown option '--no-open'"); process.exit(1);`);
    const headless = await run(['web', 'start', '-p', 'web']);
    expect(headless.code).toBe(1);
    expect(headless.stderr).toMatch(/did not start dsh web: error: unknown option '--no-open'/);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('passes a fixed port to dsh web', async () => {
    fakeDsh(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(tempHome, 'args.json'))}, JSON.stringify(process.argv.slice(2))); console.log('dsh web: ${fake.url}'); setInterval(() => {}, 1000);`);
    await run(['web', 'start', '-p', 'web', '--port', '3090']);
    expect(JSON.parse(fs.readFileSync(path.join(tempHome, 'args.json'), 'utf8'))).toEqual(['--profile', 'web', '--no-open', '--port', '3090']);
    expect((await run(['web', 'start', '-p', 'web', '--port', 'x'])).stderr).toMatch(/--port must be an integer from 0 to 65535/);
  });
  it('refuses a profile name that would leave the profiles or run directory', async () => {
    serving();
    fs.mkdirSync(path.join(tempHome, 'outside', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'outside', 'x', 'package.json'), '{}');
    fs.writeFileSync(path.join(tempHome, 'keep.json'), '{}');
    for (const args of [['web', 'start', '-p', '../outside/x'], ['web', 'stop', '-p', '../../keep'], ['web', 'start', '-p', '..']]) {
      const out = await run(args);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/Invalid profile name/);
    }
    expect(fs.existsSync(path.join(tempHome, 'keep.json'))).toBe(true);
  });

  it('starts one dsh web when two starts race, and the other reports it running', async () => {
    fakeDsh(`setTimeout(() => console.log('dsh web: ${fake.url}'), 300); setInterval(() => {}, 1000);`);
    const results = await Promise.all([run(['web', 'start', '-p', 'web']), run(['web', 'start', '-p', 'web'])]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.map((result) => result.stdout.split(' ')[0]).sort()).toEqual(['Started', 'dsh']);
    const { pid } = record();
    expect(results.every((result) => result.stdout.includes(`pid ${pid})`))).toBe(true);
  });

  it('recognizes its dsh web when ps would cut the command line to the terminal width', async () => {
    serving();
    await run(['web', 'start', '-p', 'web']);
    const { pid } = record();
    await withEnv('COLUMNS', '20', async () => {
      expect((await run(['web', 'status'])).stdout).toMatch(/^web {2}running {2}pid /);
      expect((await run(['web', 'stop', '-p', 'web'])).stdout).toBe(`Stopped dsh web for profile web (pid ${pid})\n`);
    });
    expect(await reaped(pid)).toBe(true);
  });

  it('leaves alone a process that later got the recorded pid, even where ps is missing', async () => {
    serving();
    await run(['web', 'start', '-p', 'web']);
    const stale = record();
    killDsh(stale.pid);
    expect(await reaped(stale.pid)).toBe(true);
    // Whatever gets the pid next, in a process group of its own like dsh web's.
    const other = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', reject: false });
    const otherPid = other.pid!;
    fs.writeFileSync(recordFile(), JSON.stringify({ ...stale, pid: otherPid }));
    try {
      await withEnv('PATH', path.join(tempHome, 'no-bin'), async () => {
        if (process.platform === 'linux') {
          // /proc still tells when the process started.
          expect((await run(['web', 'status'])).stdout).toBe(`web  not running  pid ${otherPid}\n`);
          expect((await run(['web', 'stop', '-p', 'web'])).stdout).toBe('No dsh web started by dshenv is running for profile web.\n');
        } else {
          // Without ps (or PowerShell) nothing tells when it started, so dshenv cannot rule out that it is dsh web.
          expect((await run(['web', 'status'])).stdout).toBe(`web  unknown (cannot tell whether the pid is still this dsh web)  pid ${otherPid}\n`);
          const stop = await run(['web', 'stop', '-p', 'web']);
          expect(stop.code).toBe(1);
          expect(stop.stderr).toMatch(new RegExp(`Cannot tell whether pid ${otherPid} is still the dsh web`));
          expect(fs.existsSync(recordFile())).toBe(true);
        }
      });
      expect(alive(otherPid)).toBe(true);
    } finally {
      other.kill('SIGKILL');
      await other;
    }
  });

  // Leftovers are told by the process group dsh web leads, which Windows does not have.
  it.skipIf(process.platform === 'win32')('treats what a crashed dsh web left behind as not running, and clears it before starting anew', async () => {
    const childPidFile = path.join(tempHome, 'child-pid');
    fakeDsh(`import { spawn } from 'node:child_process';
import fs from 'node:fs';
// Like an MCP server DSH started, it outlives a DSH that crashed.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
console.log('dsh web: ${fake.url}');
setInterval(() => {}, 1000);`);
    await run(['web', 'start', '-p', 'web']);
    const { pid } = record();
    const child = Number(fs.readFileSync(childPidFile, 'utf8'));
    process.kill(pid, 'SIGKILL');
    expect(await reaped(pid)).toBe(true);
    expect(alive(child)).toBe(true);

    expect((await run(['web', 'status'])).stdout).toBe(`web  not running (leftover processes)  pid ${pid}\n`);
    expect((await run(['runtime', '-p', 'web'])).code).toBe(3);
    const restarted = await run(['web', 'start', '-p', 'web']);
    expect(restarted.stdout).toMatch(/^Started dsh web/);
    expect(await reaped(child)).toBe(true);
    expect(record().pid).not.toBe(pid);
  });
  it('refuses to start a DSH version dshenv does not support, unless told to', async () => {
    const launched = path.join(tempHome, 'launched');
    fakeDsh(`import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(launched)}, '');\nconsole.log('dsh web: ${fake.url}');\nsetInterval(() => {}, 1000);`, '0.1.5');
    const refused = await run(['web', 'start', '-p', 'web']);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toMatch(/Unsupported DSH version 0\.1\.5: dshenv supports DSH 0\.1\.7/);
    expect(fs.existsSync(launched)).toBe(false);
    expect(fs.existsSync(recordFile())).toBe(false);

    const allowed = await run(['web', 'start', '-p', 'web', '--allow-untested-dsh']);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toMatch(/^Started dsh web/);
  });

  it('says a profile runs another app instead of starting DSH for it', async () => {
    const launched = path.join(tempHome, 'launched');
    fakeDsh(`import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(launched)}, '');\nprocess.exit(1);`);
    fs.mkdirSync(path.join(tempHome, 'profiles', 'headless'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'profiles', 'headless', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-headless', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } })
    );
    const out = await run(['web', 'start', '-p', 'headless']);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe(
      'Profile headless runs @deepseek-ai/dsh-headless, not dsh web; start dsh web for a profile whose bundles include @deepseek-ai/dsh-web-app\n'
    );
    expect(fs.existsSync(launched)).toBe(false);
  });
});
