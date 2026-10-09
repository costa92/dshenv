import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';

// Fake DSH: `add` installs a bundle package; an add of HANG_ON takes the profile's package.json lock as DSH does,
// records its pid and never finishes, like a stuck install. It has no signal handling, so a kill leaves the lock behind.
const FAKE_DSH = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
const spec = args.at(-1);
if (process.env.HANG_ON && spec.includes(process.env.HANG_ON)) {
  const profileDir = path.join(process.env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1]);
  fs.writeFileSync(path.join(profileDir, 'package.json.lock'), process.pid + '\\n', { flag: 'wx' });
  fs.writeFileSync(process.env.HANG_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const profileDir = path.join(process.env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1]);
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const name = spec.split('@')[0];
  pkg.dependencies[name] = spec.slice(name.length + 1);
  fs.mkdirSync(path.join(profileDir, 'node_modules', name), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: {} } }));
  pkg.dsh.profile.bundles.push(name);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
}
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Ctrl-C ends dshenv without running its failure path, so apply must stop DSH and roll back itself.
// Windows cannot deliver SIGINT to another process, so these run on POSIX only.
describe.skipIf(process.platform === 'win32')('applyEnvironment when dshenv is interrupted', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  let previousDshCli: string | undefined;
  let dshPid: number | undefined;

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-interrupt-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(
      paths.manifestFile,
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n' +
        ['aa', 'bb'].map((name) => `      ${name}:\n        package: "${name}"\n        source: { type: npm, version: "1.0.0" }\n`).join('')
    );
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }));
    fs.writeFileSync(path.join(tempHome, 'fake-dsh.mjs'), FAKE_DSH);
    process.env.DSH_CLI = JSON.stringify([process.execPath, path.join(tempHome, 'fake-dsh.mjs')]);
  });

  afterEach(() => {
    if (dshPid !== undefined && alive(dshPid)) process.kill(dshPid, 'SIGKILL');
    dshPid = undefined;
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('stops DSH, rolls back, releases its locks, and then ends by the signal', async () => {
    const pidFile = path.join(tempHome, 'dsh.pid');
    const driver = path.join(tempHome, 'driver.mts');
    fs.writeFileSync(
      driver,
      `import { applyEnvironment } from ${JSON.stringify(path.resolve('src/apply/apply.ts'))};
import { resolveEnvironmentPaths } from ${JSON.stringify(path.resolve('src/environment/paths.ts'))};
await applyEnvironment(resolveEnvironmentPaths({ cliDshHome: ${JSON.stringify(tempHome)} }), { probeHmr: async () => ({ state: 'off' }), hmrSettleMs: 0 });
console.log('applied');`
    );
    const dshenv = execa(process.execPath, ['--import', 'tsx/esm', driver], {
      reject: false,
      env: { HANG_ON: 'bb', HANG_PID_FILE: pidFile }
    });
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    dshPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(dshPid)).toBe(true);

    dshenv.kill('SIGINT');
    const result = await dshenv;
    expect(result.signal).toBe('SIGINT');
    expect(result.stdout).not.toContain('applied');
    expect(alive(dshPid)).toBe(false);

    // The environment lock and the profile's package.json lock are gone, so the next command does not wait on them.
    expect(fs.existsSync(path.join(paths.managerDir, 'dshenv.lock'))).toBe(false);
    expect(fs.existsSync(path.join(tempHome, 'profiles', 'web', 'package.json.lock'))).toBe(false);
    const journal = fs.readFileSync(path.join(paths.logsDir, 'journal.jsonl'), 'utf8');
    expect(journal).toMatch(/"type":"apply-rollback".*interrupted/);
    // What DSH did install stays dshenv's to remove later.
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as { resources?: { plugin?: { web?: object } }; lastApplied: string };
    expect(Object.keys(state.resources?.plugin?.web ?? {})).toEqual(['aa']);
    expect(state.lastApplied).toBe('');

    const next = await applyEnvironment(paths, { probeHmr: async () => ({ state: 'off' }), hmrSettleMs: 0 });
    expect(next.applied).toBe(true);
  }, 60_000);

  // The driver raises SIGINT on itself from inside `hook`, then gives the handler time to run before going on.
  const runInterrupted = async (patch: string) => {
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    for (const name of ['aa', 'bb']) {
      fs.mkdirSync(path.join(paths.skillsDir, name), { recursive: true });
      fs.writeFileSync(path.join(paths.skillsDir, name, 'SKILL.md'), name);
    }
    const driver = path.join(tempHome, 'driver.mts');
    fs.writeFileSync(
      driver,
      `import fs from 'node:fs';
import { applyEnvironment } from ${JSON.stringify(path.resolve('src/apply/apply.ts'))};
import { resolveEnvironmentPaths } from ${JSON.stringify(path.resolve('src/environment/paths.ts'))};
const interrupt = async () => { process.kill(process.pid, 'SIGINT'); await new Promise((resolve) => setTimeout(resolve, 300)); };
${patch}
await applyEnvironment(resolveEnvironmentPaths({ cliDshHome: ${JSON.stringify(tempHome)} }), { probeHmr: async () => ({ state: 'off' }), hmrSettleMs: 0 });
console.log('applied');`
    );
    return execa(process.execPath, ['--import', 'tsx/esm', driver], { reject: false });
  };

  it('stops between skills once interrupted and rolls back the ones already written', async () => {
    const result = await runInterrupted(`const cp = fs.promises.cp.bind(fs.promises);
let first = true;
fs.promises.cp = async (...args) => {
  await cp(...args);
  if (first && String(args[1]).startsWith(${JSON.stringify(paths.dshSkillsDir)})) { first = false; await interrupt(); }
};`);
    expect(result.signal).toBe('SIGINT');
    expect(fs.existsSync(path.join(paths.dshSkillsDir, 'aa'))).toBe(false);
    expect(fs.existsSync(path.join(paths.dshSkillsDir, 'bb'))).toBe(false);
    expect(fs.readFileSync(path.join(paths.logsDir, 'journal.jsonl'), 'utf8')).toMatch(/"type":"apply-rollback".*interrupted/);
  }, 60_000);

  it('says the apply finished when the interrupt comes after it committed, and still ends by the signal', async () => {
    const result = await runInterrupted(`const append = fs.promises.appendFile.bind(fs.promises);
fs.promises.appendFile = async (file, line, ...rest) => { await append(file, line, ...rest); if (String(line).includes('apply-completed')) await interrupt(); };`);
    expect(result.signal).toBe('SIGINT');
    expect(result.stdout).not.toContain('applied');
    expect(result.stderr).toMatch(/Apply apply-[0-9a-f]{12} had already finished when interrupted, so nothing was rolled back: Successfully applied/);
    expect(fs.readFileSync(path.join(paths.dshSkillsDir, 'bb', 'SKILL.md'), 'utf8')).toBe('bb');
  }, 60_000);
});
