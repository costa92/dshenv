import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import * as YAML from 'yaml';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
}
interface Workflow {
  on?: unknown;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      steps: Step[];
      strategy?: { matrix?: { node?: unknown[]; os?: unknown[]; include?: Array<Record<string, unknown>> } };
      'continue-on-error'?: unknown;
      if?: string;
      needs?: string;
      permissions?: Record<string, string>;
      'timeout-minutes'?: number;
    }
  >;
}

const readWorkflow = (relative: string): Workflow =>
  YAML.parse(fs.readFileSync(path.join(projectDir, relative), 'utf8')) as Workflow;
const ci = readWorkflow('.github/workflows/ci.yml');
const example = readWorkflow('docs/examples/github-actions/dshenv-check.yml');
const release = readWorkflow('.github/workflows/release.yml');
const e2e = readWorkflow('.github/workflows/e2e.yml');
const compat = readWorkflow('.github/workflows/compat.yml');
const VERIFIED_DSH = '0.1.7-rc.2';
// Smoke-verified only: the e2e chain's third-party plugins do not declare DSH 0.2 yet.
const VERIFIED_DSH_NEXT = '0.2.0-rc.2';
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as {
  version: string;
  packageManager: string;
  scripts: Record<string, string>;
};
const repositoryWorkflows = { ci, release, e2e, compat };

const allSteps = (workflow: Workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps);
const pnpmVersions = (workflow: Workflow) =>
  allSteps(workflow)
    .filter((step) => step.uses?.startsWith('pnpm/action-setup@'))
    .map((step) => String(step.with?.version));
const runs = (steps: Step[]) => steps.flatMap((step) => (step.run && !step.id ? [step.run.trim()] : []));
const stepScript = (workflow: Workflow, id: string): string => {
  const step = allSteps(workflow).find((candidate) => candidate.id === id);
  if (!step?.run) throw new Error(`No run step with id ${id}`);
  return step.run;
};

