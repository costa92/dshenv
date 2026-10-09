import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { acquireEnvironmentLock } from '../../src/io/lock.js';
import { migrateEnvctl } from '../../src/environment/migrate.js';

describe('CLI envctl location', () => {
  let tempRoot: string;
  let home: string;

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', home], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-envctl-dir-'));
    home = path.join(tempRoot, 'dsh');
    fs.mkdirSync(home);
  });

  afterEach(() => {
    delete process.env.DSHENV_HOME;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps envctl in DSHENV_HOME, and --envctl-dir wins over it', async () => {
    process.env.DSHENV_HOME = path.join(tempRoot, 'from-env');
    expect((await run(['init'])).code).toBe(0);
    expect(fs.existsSync(path.join(tempRoot, 'from-env', 'manifest.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'envctl'))).toBe(false);

    expect((await run(['init', '--envctl-dir', path.join(tempRoot, 'from-cli')])).code).toBe(0);
    expect(fs.existsSync(path.join(tempRoot, 'from-cli', 'manifest.yaml'))).toBe(true);
  });

  it('refuses an envctl that is the DSH home or overlaps the directories DSH owns in it', async () => {
    for (const dir of [home, path.join(home, 'skills'), path.join(home, 'skills', 'x'), path.join(home, 'profiles'), path.join(home, 'profiles', 'web')]) {
      const result = await run(['plan', '--envctl-dir', dir]);
      expect(result.code).toBe(3);
      expect(result.stderr).toMatch(/envctl-dir .* (is the DSH home|overlaps DSH's)/);
    }
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false);
    expect((await run(['init', '--envctl-dir', path.join(home, 'custom')])).code).toBe(0);
  });

  it('refuses to migrate envctl into the DSH home or a directory DSH owns there', async () => {
    await run(['init']);
    for (const dir of [path.join(home, 'skills'), path.join(home, 'profiles', 'web')]) {
      const result = await run(['migrate', '--to', dir, '--yes']);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("overlaps DSH's");
      expect(fs.existsSync(dir)).toBe(false);
    }
    expect(fs.existsSync(path.join(home, 'envctl', 'manifest.yaml'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked envctl or envctl subdirectory', async () => {
    const real = path.join(tempRoot, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(home, 'envctl'));
    const linked = await run(['init']);
    expect(linked.code).toBe(3);
    expect(linked.stderr).toContain('is a symlink');
    expect(linked.stderr).toContain('dshenv migrate --to');
    expect(fs.existsSync(path.join(real, 'manifest.yaml'))).toBe(false);

    fs.unlinkSync(path.join(home, 'envctl'));
    expect((await run(['init'])).code).toBe(0);
    fs.symlinkSync(path.join(tempRoot, 'real'), path.join(home, 'envctl', 'skills'));
    expect((await run(['plan'])).code).toBe(3);
    fs.unlinkSync(path.join(home, 'envctl', 'skills'));

    const manifest = path.join(home, 'envctl', 'manifest.yaml');
    fs.renameSync(manifest, path.join(real, 'manifest.yaml'));
    fs.symlinkSync(path.join(real, 'manifest.yaml'), manifest);
    const file = await run(['plan']);
    expect(file.code).toBe(3);
    expect(file.stderr).toContain(`${manifest} is a symlink`);
  });

  it('previews a migration, then moves envctl and leaves no copy behind', async () => {
    await run(['init']);
    fs.mkdirSync(path.join(home, 'envctl', 'skills', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(home, 'envctl', 'skills', 'wiki', 'SKILL.md'), '# wiki\n');
    const target = path.join(tempRoot, 'data', 'envctl');

    const preview = await run(['migrate', '--to', target]);
    expect(preview.code).toBe(2);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(home, 'envctl', 'manifest.yaml'))).toBe(true);

    const moved = await run(['migrate', '--to', target, '--yes']);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain(`DSHENV_HOME=${target}`);
    expect(fs.readdirSync(path.join(home, 'envctl'))).toEqual(['dshenv.moved']);
    expect(fs.readFileSync(path.join(target, 'skills', 'wiki', 'SKILL.md'), 'utf8')).toBe('# wiki\n');
    expect(fs.existsSync(path.join(target, 'dshenv.lock'))).toBe(false);
    const plan = await run(['plan', '--envctl-dir', target]);
    expect(plan.code).toBe(2);
    expect(plan.stdout).toContain('wiki');
  });

  it.skipIf(process.platform === 'win32')('migrates a symlinked envctl by content and leaves link targets alone', async () => {
    const real = path.join(tempRoot, 'real');
    const skills = path.join(tempRoot, 'shared-skills');
    fs.mkdirSync(path.join(skills, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'wiki', 'SKILL.md'), '# wiki\n');
    await run(['init', '--envctl-dir', real]);
    fs.symlinkSync(skills, path.join(real, 'skills'));
    const dotfiles = path.join(tempRoot, 'dotfiles');
    fs.mkdirSync(dotfiles);
    fs.renameSync(path.join(real, 'manifest.yaml'), path.join(dotfiles, 'manifest.yaml'));
    fs.symlinkSync(path.join(dotfiles, 'manifest.yaml'), path.join(real, 'manifest.yaml'));
    fs.symlinkSync(real, path.join(home, 'envctl'));
    const target = path.join(tempRoot, 'moved');

    const result = await run(['migrate', '--to', target, '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).linked).toEqual([
      path.join(home, 'envctl'),
      path.join(home, 'envctl', 'manifest.yaml'),
      path.join(home, 'envctl', 'skills')
    ]);
    expect(fs.lstatSync(path.join(target, 'skills')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(target, 'manifest.yaml')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(dotfiles, 'manifest.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'skills', 'wiki', 'SKILL.md'), 'utf8')).toBe('# wiki\n');
    // The link and its target stay; the target only gains the marker, so neither path works as an environment any more.
    expect(fs.lstatSync(path.join(home, 'envctl')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(real, 'dshenv.moved'), 'utf8').trim()).toBe(target);
    expect(fs.readdirSync(real).filter((name) => name.startsWith('dshenv.lock'))).toEqual([]);
    expect(fs.existsSync(path.join(real, 'lock.json'))).toBe(true);
    expect((await run(['plan'])).stderr).toContain(`was moved to ${target}`);
    expect((await run(['plan', '--envctl-dir', real])).stderr).toContain(`was moved to ${target}`);
    expect(fs.existsSync(path.join(skills, 'wiki', 'SKILL.md'))).toBe(true);
  });

  it('rewrites manifest, overlay and lock paths into the old envctl to the new location', async () => {
    await run(['init']);
    const envctl = path.join(home, 'envctl');
    const inside = path.join(envctl, 'sources', 'web', 'notes');
    const outside = path.join(tempRoot, 'outside');
    fs.writeFileSync(
      path.join(envctl, 'manifest.yaml'),
      [
        'apiVersion: dshenv/v1',
        'profiles:',
        '  web:',
        '    plugins:',
        '      notes:',
        "        package: '@acme/notes'",
        `        source: { type: local-link, path: '${inside}' }`,
        '      outside:',
        "        package: '@acme/outside'",
        `        source: { type: local-link, path: '${outside}' }`,
        ''
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(envctl, 'lock.json'),
      JSON.stringify({
        apiVersion: 'dshenv-lock/v1',
        profiles: { web: { plugins: { notes: { package: '@acme/notes', source: { type: 'local-link', path: inside, digest: 'd' } } } } }
      })
    );
    fs.mkdirSync(path.join(envctl, 'overlays'));
    fs.writeFileSync(
      path.join(envctl, 'overlays', 'laptop.yaml'),
      `apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      notes:\n        source: { type: local-file, path: '${inside}' }\n`
    );
    const target = path.join(tempRoot, 'moved');
    const moved = path.join(target, 'sources', 'web', 'notes');

    const preview = await run(['migrate', '--to', target]);
    expect(preview.stdout).toContain(`would rewrite manifest.yaml: ${inside} -> ${moved}`);
    expect(fs.readFileSync(path.join(envctl, 'manifest.yaml'), 'utf8')).toContain(inside);

    const result = await run(['migrate', '--to', target, '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).rewritten).toEqual([
      `manifest.yaml: ${inside} -> ${moved}`,
      `lock.json: ${inside} -> ${moved}`,
      `${path.join('overlays', 'laptop.yaml')}: ${inside} -> ${moved}`
    ]);
    const manifest = fs.readFileSync(path.join(target, 'manifest.yaml'), 'utf8');
    expect(manifest).toContain(moved);
    expect(manifest).toContain(outside);
    expect(manifest).not.toContain(envctl);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'lock.json'), 'utf8')).profiles.web.plugins.notes.source.path).toBe(moved);
    expect(fs.readFileSync(path.join(target, 'overlays', 'laptop.yaml'), 'utf8')).toContain(moved);
  });

  it('refuses a target that is not empty', async () => {
    await run(['init']);
    const target = path.join(tempRoot, 'busy');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'other'), '');
    const result = await run(['migrate', '--to', target, '--yes']);
    expect(result.code).toBe(3);
    expect(fs.existsSync(path.join(home, 'envctl', 'manifest.yaml'))).toBe(true);
  });

  it('refuses to move a directory that is not a dshenv environment', async () => {
    const project = path.join(tempRoot, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'notes.txt'), 'keep me');
    const result = await run(['migrate', '--to', path.join(tempRoot, 'moved'), '--yes', '--envctl-dir', project]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('is not a dshenv data directory');
    expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(tempRoot, 'moved'))).toBe(false);
  });

  it('refuses the old location after a migration, also for a command that was waiting for the lock', async () => {
    await run(['init']);
    const target = path.join(tempRoot, 'moved');
    expect((await run(['migrate', '--to', target, '--yes'])).code).toBe(0);

    for (const args of [['plan'], ['init'], ['adopt', path.join(tempRoot, 'none.yaml'), '--yes']]) {
      const result = await run(args);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain(`was moved to ${target}`);
    }
    expect(fs.readdirSync(path.join(home, 'envctl'))).toEqual(['dshenv.moved']);

    // A command that resolved its paths before the move only finds out once it holds the lock.
    const paths = resolveEnvironmentPaths({ cliDshHome: home });
    await expect(acquireEnvironmentLock(paths)).rejects.toThrow(`was moved to ${target}`);
    expect(fs.readdirSync(path.join(home, 'envctl'))).toEqual(['dshenv.moved']);
  });

  it('marks the old location before cleaning it, so a failed cleanup leaves no environment to start over in', async () => {
    await run(['init']);
    const envctl = path.join(home, 'envctl');
    fs.mkdirSync(path.join(envctl, 'skills', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(envctl, 'state.json'), JSON.stringify({ apiVersion: 'dshenv-state/v1', profiles: {} }));
    const realRm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (path.dirname(String(target)) === envctl && !['manifest.yaml', 'lock.json', 'state.json'].includes(path.basename(String(target)))) {
        throw new Error('busy');
      }
      return realRm(target, options);
    });
    let result;
    try {
      result = await run(['migrate', '--to', path.join(tempRoot, 'moved'), '--yes']);
    } finally {
      spy.mockRestore();
    }
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('could not be emptied');
    for (const name of ['manifest.yaml', 'lock.json', 'state.json']) {
      expect(fs.existsSync(path.join(envctl, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(tempRoot, 'moved', 'manifest.yaml'))).toBe(true);
    const init = await run(['init']);
    expect(init.code).toBe(3);
    expect(init.stderr).toContain(`was moved to ${path.join(tempRoot, 'moved')}`);
  });

  it('rewrites paths into the old envctl in snapshots too, so a rollback does not point back at it', async () => {
    await run(['init']);
    const envctl = path.join(home, 'envctl');
    const inside = path.join(envctl, 'sources', 'web', 'notes');
    const snapshot = path.join(envctl, 'backups', '2026-10-08T00-00-00-000Z-apply-abc');
    fs.mkdirSync(path.join(snapshot, 'overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(snapshot, 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      notes:\n        package: '@acme/notes'\n        source: { type: local-link, path: '${inside}' }\n`
    );
    fs.writeFileSync(
      path.join(snapshot, 'overlays', 'laptop.yaml'),
      `apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      notes:\n        source: { type: local-file, path: '${inside}' }\n`
    );
    const target = path.join(tempRoot, 'moved');
    const moved = path.join(target, 'sources', 'web', 'notes');
    const snapshotFile = (name: string) => path.join('backups', path.basename(snapshot), name);

    const result = await run(['migrate', '--to', target, '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).rewritten).toEqual([
      `${snapshotFile('manifest.yaml')}: ${inside} -> ${moved}`,
      `${snapshotFile(path.join('overlays', 'laptop.yaml'))}: ${inside} -> ${moved}`
    ]);
    expect(fs.readFileSync(path.join(target, snapshotFile('manifest.yaml')), 'utf8')).toContain(moved);
    expect(fs.readFileSync(path.join(target, snapshotFile(path.join('overlays', 'laptop.yaml'))), 'utf8')).not.toContain(envctl);
  });

  it.skipIf(process.platform === 'win32')('refuses a target inside envctl, also through a linked envctl', async () => {
    await run(['init']);
    const inside = await run(['migrate', '--to', path.join(home, 'envctl', 'nested'), '--yes']);
    expect(inside.code).toBe(3);
    expect(inside.stderr).toContain('one contains the other');

    const real = path.join(tempRoot, 'real');
    fs.renameSync(path.join(home, 'envctl'), real);
    fs.symlinkSync(real, path.join(home, 'envctl'));
    const throughLink = await run(['migrate', '--to', path.join(real, 'nested'), '--yes']);
    expect(throughLink.code).toBe(3);
    expect(throughLink.stderr).toContain('one contains the other');
    expect(fs.existsSync(path.join(real, 'manifest.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(real, 'nested'))).toBe(false);

    // As macOS's /var is a link to /private/var: the target names the real directory through a linked ancestor.
    const alias = path.join(tempRoot, 'alias');
    fs.symlinkSync(tempRoot, alias);
    const throughAncestor = await run(['migrate', '--to', path.join(alias, 'real', 'nested'), '--yes']);
    expect(throughAncestor.code).toBe(3);
    expect(throughAncestor.stderr).toContain('one contains the other');
  });

  it('has plan reinstall a local plugin DSH still links from the old envctl', async () => {
    await run(['init']);
    const envctl = path.join(home, 'envctl');
    const inside = path.join(envctl, 'sources', 'web', 'notes');
    fs.mkdirSync(inside, { recursive: true });
    fs.writeFileSync(path.join(inside, 'package.json'), JSON.stringify({ name: '@acme/notes', version: '1.0.0' }));
    fs.writeFileSync(
      path.join(envctl, 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      notes:\n        package: '@acme/notes'\n        source: { type: local-link, path: '${inside}' }\n`
    );
    fs.writeFileSync(
      path.join(envctl, 'lock.json'),
      JSON.stringify({
        apiVersion: 'dshenv-lock/v1',
        profiles: { web: { plugins: { notes: { package: '@acme/notes', source: { type: 'local-link', path: inside } } } } }
      })
    );
    const profile = path.join(home, 'profiles', 'web');
    fs.mkdirSync(path.join(profile, 'node_modules', '@acme'), { recursive: true });
    fs.symlinkSync(inside, path.join(profile, 'node_modules', '@acme', 'notes'), 'junction');
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: { '@acme/notes': `link:${inside}` } }));
    const target = path.join(tempRoot, 'moved');

    expect((await run(['migrate', '--to', target, '--yes'])).code).toBe(0);
    // DSH's link now points at the deleted directory, so plan sees the plugin as missing and apply installs it from the new path.
    const plan = await run(['plan', '--envctl-dir', target]);
    expect(plan.code).toBe(2);
    expect(plan.stdout).toContain('+ [web] @acme/notes (notes)');
    expect(plan.stdout).toContain('not installed in profile');
  });

  it.skipIf(process.platform === 'win32')('treats a trailing separator on a symlinked envctl as the link itself', async () => {
    const real = path.join(tempRoot, 'real');
    await run(['init', '--envctl-dir', real]);
    fs.writeFileSync(path.join(real, 'notes.txt'), 'keep me');
    const link = path.join(tempRoot, 'link');
    fs.symlinkSync(real, link);

    const plan = await run(['plan', '--envctl-dir', `${link}${path.sep}`]);
    expect(plan.code).toBe(3);
    expect(plan.stderr).toContain(`${link} is a symlink`);

    const target = path.join(tempRoot, 'moved');
    const result = await run(['migrate', '--to', target, '--yes', '--json', '--envctl-dir', `${link}${path.sep}`]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).linked).toEqual([link]);
    expect(fs.readFileSync(path.join(real, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(real, 'manifest.yaml'))).toBe(true);
  });

  it('rewrites the overlays a snapshot keeps, and leaves a snapshot it cannot read as it is', async () => {
    await run(['init']);
    const envctl = path.join(home, 'envctl');
    const inside = path.join(envctl, 'sources', 'web', 'notes');
    const snapshot = path.join(envctl, 'backups', '2026-10-08T00-00-00-000Z-apply-abc');
    fs.mkdirSync(path.join(snapshot, 'existing-overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(snapshot, 'existing-overlays', 'laptop.yaml'),
      `apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      notes:\n        source: { type: local-file, path: '${inside}' }\n`
    );
    const broken = path.join(envctl, 'backups', '2026-10-07T00-00-00-000Z-apply-old');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'manifest.yaml'), `apiVersion: dshenv/v0\nsomething: '${inside}'\n`);
    fs.mkdirSync(path.join(envctl, 'backups', '.partial-xyz'));
    fs.writeFileSync(path.join(envctl, 'backups', '.partial-xyz', 'manifest.yaml'), 'not: [valid');
    const target = path.join(tempRoot, 'moved');
    const moved = path.join(target, 'sources', 'web', 'notes');

    const result = await run(['migrate', '--to', target, '--yes', '--json']);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.rewritten).toEqual([`${path.join('backups', path.basename(snapshot), 'existing-overlays', 'laptop.yaml')}: ${inside} -> ${moved}`]);
    expect(json.skipped).toEqual([path.join('backups', path.basename(broken), 'manifest.yaml')]);
    expect(fs.readFileSync(path.join(target, 'backups', path.basename(snapshot), 'existing-overlays', 'laptop.yaml'), 'utf8')).toContain(moved);
  });

  it('names the file when the manifest cannot be read', async () => {
    await run(['init']);
    fs.writeFileSync(path.join(home, 'envctl', 'manifest.yaml'), 'apiVersion: [broken');
    const result = await run(['migrate', '--to', path.join(tempRoot, 'moved')]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('manifest.yaml');
    expect(fs.existsSync(path.join(tempRoot, 'moved'))).toBe(false);
  });

  it('says where envctl went when migrate runs again, and can move it back', async () => {
    await run(['init']);
    const envctl = path.join(home, 'envctl');
    const target = path.join(tempRoot, 'moved');
    expect((await run(['migrate', '--to', target, '--yes'])).code).toBe(0);

    const again = await run(['migrate', '--to', path.join(tempRoot, 'other'), '--yes']);
    expect(again.code).toBe(3);
    expect(again.stderr).toContain(`was moved to ${target}`);

    const back = await run(['migrate', '--to', envctl, '--yes', '--envctl-dir', target]);
    expect(back.code).toBe(0);
    expect(fs.existsSync(path.join(envctl, 'dshenv.moved'))).toBe(false);
    expect(fs.existsSync(path.join(envctl, 'manifest.yaml'))).toBe(true);
    expect((await run(['plan'])).code).toBe(0);
  });

  it('does not mistake an unreadable marker for no marker', async () => {
    await run(['init']);
    fs.mkdirSync(path.join(home, 'envctl', 'dshenv.moved'));
    const result = await run(['plan']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('dshenv.moved');
  });

  it('holds the environment lock while init writes', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: home });
    const held = await acquireEnvironmentLock(paths);
    try {
      const result = await run(['init']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Environment lock is already held');
      expect(fs.existsSync(path.join(home, 'envctl', 'manifest.yaml'))).toBe(false);
    } finally {
      await held.release();
    }
  }, 15_000);

  it('lets only one of two envctls migrated into the same empty directory at once land there', async () => {
    const sources = [path.join(tempRoot, 'a'), path.join(tempRoot, 'b')];
    for (const dir of sources) {
      expect((await run(['init', '--envctl-dir', dir])).code).toBe(0);
      fs.writeFileSync(path.join(dir, `from-${path.basename(dir)}`), '');
    }
    const target = path.join(tempRoot, 'target');
    fs.mkdirSync(target);

    const results = await Promise.allSettled(
      sources.map((dir) => migrateEnvctl(resolveEnvironmentPaths({ cliDshHome: home, cliEnvctlDir: dir }), target))
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [winner, loser] = results[0].status === 'fulfilled' ? sources : [...sources].reverse();
    expect(fs.existsSync(path.join(target, `from-${path.basename(winner)}`))).toBe(true);
    expect(fs.existsSync(path.join(target, `from-${path.basename(loser)}`))).toBe(false);
    expect(fs.existsSync(path.join(loser, 'dshenv.moved'))).toBe(false);
    expect(fs.existsSync(path.join(loser, 'manifest.yaml'))).toBe(true);
    expect(fs.readdirSync(tempRoot).filter((name) => name.includes('dshenv-migrate'))).toEqual([]);
  });

  it('finishes a migrate killed after the copy landed but before the old envctl was marked', async () => {
    await run(['init']);
    const envctl = path.join(home, 'envctl');
    const target = path.join(tempRoot, 'moved');
    const writeFile = fs.promises.writeFile;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file).endsWith('dshenv.moved')) {
        throw new Error('killed');
      }
      return writeFile(file, data, options);
    });
    try {
      expect((await run(['migrate', '--to', target, '--yes'])).code).not.toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(target, 'manifest.yaml'))).toBe(true);

    const again = await run(['migrate', '--to', target, '--yes']);
    expect(again.code).toBe(0);
    expect(fs.readdirSync(envctl)).toEqual(['dshenv.moved']);
    expect(fs.existsSync(path.join(target, 'manifest.yaml'))).toBe(true);
  });

  it('says how to clear a target that holds something other than this envctl', async () => {
    await run(['init']);
    const target = path.join(tempRoot, 'moved');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'other'), '');
    const result = await run(['migrate', '--to', target, '--yes']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('delete it and migrate again');
    expect(fs.existsSync(path.join(target, 'other'))).toBe(true);
  });

  it('points at migrate when the new location is empty but the default one has a manifest', async () => {
    await run(['init']);
    const target = path.join(tempRoot, 'new');
    const result = await run(['status', '--envctl-dir', target]);
    expect(result.stderr).toContain(`dshenv migrate --to ${target} --yes`);
    // Starting a separate environment there is no unfinished migration.
    expect((await run(['init', '--envctl-dir', target])).stderr).not.toContain('dshenv migrate');
  });
});
