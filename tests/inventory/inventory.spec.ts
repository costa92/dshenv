import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { renderPatchBlock } from '../../src/patch/patch.js';
import { writeMount } from '../../src/patch/mount.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeProfile(
  home: string,
  profileName: string,
  input: {
    bundles?: string[];
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }
): string {
  const profileDir = path.join(home, 'profiles', profileName);
  fs.mkdirSync(profileDir, { recursive: true });
  writeJson(path.join(profileDir, 'package.json'), {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: input.dependencies ?? {},
    ...(input.optionalDependencies ? { optionalDependencies: input.optionalDependencies } : {}),
    dsh: {
      profile: {
        bundles: input.bundles ?? []
      }
    }
  });
  return profileDir;
}

describe('readEnvironmentInventory', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inv-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('flags a patch file the old flow-array append left invalid as repairable', async () => {
    const profileDir = writeProfile(tempHome, 'web', {});
    const block = renderPatchBlock('web', 'demo', 'p1', { a: 1 });
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `[{id: existing}]\n\n${block}\n`);
    writeProfile(tempHome, 'api', {});
    fs.writeFileSync(path.join(tempHome, 'profiles', 'api', 'cordis.patch.yml'), `- id: existing\n\n${block.replace('profile=web', 'profile=api').replace('profile=web', 'profile=api')}\n`);

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    expect(inventory.profiles.web.patchFileRepairable).toBe(true);
    expect(inventory.profiles.api.patchFileRepairable).toBeFalsy();
  });

  it('should read dsh.profile.bundles and dependencies from package.json, not profile.json', async () => {
    const profileDir = writeProfile(tempHome, 'web', {
      bundles: ['@deepseek-ai/dsh-base', '@nanmicoder/dsh-agent-teams'],
      dependencies: {
        '@nanmicoder/dsh-agent-teams': '0.1.21'
      }
    });
    writeJson(path.join(profileDir, 'profile.json'), {
      plugins: {
        'should-not-appear': { enabled: true }
      }
    });
    writeJson(
      path.join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'),
      { name: '@nanmicoder/dsh-agent-teams', version: '0.1.21', dsh: { bundle: {} } }
    );

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    const web = inventory.profiles.web;
    expect(web).toBeDefined();
    expect(web.plugins['should-not-appear']).toBeUndefined();
    expect(web.plugins['@deepseek-ai/dsh-base']?.sourceType).toBe('in-box');
    expect(web.plugins['@deepseek-ai/dsh-base']?.enabled).toBe(true);
    expect(web.plugins['@nanmicoder/dsh-agent-teams']?.sourceType).toBe('npm');
    expect(web.plugins['@nanmicoder/dsh-agent-teams']?.version).toBe('0.1.21');
    expect(web.plugins['@nanmicoder/dsh-agent-teams']?.enabled).toBe(true);
  });

  it('should classify pnpm-style in-profile symlinks as npm when the dependency spec is a version', async () => {
    const profileDir = writeProfile(tempHome, 'web', {
      bundles: ['@nanmicoder/dsh-agent-teams'],
      dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.21' }
    });
    const realPkg = path.join(
      profileDir,
      'node_modules',
      '.pnpm',
      '@nanmicoder+dsh-agent-teams@0.1.21',
      'node_modules',
      '@nanmicoder',
      'dsh-agent-teams'
    );
    writeJson(path.join(realPkg, 'package.json'), {
      name: '@nanmicoder/dsh-agent-teams',
      version: '0.1.21'
    });
    const linkParent = path.join(profileDir, 'node_modules', '@nanmicoder');
    fs.mkdirSync(linkParent, { recursive: true });
    fs.symlinkSync(realPkg, path.join(linkParent, 'dsh-agent-teams'));

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    const pkg = inventory.profiles.web.plugins['@nanmicoder/dsh-agent-teams'];
    expect(pkg.sourceType).toBe('npm');
    expect(pkg.version).toBe('0.1.21');
    expect(pkg.isSymlink).toBe(true);
    expect(pkg.isExternalSymlink).toBe(false);
  });

  it('should not treat transitive node_modules packages as plugins', async () => {
    const profileDir = writeProfile(tempHome, 'web', {
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: {}
    });
    writeJson(path.join(profileDir, 'node_modules', 'lodash', 'package.json'), {
      name: 'lodash',
      version: '4.17.21'
    });

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    expect(inventory.profiles.web.plugins.lodash).toBeUndefined();
  });

  it('should mark dependencies absent from bundles as installed but disabled', async () => {
    const profileDir = writeProfile(tempHome, 'web', {
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: { 'dsh-hello-plugin': '0.1.0' }
    });
    writeJson(path.join(profileDir, 'node_modules', 'dsh-hello-plugin', 'package.json'), {
      name: 'dsh-hello-plugin',
      version: '0.1.0'
    });

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    const pkg = inventory.profiles.web.plugins['dsh-hello-plugin'];
    expect(pkg.installed).toBe(true);
    expect(pkg.enabled).toBe(false);
    expect(pkg.sourceType).toBe('npm');
  });

  it('should classify git, file, and link specs from package.json, not from symlink type', async () => {
    const localDir = path.join(tempHome, 'local-pkg');
    writeJson(path.join(localDir, 'package.json'), { name: 'my-local-pkg', version: '1.0.0' });
    const fileDir = path.join(tempHome, 'file-pkg');
    writeJson(path.join(fileDir, 'package.json'), { name: 'my-file-pkg', version: '2.0.0' });

    const profileDir = writeProfile(tempHome, 'web', {
      bundles: ['my-local-pkg', 'my-file-pkg', 'my-git-pkg'],
      dependencies: {
        'my-local-pkg': `link:${localDir}`,
        'my-file-pkg': `file:${fileDir}`,
        'my-git-pkg': 'github:example/my-git-pkg#abcdef1'
      }
    });
    writeJson(path.join(profileDir, 'node_modules', 'my-git-pkg', 'package.json'), {
      name: 'my-git-pkg',
      version: '0.0.0'
    });
    fs.symlinkSync(localDir, path.join(profileDir, 'node_modules', 'my-local-pkg'));
    fs.symlinkSync(fileDir, path.join(profileDir, 'node_modules', 'my-file-pkg'));

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    const plugins = inventory.profiles.web.plugins;
    expect(plugins['my-local-pkg'].sourceType).toBe('local-link');
    expect(plugins['my-local-pkg'].resolvedSource).toBe(localDir);
    expect(plugins['my-file-pkg'].sourceType).toBe('local-file');
    expect(plugins['my-git-pkg'].sourceType).toBe('git');
    expect(plugins['my-git-pkg'].resolvedSource).toBe('github:example/my-git-pkg#abcdef1');
  });

  it('should not read package metadata through an external symlink', async () => {
    const outsideDir = path.join(tempHome, 'outside-pkg');
    writeJson(path.join(outsideDir, 'package.json'), {
      name: 'evil',
      version: '99.99.99-pwned'
    });
    const profileDir = writeProfile(tempHome, 'web', {
      bundles: ['evil'],
      dependencies: { evil: `link:${outsideDir}` }
    });
    fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(profileDir, 'node_modules', 'evil'));

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    const pkg = inventory.profiles.web.plugins.evil;
    expect(pkg.sourceType).toBe('local-link');
    expect(pkg.isExternalSymlink).toBe(true);
    expect(pkg.version).toBeUndefined();
    expect(pkg.rawPackageJson).toBeUndefined();
    expect(pkg.installed).toBe(true);
  });

  it('tells plugin packages that are not DSH bundles apart, and counts them enabled only when mounted', async () => {
    const profileDir = writeProfile(tempHome, 'web', {
      bundles: ['@acme/bundle'],
      dependencies: { '@acme/bundle': '1.0.0', '@acme/plain': '1.0.0', '@acme/other-plain': '1.0.0' }
    });
    writeJson(path.join(profileDir, 'node_modules', '@acme', 'bundle', 'package.json'), { name: '@acme/bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } });
    writeJson(path.join(profileDir, 'node_modules', '@acme', 'plain', 'package.json'), { name: '@acme/plain', version: '1.0.0' });
    writeJson(path.join(profileDir, 'node_modules', '@acme', 'other-plain', 'package.json'), { name: '@acme/other-plain', version: '1.0.0' });
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), writeMount('[]\n', 'web', 'plain', '@acme/plain'));

    const plugins = (await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }))).profiles.web.plugins;
    expect(plugins['@acme/bundle']).toMatchObject({ bundle: true, enabled: true });
    expect(plugins['@acme/plain']).toMatchObject({ bundle: false, enabled: true });
    expect(plugins['@acme/other-plain']).toMatchObject({ bundle: false, enabled: false });
  });

  it('tells a linked package that is not a DSH bundle apart, as DSH reads it through the link', async () => {
    const plain = path.join(tempHome, 'plain-src');
    const bundle = path.join(tempHome, 'bundle-src');
    writeJson(path.join(plain, 'package.json'), { name: 'plain', version: '1.0.0' });
    writeJson(path.join(bundle, 'package.json'), { name: 'bundled', version: '1.0.0', dsh: { bundle: {} } });
    const profileDir = writeProfile(tempHome, 'web', { dependencies: { plain: `link:${plain}`, bundled: `link:${bundle}` } });
    fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
    fs.symlinkSync(plain, path.join(profileDir, 'node_modules', 'plain'));
    fs.symlinkSync(bundle, path.join(profileDir, 'node_modules', 'bundled'));

    const plugins = (await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }))).profiles.web.plugins;
    expect(plugins.plain).toMatchObject({ sourceType: 'local-link', bundle: false, rawPackageJson: undefined });
    expect(plugins.bundled).toMatchObject({ sourceType: 'local-link', bundle: true });
  });

  it('should skip directories that are not DSH profiles', async () => {
    writeProfile(tempHome, 'web', { bundles: ['@deepseek-ai/dsh-base'] });
    const other = path.join(tempHome, 'profiles', 'random-dir');
    fs.mkdirSync(other, { recursive: true });
    writeJson(path.join(other, 'package.json'), { name: 'not-a-profile' });

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    expect(Object.keys(inventory.profiles)).toEqual(['web']);
  });

  // A FIFO reports size 0, and reading it blocks until a writer comes, which never happens.
  it.skipIf(process.platform === 'win32')('reports files that are not regular files instead of blocking on them', async () => {
    const mkfifo = (file: string) => execFileSync('mkfifo', [file]);
    const fifoPackage = path.join(tempHome, 'profiles', 'fifo');
    fs.mkdirSync(fifoPackage, { recursive: true });
    mkfifo(path.join(fifoPackage, 'package.json'));
    const fifoPatch = writeProfile(tempHome, 'patched', {});
    mkfifo(path.join(fifoPatch, 'cordis.patch.yml'));
    const web = writeProfile(tempHome, 'web', { bundles: ['demo'], dependencies: { demo: '1.0.0' } });
    fs.mkdirSync(path.join(web, 'node_modules', 'demo'), { recursive: true });
    mkfifo(path.join(web, 'node_modules', 'demo', 'package.json'));
    mkfifo(path.join(tempHome, 'cordis.patch.yml'));

    const inventory = await readEnvironmentInventory(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    expect(Object.keys(inventory.profiles)).toEqual(['web']);
    expect(inventory.profiles.web.plugins.demo.version).toBeUndefined();
    expect(inventory.invalidProfiles?.fifo).toMatch(/^Profile 'fifo' exists at .* but has a package\.json that is not a readable JSON file/);
    expect(inventory.invalidProfiles?.patched).toMatch(/its cordis\.patch\.yml is not a regular file/);
    expect(inventory.homePatchesError).toMatch(/cordis\.patch\.yml is not a regular file$/);
  });
});