describe('repository CI workflow', () => {
  it('runs every quality gate from package.json on a frozen lockfile, on Linux, Windows and macOS', () => {
    expect(Object.keys(ci.jobs)).toEqual(['check', 'check-os']);
    for (const job of Object.values(ci.jobs)) {
      expect(runs(job.steps)).toEqual(['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm build']);
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
    for (const run of runs(ci.jobs.check.steps).slice(1)) {
      expect(packageJson.scripts).toHaveProperty(run.split(' ')[1]);
    }
    expect(ci.jobs['check-os'].strategy?.matrix?.os).toEqual(['windows-2025', 'macos-26']);
    expect(ci.permissions).toEqual({ contents: 'read' });
  });

  it('pins one exact pnpm version, shared with the example and package.json, and covers both supported Node majors', async () => {
    const versions = [...pnpmVersions(ci), ...pnpmVersions(example), ...pnpmVersions(release), ...pnpmVersions(e2e), ...pnpmVersions(compat)];
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.packageManager).toBe(`pnpm@${versions[0]}`);
    // The required checks on master are named after this matrix.
    expect(ci.jobs.check.strategy?.matrix?.node).toEqual([22, 24]);
  });

  it.each(Object.entries(repositoryWorkflows))('%s pins every action to a commit and keeps no credentials in the checkout', (_name, workflow) => {
    for (const step of allSteps(workflow).filter((candidate) => candidate.uses)) {
      expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) {
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  // The first major of each action that runs on Node 24; older ones make every job warn that Node 20 is deprecated.
  const node24Majors: Record<string, number> = {
    'actions/checkout': 5,
    'actions/setup-node': 5,
    'actions/upload-artifact': 6,
    'actions/download-artifact': 7,
    'pnpm/action-setup': 4
  };

  it.each(['ci', 'release', 'e2e', 'compat'])('%s uses only action versions that run on Node 24', (name) => {
    const text = fs.readFileSync(path.join(projectDir, '.github', 'workflows', `${name}.yml`), 'utf8');
    const pins = [...text.matchAll(/uses:\s*([\w-]+\/[\w-]+)@[0-9a-f]{40}\s*#\s*v(\d+)\./g)];
    expect(pins.length).toBe((text.match(/uses:/g) ?? []).length);
    for (const [, action, major] of pins) {
      expect(node24Majors[action], action).toBeDefined();
      expect(Number(major), action).toBeGreaterThanOrEqual(node24Majors[action]);
    }
  });

  it.each(['ci', 'release', 'e2e', 'compat'])('%s runs on fixed runner images, not ones that move under it', (name) => {
    // The -latest labels move to a new OS release on GitHub's schedule; the upgrade should be a change here instead.
    const text = fs.readFileSync(path.join(projectDir, '.github', 'workflows', `${name}.yml`), 'utf8');
    expect(text).not.toMatch(/(ubuntu|macos|windows)-latest/);
  });

  it.each(Object.entries(repositoryWorkflows))('%s never splices a workflow input into a shell script', (_name, workflow) => {
    for (const step of allSteps(workflow)) {
      expect(step.run ?? '').not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
    }
  });
});

// The example runs these bash steps on ubuntu-latest; Windows is not a target for them.
describe.skipIf(process.platform === 'win32')('dshenv example workflow scripts', () => {
  let workDir: string;
  let dshenv: string;

  const runStep = (id: string, env: Record<string, string>) =>
    execa('bash', ['-c', stepScript(example, id)], { cwd: projectDir, env: { ...process.env, DSHENV: dshenv, ...env }, reject: false });

  const writeConfig = (home: string, overlays: Record<string, string>) => {
    fs.mkdirSync(path.join(home, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      teams: { package: teams-plugin, source: { type: npm, version: "1.0.0" } }\n'
    );
    for (const [name, content] of Object.entries(overlays)) {
      fs.writeFileSync(path.join(home, 'envctl', 'overlays', `${name}.yaml`), content);
    }
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-gha-'));
    const shim = path.join(workDir, 'dshenv.mts');
    fs.writeFileSync(
      shim,
      `import { runCli } from ${JSON.stringify(path.join(projectDir, 'src', 'cli.ts'))};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`
    );
    dshenv = `node --import tsx ${shim}`;
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('validate passes for a valid base and overlays, and fails on an overlay that cannot merge', async () => {
    const configHome = path.join(workDir, 'config');
    writeConfig(configHome, { laptop: 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      teams: { enabled: false }\n' });

    const ok = await runStep('validate', { CONFIG_HOME: configHome });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('::group::overlay laptop');

    fs.writeFileSync(
      path.join(configHome, 'envctl', 'overlays', 'broken.yaml'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      teams: { source: { type: npm, version: "^2.0.0" } }\n'
    );
    expect((await runStep('validate', { CONFIG_HOME: configHome })).exitCode).not.toBe(0);
    expect(fs.readdirSync(path.join(configHome, 'envctl')).sort()).toEqual(['manifest.yaml', 'overlays']);
  }, 60000);

  it('drift passes when the environment matches and fails with an annotation when it drifted', async () => {
    const dshHome = path.join(workDir, 'dsh');
    writeConfig(dshHome, {});
    const profileDir = path.join(dshHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'teams-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'teams-plugin', 'package.json'), JSON.stringify({ name: 'teams-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'teams-plugin': '1.0.0' }, dsh: { profile: { bundles: ['teams-plugin'] } } })
    );

    const inSync = await runStep('drift', { DSH_HOME: dshHome });
    expect(inSync.exitCode).toBe(0);

    fs.writeFileSync(path.join(profileDir, 'node_modules', 'teams-plugin', 'package.json'), JSON.stringify({ name: 'teams-plugin', version: '0.9.0', dsh: { bundle: {} } }));
    const drifted = await runStep('drift', { DSH_HOME: dshHome });
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stdout).toContain('::error::');
  }, 60000);
});

describe('release workflow', () => {
  let workDir: string;

  const runStep = (id: string, env: Record<string, string>, cwd = projectDir) =>
    execa('bash', ['-c', stepScript(release, id)], { cwd, env: { ...process.env, ...env }, reject: false });

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-release-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('runs on v* tags, and by hand as a publish check, building and testing with read-only permissions after the same quality gates as CI', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] }, workflow_dispatch: null });
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(release.jobs)).toEqual(['build', 'publish']);
    const build = release.jobs.build;
    expect(build.permissions).toBeUndefined();
    expect(runs(build.steps)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm pack --pack-destination dist'
    ]);
    // Full history, so the tag can be checked against master.
    expect(build.steps[0].with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false });
    for (const id of ['verify-tag', 'verify-on-master', 'notes']) {
      expect(build.steps.find((step) => step.id === id)?.if).toBe("github.event_name == 'push'");
    }
    // The smoke check runs on the packed tarball, and only what passed it is handed to publish.
    const smoke = build.steps.findIndex((step) => step.id === 'smoke');
    const upload = build.steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(smoke).toBeGreaterThan(build.steps.findIndex((step) => step.run?.startsWith('pnpm pack')));
    expect(upload).toBeGreaterThan(smoke);
    expect(build.steps[upload].with).toMatchObject({ name: 'package', path: 'dist/*.tgz\nrelease-notes.md\n' });
  });

  it('gives publishing rights only to a job that publishes the built tarball without checking out or installing anything', () => {
    const publish = release.jobs.publish;
    expect(publish.needs).toBe('build');
    expect(publish.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    expect(publish.steps.map((step) => step.uses?.split('@')[0]).filter(Boolean)).toEqual(['actions/download-artifact', 'actions/setup-node']);
    expect(publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))?.with).toEqual({ name: 'package' });
    expect(publish.steps.some((step) => /\bpnpm\b/.test(step.run ?? ''))).toBe(false);
  });

  it('smoke-tests the packed tarball by installing it and running dshenv', async () => {
    const dist = path.join(workDir, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'costa92-dshenv-1.2.3.tgz'), '');
    fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const bin = path.join(workDir, 'bin');
    fs.mkdirSync(bin);
    // Stands in for npm install --prefix <dir> <tarball>: installs a dshenv that reports $FAKE_VERSION.
    fs.writeFileSync(
      path.join(bin, 'npm'),
      `#!/bin/sh\nprefix="$3"\nmkdir -p "$prefix/node_modules/.bin"\nprintf '#!/bin/sh\\ncase "$1" in --version) echo %s ;; --help) exit "$FAKE_HELP_EXIT" ;; esac\\n' "$FAKE_VERSION" >"$prefix/node_modules/.bin/dshenv"\nchmod +x "$prefix/node_modules/.bin/dshenv"\necho "$@" >"$prefix/args"\n`,
      { mode: 0o755 }
    );
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_HELP_EXIT: '0', TMPDIR: workDir };
    expect((await runStep('smoke', { ...env, FAKE_VERSION: '1.2.3' }, workDir)).exitCode).toBe(0);
    const wrong = await runStep('smoke', { ...env, FAKE_VERSION: '0.0.1' }, workDir);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain("The packed dshenv reports version '0.0.1', expected 1.2.3");
    expect((await runStep('smoke', { ...env, FAKE_VERSION: '1.2.3', FAKE_HELP_EXIT: '1' }, workDir)).exitCode).not.toBe(0);
  });

  it('publishes a tag through trusted publishing first and with NPM_TOKEN only when that fails, before creating the GitHub release', () => {
    const steps = release.jobs.publish.steps;
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['registry-url']).toBe('https://registry.npmjs.org');
    const oidc = steps.findIndex((step) => step.id === 'publish-oidc');
    expect(steps[oidc]).toMatchObject({ if: "github.event_name == 'push'", 'continue-on-error': true });
    expect(steps[oidc].run?.trim()).toBe('npm publish ./dist/*.tgz --access public --loglevel verbose');
    expect(steps[oidc].env).toBeUndefined();
    const token = steps.findIndex((step) => step.id === 'publish-token');
    expect(steps[token].if).toBe("github.event_name == 'push' && steps.publish-oidc.outcome == 'failure'");
    expect(steps[token].env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' });
    expect(steps[token].run).toContain('::warning::');
    expect(steps[token].run).toContain('npm publish ./dist/*.tgz --access public --provenance --loglevel verbose');
    // Trusted publishing needs npm 11.5.1 or later; Node 22 bundles npm 10. An exact version, not a range.
    const upgrade = steps.findIndex((step) => /^npm install -g npm@11\.\d+\.\d+$/.test(step.run?.trim() ?? ''));
    expect(upgrade).toBeGreaterThan(-1);
    const [minor, patch] = steps[upgrade].run!.trim().split('@11.')[1].split('.').map(Number);
    expect(minor > 5 || (minor === 5 && patch >= 1)).toBe(true);
    expect(upgrade).toBeLessThan(oidc);
    expect(oidc).toBeLessThan(token);
    const create = steps.findIndex((step) => step.run?.startsWith('gh release create'));
    expect(token).toBeLessThan(create);
    expect(steps[create].if).toBe("github.event_name == 'push'");
  });

  it('checks by hand, without publishing, that trusted publishing gets a token and NPM_TOKEN still works', async () => {
    const steps = allSteps(release);
    const check = steps.find((step) => step.id === 'check-oidc')!;
    expect(check.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(check.run).toContain('npm publish ./dist/*.tgz --dry-run --force --access public --loglevel verbose');
    const whoami = steps.find((step) => step.id === 'check-token')!;
    expect(whoami).toMatchObject({ if: "github.event_name == 'workflow_dispatch' && !cancelled()", env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' } });
    expect(whoami.run?.trim()).toBe('npm whoami');

    const bin = path.join(workDir, 'bin');
    fs.mkdirSync(bin);
    const fakeNpm = (log: string) => fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(log)} >&2\n`, { mode: 0o755 });
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    fakeNpm('npm verbose oidc Successfully retrieved and set token');
    expect((await runStep('check-oidc', env, workDir)).exitCode).toBe(0);
    fakeNpm('npm verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found');
    const failed = await runStep('check-oidc', env, workDir);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain('::error::npm trusted publishing did not get a token: npm verbose oidc Failed token exchange');
  });

  it('accepts only the tag that matches the package.json version', async () => {
    expect((await runStep('verify-tag', { GITHUB_REF_NAME: `v${packageJson.version}` })).exitCode).toBe(0);
    const mismatch = await runStep('verify-tag', { GITHUB_REF_NAME: 'v99.0.0' });
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stderr).toContain(`Tag v99.0.0 does not match package.json version ${packageJson.version}`);
  });

  it('publishes only a tag that points at a commit on master, which only reviewed PRs reach', async () => {
    const git = (...args: string[]) => execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd: workDir });
    await git('init', '--quiet', '--initial-branch=master');
    await git('commit', '--quiet', '--allow-empty', '-m', 'on master');
    const onMaster = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('update-ref', 'refs/remotes/origin/master', onMaster);
    await git('checkout', '--quiet', '-b', 'side');
    await git('commit', '--quiet', '--allow-empty', '-m', 'unreviewed');
    const offMaster = (await git('rev-parse', 'HEAD')).stdout.trim();

    expect((await runStep('verify-on-master', { GITHUB_SHA: onMaster, GITHUB_REF_NAME: 'v1.0.0' }, workDir)).exitCode).toBe(0);
    const off = await runStep('verify-on-master', { GITHUB_SHA: offMaster, GITHUB_REF_NAME: 'v1.0.0' }, workDir);
    expect(off.exitCode).toBe(1);
    expect(off.stderr).toContain(`Tag v1.0.0 points at ${offMaster}, which is not on master`);
  });

  it('takes the release notes from the CHANGELOG section of the tagged version', async () => {
    fs.writeFileSync(
      path.join(workDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 1.1.0 - 2026-10-01\n\n- newer\n\n## 1.0.0 - 2026-09-27\n\n### Added\n\n- first\n'
    );
    expect((await runStep('notes', { GITHUB_REF_NAME: 'v1.0.0' }, workDir)).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(workDir, 'release-notes.md'), 'utf8').trim()).toBe('### Added\n\n- first');

    const missing = await runStep('notes', { GITHUB_REF_NAME: 'v2.0.0' }, workDir);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('CHANGELOG.md has no section for 2.0.0');
  });

  it('has a CHANGELOG section for the current package.json version', async () => {
    fs.copyFileSync(path.join(projectDir, 'CHANGELOG.md'), path.join(workDir, 'CHANGELOG.md'));
    expect((await runStep('notes', { GITHUB_REF_NAME: `v${packageJson.version}` }, workDir)).exitCode).toBe(0);
  });
});

describe('real DSH workflows', () => {
  it('runs the end-to-end script against the verified DSH on pushes and pull requests, apart from CI', () => {
    expect(Object.keys(e2e.on as object).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(Object.keys(e2e.jobs)).toEqual(['e2e']);
    const step = allSteps(e2e).find((candidate) => candidate.run?.includes('scripts/e2e-dsh.sh'));
    expect(step?.run).toBe('scripts/e2e-dsh.sh "$DSH_VERSION" "$RUNNER_TEMP/e2e"');
    expect(step?.env?.DSH_VERSION).toBe(`\${{ inputs.dsh_version || '${VERIFIED_DSH}' }}`);
    expect(allSteps(ci).some((step) => step.run?.includes('e2e-dsh'))).toBe(false);
  });

  it('smoke-tests the verified DSH as a hard check and latest and next as reports only', () => {
    const smoke = compat.jobs.smoke;
    expect(smoke.strategy?.matrix?.include).toEqual([
      { dsh: VERIFIED_DSH, informational: false },
      { dsh: VERIFIED_DSH_NEXT, informational: false },
      { dsh: 'latest', informational: true },
      { dsh: 'next', informational: true }
    ]);
    expect(smoke['continue-on-error']).toBe('${{ matrix.informational }}');
    expect(smoke.steps.at(-1)?.run).toBe('scripts/smoke-dsh.sh "${{ matrix.dsh }}" "$RUNNER_TEMP/smoke"');
    // Only the report-only versions may grant a plugin DSH's exact-version exemption.
    expect(smoke.steps.at(-1)?.env?.SMOKE_ALLOW_PLUGIN_EXEMPTION).toBe('${{ matrix.informational }}');
    expect(Object.keys(compat.on as object)).toContain('schedule');
  });

  it('pins the same verified DSH as the version gate', async () => {
    const { knownDshFamily } = await import('../src/dsh/version.js');
    expect(knownDshFamily(VERIFIED_DSH)).toBe('0.1.7');
    expect(knownDshFamily(VERIFIED_DSH_NEXT)).toBe('0.2.0');
  });

  it.skipIf(process.platform === 'win32').each(['scripts/e2e-dsh.sh', 'scripts/smoke-dsh.sh'])('keeps %s executable', (script) => {
    expect(fs.statSync(path.join(projectDir, script)).mode & 0o111).not.toBe(0);
  });
});
