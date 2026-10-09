import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HMR_PROBE_TIMEOUT_MS, parseHmrFromDump, probeProfileHmr } from '../../src/dsh/hmr.js';
import { resolveDshCommand } from '../../src/dsh/command.js';
import { reaped } from '../helpers/process.js';

const header = `# == @deepseek-ai/dsh-base
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
`;

const dumpWithHmr = (disabledLine: string): string => `${header}- id: hmr
  name: '@deepseek-ai/dsh-hmr'
${disabledLine}  config:
    root: []
- id: llm
  name: '@deepseek-ai/dsh-llm'
  config:
    mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'
    url: !!js >-
      process.env.DSH_URL
`;

describe('parseHmrFromDump', () => {
  it('reads the npm 0.1.7-rc.2 row with a !!js profileContext expression as on', () => {
    expect(parseHmrFromDump(dumpWithHmr("  disabled: !!js '!ctx.get(''profileContext'')'\n"))).toEqual({ state: 'on' });
  });

  it('ignores quote and whitespace differences in the profileContext expression', () => {
    expect(parseHmrFromDump(dumpWithHmr('  disabled: !!js "! ctx.get( \\"profileContext\\" )"\n'))).toEqual({ state: 'on' });
  });

  it('treats a row without disabled as on', () => {
    expect(parseHmrFromDump(dumpWithHmr(''))).toEqual({ state: 'on' });
  });

  it('treats disabled: false as on', () => {
    expect(parseHmrFromDump(dumpWithHmr('  disabled: false\n'))).toEqual({ state: 'on' });
  });

  it('treats disabled: true as off', () => {
    expect(parseHmrFromDump(dumpWithHmr('  disabled: true\n'))).toEqual({ state: 'off' });
  });

  it('treats a dump without an hmr row as off', () => {
    expect(parseHmrFromDump(header)).toEqual({ state: 'off' });
  });

  it('only matches a top-level row with id hmr', () => {
    const nested = `- id: group
  name: group
  config:
    children:
      - id: hmr
        name: '@deepseek-ai/dsh-hmr'
`;
    expect(parseHmrFromDump(nested)).toEqual({ state: 'off' });
  });

  it('reports any other expression as unknown', () => {
    expect(parseHmrFromDump(dumpWithHmr("  disabled: !!js process.env.NO_HMR === '1'\n"))).toEqual({
      state: 'unknown',
      reason: 'unrecognized hmr disabled value'
    });
  });

  it('reports any other plain value as unknown', () => {
    expect(parseHmrFromDump(dumpWithHmr('  disabled: sometimes\n'))).toEqual({
      state: 'unknown',
      reason: 'unrecognized hmr disabled value'
    });
  });

  it('reports invalid YAML as unknown with the first line of the parse error', () => {
    const status = parseHmrFromDump('- id: hmr\n  name: [unclosed\n');
    expect(status.state).toBe('unknown');
    if (status.state === 'unknown') {
      expect(status.reason).not.toContain('\n');
      expect(status.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports output that is not a list as unknown', () => {
    expect(parseHmrFromDump('hmr: true\n')).toEqual({
      state: 'unknown',
      reason: 'dump-config output is not a list of plugin rows'
    });
  });
});

describe('probeProfileHmr', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-hmr-probe-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fakeDsh = (body: string): { file: string; args: string[] } => {
    const script = path.join(dir, 'fake-dsh.mjs');
    fs.writeFileSync(script, body);
    return { file: process.execPath, args: [script] };
  };

  it('runs dsh --profile <p> --dump-config with DSH_HOME and parses the hmr row', async () => {
    const argsFile = path.join(dir, 'args.json');
    const command = fakeDsh(`
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.DSH_HOME }));
process.stdout.write(${JSON.stringify(dumpWithHmr("  disabled: !!js '!ctx.get(''profileContext'')'\n"))});
`);
    expect(await probeProfileHmr('web', { command, dshHome: dir })).toEqual({ state: 'on' });
    expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toEqual({ args: ['--profile', 'web', '--dump-config'], home: dir });
  });

  it('reports a missing DSH CLI as unknown', async () => {
    expect(await probeProfileHmr('web', { command: null, dshHome: dir })).toEqual({
      state: 'unknown',
      reason: 'DSH CLI was not found'
    });
  });

  it('reports a non-zero exit as unknown with the first stderr line', async () => {
    const command = fakeDsh(`process.stderr.write('\\nunknown option --dump-config\\nsecond line\\n'); process.exit(1);`);
    expect(await probeProfileHmr('web', { command, dshHome: dir })).toEqual({
      state: 'unknown',
      reason: 'unknown option --dump-config'
    });
  });

  // Windows runs the missing command through cmd.exe, which reports it in its own words instead of ENOENT.
  it.skipIf(process.platform === 'win32')('reports a command that cannot start as unknown', async () => {
    expect(await probeProfileHmr('web', { command: { file: path.join(dir, 'missing-dsh'), args: [] }, dshHome: dir })).toEqual({
      state: 'unknown',
      reason: 'failed to start dsh (ENOENT)'
    });
  });

  it('never puts the command line into the reason, since DSH_CLI args can carry credentials', async () => {
    const secretArgs = ['--Authorization', "'Bearer SECRET'"];
    const silentExit = fakeDsh(`process.exit(3);`);
    expect(
      await probeProfileHmr('web', { command: { ...silentExit, args: [...silentExit.args, ...secretArgs] }, dshHome: dir })
    ).toEqual({ state: 'unknown', reason: 'dsh --dump-config exited with code 3' });
    const missing = await probeProfileHmr('web', { command: { file: path.join(dir, 'missing-dsh'), args: secretArgs }, dshHome: dir });
    expect(JSON.stringify(missing)).not.toContain('SECRET');
  });

  // Windows has no signals to name; a killed process there just exits.
  it.skipIf(process.platform === 'win32')('names the signal when dsh is killed without writing stderr', async () => {
    const command = fakeDsh(`process.kill(process.pid, 'SIGKILL');`);
    expect(await probeProfileHmr('web', { command, dshHome: dir })).toEqual({
      state: 'unknown',
      reason: 'dsh --dump-config was killed by SIGKILL'
    });
  });

  it('reports a timeout as unknown', async () => {
    const command = fakeDsh(`setTimeout(() => {}, 10000);`);
    expect(await probeProfileHmr('web', { command, dshHome: dir, timeoutMs: 200 })).toEqual({
      state: 'unknown',
      reason: 'dsh --dump-config timed out after 200 ms'
    });
  });

  it('stops dsh and returns at once when apply is interrupted', async () => {
    const pidFile = path.join(dir, 'dsh.pid');
    const command = fakeDsh(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const interrupt = new AbortController();
    const started = Date.now();
    const probe = probeProfileHmr('web', { command, dshHome: dir, signal: interrupt.signal });
    while (!fs.existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
    interrupt.abort();
    expect(await probe).toEqual({ state: 'unknown', reason: 'dsh --dump-config was stopped by the interrupt' });
    expect(Date.now() - started).toBeLessThan(HMR_PROBE_TIMEOUT_MS);
    expect(await reaped(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 30_000);

  it('times out when dsh runs under a wrapper, as pnpm runs a source checkout, and stops what it started', async () => {
    const pidFile = path.join(dir, 'grandchild.pid');
    // Like pnpm: the grandchild shares the output pipes, so they stay open after the wrapper is killed.
    const command = fakeDsh(`
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', \`require('fs').writeFileSync(\${JSON.stringify(${JSON.stringify(pidFile)})}, String(process.pid)); setTimeout(() => {}, 60000)\`], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);
    const started = Date.now();
    // Long enough for the grandchild to start even on a slow Windows runner, so there is a tree to stop.
    expect(await probeProfileHmr('web', { command, dshHome: dir, timeoutMs: 3_000 })).toEqual({
      state: 'unknown',
      reason: 'dsh --dump-config timed out after 3000 ms'
    });
    // Far short of the grandchild's 60 s: the probe did not wait for the pipes it holds.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(await reaped(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 30_000);

  it('reads the dump of a source checkout run through pnpm without pnpm script banners', async () => {
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'harness', version: '0.1.7', private: true, scripts: { dsh: 'node cli.mjs' } }));
    fs.writeFileSync(path.join(source, 'cli.mjs'), `process.stdout.write(${JSON.stringify(dumpWithHmr('  disabled: true\n'))});`);
    const command = resolveDshCommand({ cliHarnessSource: source });
    expect(await probeProfileHmr('web', { command, dshHome: dir })).toEqual({ state: 'off' });
  }, 30_000);

  it('reports unparseable output as unknown', async () => {
    const command = fakeDsh(`process.stdout.write('- id: hmr\\n  name: [unclosed\\n');`);
    expect((await probeProfileHmr('web', { command, dshHome: dir })).state).toBe('unknown');
  });
});
