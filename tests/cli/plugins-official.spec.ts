import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

const TEAM = '@deepseek-ai/dsh-experimental-agent-team-profile';
const REVIEW = '@deepseek-ai/dsh-experimental-auto-review';

describe('CLI plugins official', () => {
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

  // An installed DSH: its package.json names the dsh bin and depends on the bundles it ships.
  const writePackage = (dir: string, pkg: Record<string, unknown>) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  };

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-official-'));
    const app = path.join(tempHome, 'dsh-install', 'node_modules', '@deepseek-ai', 'dsh');
    const deps = [TEAM, REVIEW, '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-core'];
    writePackage(app, { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.1', bin: { dsh: 'cli.cjs' }, dependencies: Object.fromEntries(deps.map((dep) => [dep, '0.2.1-alpha.1'])) });
    fs.writeFileSync(path.join(app, 'cli.cjs'), "if (process.argv.includes('--version')) console.log('0.2.1-alpha.1');\n");
    const modules = path.join(tempHome, 'dsh-install', 'node_modules');
    writePackage(path.join(modules, TEAM), { name: TEAM, version: '0.2.1-alpha.1', description: 'Agent team', dsh: { bundle: { patch: './cordis.patch.yml' } } });
    writePackage(path.join(modules, REVIEW), { name: REVIEW, version: '0.2.1-alpha.1', description: 'Auto review', dsh: { bundle: { patch: './cordis.patch.yml' } } });
    writePackage(path.join(modules, '@deepseek-ai/dsh-base'), { name: '@deepseek-ai/dsh-base', dsh: { bundle: {} } });
    writePackage(path.join(modules, '@deepseek-ai/dsh-web-app'), { name: '@deepseek-ai/dsh-web-app', dsh: { bundle: {} } });
    writePackage(path.join(modules, '@deepseek-ai/dsh-core'), { name: '@deepseek-ai/dsh-core' });
    process.env.DSH_CLI = JSON.stringify([process.execPath, path.join(app, 'cli.cjs')]);

    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      team: { package: "${TEAM}", source: { type: in-box } }\n  acp:\n    plugins:\n      team: { package: "${TEAM}", enabled: false, source: { type: in-box } }\n`
    );
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('lists the bundles DSH ships beyond its templates, with where the manifest enables them and how to', async () => {
    const out = await run(['plugins', 'official']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Official bundles shipped with DSH 0.2.1-alpha.1');
    expect(out.stdout).toContain(`${TEAM}  Agent team  [acp: team (disabled); web: team]`);
    expect(out.stdout).toContain(`${REVIEW}  Auto review  [not declared]`);
    expect(out.stdout).toContain('dshenv install in-box:<package> -p <profile>');
    expect(out.stdout).not.toContain('dsh-base');
    expect(out.stdout).not.toContain('dsh-core');

    const json = JSON.parse((await run(['plugins', 'official', '--json'])).stdout);
    expect(json).toEqual({
      dshVersion: '0.2.1-alpha.1',
      bundles: [
        { package: TEAM, version: '0.2.1-alpha.1', description: 'Agent team', declared: [{ profile: 'acp', alias: 'team', enabled: false }, { profile: 'web', alias: 'team', enabled: true }] },
        { package: REVIEW, version: '0.2.1-alpha.1', description: 'Auto review', declared: [] }
      ]
    });
  });

  it('narrows the declarations to one profile with -p, and names it in the hint', async () => {
    const out = await run(['plugins', 'official', '-p', 'acp']);
    expect(out.stdout).toContain(`${TEAM}  Agent team  [acp: team (disabled)]`);
    expect(out.stdout).toContain('dshenv install in-box:<package> -p acp');
  });

  it('exits 4 when it cannot find where DSH is installed', async () => {
    process.env.DSH_CLI = JSON.stringify([process.execPath, path.join(tempHome, 'nowhere.cjs')]);
    const out = await run(['plugins', 'official']);
    expect(out.code).toBe(4);
    expect(out.stderr).toContain('Cannot find where DSH is installed');
  });
});
