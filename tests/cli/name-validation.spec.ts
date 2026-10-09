import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI refuses names and specs it would mishandle', () => {
  let tempHome: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY', 'DSHENV_NPM_CHECK'];
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const refuses = async (args: string[], message: RegExp) => {
    const before = fs.readFileSync(manifestFile(), 'utf8');
    const out = await run(args);
    expect(out.code, args.join(' ')).toBe(3);
    expect(out.stderr, args.join(' ')).toMatch(message);
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
    return out;
  };

  beforeEach(async () => {
    for (const name of ENV) saved[name] = process.env[name];
    for (const name of ENV) delete process.env[name];
    process.env.DSHENV_NPM_CHECK = 'off';
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-names-'));
    await run(['init']);
    expect((await run(['install', 'demo-plugin@1.0.0', '-p', 'web'])).code).toBe(0);
  });

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each([
    [['remove', 'hasOwnProperty', '-p', 'web']],
    [['remove', '__proto__', '-p', 'web']],
    [['disable', 'valueOf', '-p', 'web']],
    [['config', 'set', 'toString', 'a', '1', '-p', 'web']],
    [['update', 'toString', '-p', 'web', '--to', '2.0.0']]
  ])('does not find an Object.prototype member as a plugin: %j', async (args) => {
    await refuses(args, /Plugin '.*' not found in profile 'web'/);
  });

  it.each([
    [['install', 'bar@1.0.0', '-p', 'web', '--as', 'toString']],
    [['install', 'bar@1.0.0', '-p', 'toString', '--new-profile']],
    [['overlay', 'show', '-p', 'toString']]
  ])('refuses an Object.prototype member as a name: %j', async (args) => {
    await refuses(args, /reserved/);
  });

  it('refuses a version with build metadata, which npm drops', async () => {
    await refuses(['install', 'semver@7.6.0+build.1', '-p', 'web'], /build metadata.*use 7\.6\.0/);
    await refuses(['update', 'demo-plugin', '-p', 'web', '--to', '1.0.1+b'], /--to must not carry build metadata.*use 1\.0\.1/);
  });

  it('holds an alias derived from a repository or directory name to the --as rules', async () => {
    await refuses(['install', 'https://github.com/o/-x.git', '-p', 'web', '--package', 'xx'], /'-x'.*pass --as/);
    const hidden = path.join(tempHome, 'src', '.hid');
    fs.mkdirSync(hidden, { recursive: true });
    await refuses(['install', hidden, '-p', 'web', '--package', 'hid'], /'\.hid'.*pass --as/);
    const dir = path.join(tempHome, 'work', '-y');
    await refuses(['new', 'tool', 'abc', '--dir', dir, '-p', 'web'], /'-y'.*pass --as/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses an invalid DSHENV_LAYER even with no overlay active', async () => {
    process.env.DSHENV_LAYER = 'bogus';
    await refuses(['install', 'other@1.0.0', '-p', 'web'], /Invalid --layer 'bogus'.*DSHENV_LAYER/);
  });

  it('refuses profile names that collide on a case-insensitive or Windows file system', async () => {
    const out = await refuses(['install', 'baz@1.0.0', '-p', 'WEB', '--new-profile'], /differ only in case/);
    expect(out.stderr).toMatch(/Refusing to write/);
    await refuses(['install', 'baz@1.0.0', '-p', 'web.', '--new-profile'], /Invalid profile name/);
  });

  it('refuses overlay names that differ only in case, end in a dot or are too long', async () => {
    expect((await run(['overlay', 'create', 'Work'])).code).toBe(0);
    await refuses(['overlay', 'create', 'work'], /'Work' already exists.*only in case/);
    await refuses(['overlay', 'create', 'work.'], /Invalid overlay name/);
    await refuses(['overlay', 'create', 'o'.repeat(101)], /Invalid overlay name/);
  });

  it('says a refused command-line value is refused, not that the manifest on disk is broken', async () => {
    const out = await refuses(['install', 'demo-plugin@1.0.0', '-p', 'web', '--as', 'foo2'], /Duplicate package/);
    expect(out.stderr).toMatch(/Refusing to write .*manifest\.yaml/);
    expect(out.stderr).not.toMatch(/Invalid manifest schema/);
  });

  it('refuses an empty #ref and an alias with invisible characters', async () => {
    await refuses(['install', 'https://example.invalid/x.git#', '-p', 'web'], /#<ref> is empty/);
    await refuses(['install', 'bar@1.0.0', '-p', 'web', '--as', 'a​b'], /invisible/);
    await refuses(['install', 'bar@1.0.0', '-p', 'web', '--as', 'a\u0007b'], /control/);
  });

  it.each(['.x', 'a/.b', 'a//b', 'a.'])('refuses the git ref %j before writing', async (ref) => {
    await refuses(['install', `https://example.invalid/x.git#${ref}`, '-p', 'web'], /Refusing to write .*Invalid git ref/);
  });

  it.each([
    [['--overlay', 'work', 'overlay', 'use', 'Work']],
    [['--no-overlay', 'overlay', 'use', '--none']],
    [['--overlay', 'work', 'overlay', 'create', 'other']]
  ])('refuses the global overlay flags where the overlay subcommand ignores them: %j', async (args) => {
    await refuses(args, /do not apply to overlay/);
  });
});
