import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { runCli } from '../../src/cli.js';

describe('CLI new', () => {
  let work: string;
  let home: string;
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', home], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const manifest = () => YAML.parse(fs.readFileSync(path.join(home, 'envctl', 'manifest.yaml'), 'utf8'));

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-new-'));
    home = path.join(work, 'home');
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it.each([
    ['skill', ['README.md', 'cordis.patch.yml', 'package.json', path.join('skills', 'demo', 'SKILL.md')]],
    ['agent', ['README.md', 'cordis.patch.yml', 'package.json']],
    ['tool', ['README.md', 'cordis.patch.yml', 'index.js', 'package.json']],
    ['mcp', ['README.md', 'cordis.patch.yml', 'package.json']]
  ])('creates a %s package and reports it as JSON', async (kind, files) => {
    const dir = path.join(work, kind);
    const result = await run(['new', kind, 'demo', '--dir', dir, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'created', kind, dir, package: 'demo', files });
  });

  it('prints files and the install hint in text mode', async () => {
    const dir = path.join(work, 'echo');
    const result = await run(['new', 'tool', 'echo', '--dir', dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Created tool 'echo' in ${dir}`);
    expect(result.stdout).toContain('  index.js');
    expect(result.stdout).toContain(`dshenv install ${dir} -p <profile>`);
  });

  it('tells TypeScript users to build first', async () => {
    const result = await run(['new', 'tool', 'echo', '--dir', path.join(work, 'echo'), '--typescript']);
    expect(result.stdout).toContain('pnpm install && pnpm build');
  });

  it('tells TypeScript + -p users to build before applying', async () => {
    await run(['init']);
    const dir = path.join(work, 'echo');
    const result = await run(['new', 'tool', 'echo', '--dir', dir, '--typescript', '-p', 'web']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('pnpm install && pnpm build');
    expect(result.stdout).toContain("Registered as 'echo' in profile 'web'. Next: build, then dshenv plan and dshenv apply --yes.");
  });

  it('writes a loose skill under DSH_HOME/skills', async () => {
    const result = await run(['new', 'skill', 'review', '--loose', '--json']);
    expect(result.code).toBe(0);
    const dir = path.join(home, 'skills', 'review');
    expect(JSON.parse(result.stdout)).toEqual({ status: 'created', kind: 'skill', dir, files: ['SKILL.md'] });
  });

  it.each([
    [['new', 'skill', 'x', '--loose', '-p', 'web'], '--loose cannot be combined with -p, --as or --layer'],
    [['new', 'tool', 'x', '--dir', 'OUT', '--as', 'y'], '--as, --layer and --new-profile require -p'],
    [['new', 'tool', 'x', '--dir', 'OUT', '--layer', 'base'], '--as, --layer and --new-profile require -p'],
    [['new', 'tool', 'x', '--dir', 'OUT', '--new-profile'], '--as, --layer and --new-profile require -p'],
    [['new', 'tool', 'Bad', '--dir', 'OUT'], "Component name 'Bad' must be kebab-case"],
    [['new', 'skill', 's2', '--dir', 'OUT', '-p', 'web', '--as', 'a b'], 'Plugin alias must not contain whitespace'],
    [['new', 'skill', 's2', '--dir', 'OUT', '-p', 'web', '--as', ''], 'Plugin alias must not be empty']
  ])('rejects %j with exit code 3', async (args, message) => {
    const out = path.join(work, 'out');
    const result = await run(args.map((arg) => (arg === 'OUT' ? out : arg)));
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false);
  });

  it('registers the package as a local-link source with -p and plan shows the install', async () => {
    await run(['init']);
    const dir = path.join(work, 'echo');
    const result = await run(['new', 'tool', 'echo', '--dir', dir, '-p', 'web', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).installed).toEqual({ profile: 'web', alias: 'echo' });
    expect(manifest().profiles.web.plugins.echo).toEqual({ package: 'echo', enabled: true, source: { type: 'local-link', path: dir } });
    const plan = await run(['plan']);
    expect(plan.code).toBe(2);
    expect(plan.stdout).toContain('+ [web] echo');
  });

  it('registers using the generated package name, not a name derived from the target directory', async () => {
    await run(['init']);
    const dir = path.join(work, 'x');
    const result = await run(['new', 'tool', 'x', '--dir', dir, '--package', '@scope/echo', '-p', 'web', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).installed).toEqual({ profile: 'web', alias: 'x' });
    expect(manifest().profiles.web.plugins.x).toEqual({ package: '@scope/echo', enabled: true, source: { type: 'local-link', path: dir } });
  });

  it('honours --as and --layer overlay', async () => {
    await run(['init']);
    fs.mkdirSync(path.join(home, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(home, 'envctl', 'overlays', 'laptop.yaml'), 'apiVersion: dshenv-overlay/v1\n');
    await run(['overlay', 'use', 'laptop']);
    const dir = path.join(work, 'echo');
    expect((await run(['new', 'tool', 'echo', '--dir', dir, '-p', 'web', '--as', 'ec', '--layer', 'overlay'])).code).toBe(0);
    const overlay = YAML.parse(fs.readFileSync(path.join(home, 'envctl', 'overlays', 'laptop.yaml'), 'utf8'));
    expect(overlay.profiles.web.plugins.ec).toEqual({ package: 'echo', enabled: true, source: { type: 'local-link', path: dir } });
  });

  it('removes the generated package when registration fails', async () => {
    const dir = path.join(work, 'echo');
    const result = await run(['new', 'tool', 'echo', '--dir', dir, '-p', 'web']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Manifest file not found');
    expect(fs.existsSync(dir)).toBe(false);
  });
});
