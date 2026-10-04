import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as YAML from 'yaml';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { pullProfilePatches } from '../../src/import/pull.js';
import { applyEnvironment } from '../../src/apply/apply.js';
import { loadLock, loadManifest, loadState, parseOverlay } from '../../src/manifest/files.js';
import { readSelectionFile } from '../../src/overlay/selection.js';
import { readProfilePatchState } from '../../src/profile-patches/entries.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { LOCAL_OVERLAY, writeRemoteOwnedFixture } from '../helpers/remote-fixture.js';
import { readRemoteConfig, sha256Hex, writeRemoteConfig } from '../../src/remote/schema.js';

const HEADER = '# Your patch layer for this dsh profile\n';
const LOCALE = { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } };
const SKILLS = { id: 'skill-filesystem', config: { customSkillDirs: ['/home/me/skills'] } };

describe('pullProfilePatches', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  const patchFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const base = () => loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const overlay = (name = 'local') => {
    const file = path.join(paths.overlaysDir, `${name}.yaml`);
    return parseOverlay(fs.readFileSync(file, 'utf8'), file);
  };
  const live = () => readProfilePatchState(fs.readFileSync(patchFile(), 'utf8'), 'web');
  const pull = (options: Partial<Parameters<typeof pullProfilePatches>[1]> = {}) =>
    pullProfilePatches(paths, { selection: null, allowOverlayCreation: true, ...options });
  const planOperations = async () => (await applyEnvironment(paths, { dryRun: true, overlay: readSelectionFile(paths) ? { name: readSelectionFile(paths)!, via: 'file' } : null })).plan;

  const setupProfile = (home: string) => {
    const profileDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `${HEADER}${YAML.stringify([LOCALE, SKILLS])}`);
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-pull-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    setupProfile(tempHome);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('takes entries written in DSH into the manifest, machine-local paths into a local overlay, and leaves a clean plan', async () => {
    const result = await pull();
    expect(result.changes).toMatchObject([{ profile: 'web', added: ['locale', 'skill-filesystem'], base: 1, overlay: 1, overlayName: 'local' }]);
    expect(result.overlayCreated).toBe('local');

    expect(base().profiles.web).toEqual({ plugins: {}, patches: [LOCALE] });
    expect(overlay().profiles?.web?.patches).toEqual([SKILLS]);
    expect(readSelectionFile(paths)).toBe('local');

    const state = live();
    expect(state.unmanaged).toEqual([]);
    expect(state.block).toMatchObject({ entries: [LOCALE, SKILLS], isDigestValid: true });
    expect(fs.readFileSync(patchFile(), 'utf8').startsWith(HEADER)).toBe(true);
    expect((await planOperations()).operations).toEqual([]);
    expect((await pull()).changes).toEqual([]);
  });

  it('takes an edit DSH made inside the block', async () => {
    await pull();
    fs.writeFileSync(patchFile(), fs.readFileSync(patchFile(), 'utf8').replace('preference: zh', 'preference: en'));

    const result = await pull({ selection: { name: 'local', via: 'file' } });
    expect(result.changes).toMatchObject([{ profile: 'web', changed: ['locale'], added: [], removed: [] }]);
    expect(base().profiles.web.patches).toEqual([{ ...LOCALE, config: { preference: 'en' } }]);
    expect(live().block?.isDigestValid).toBe(true);
  });

  it('writes nothing on a dry run', async () => {
    const before = fs.readFileSync(patchFile(), 'utf8');
    const result = await pull({ dryRun: true });
    expect(result.changes).toHaveLength(1);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(before);
    expect(base().profiles).toEqual({});
    expect(fs.existsSync(path.join(paths.overlaysDir, 'local.yaml'))).toBe(false);
    expect(readSelectionFile(paths)).toBeNull();
  });

  it('refuses when both DSH and the manifest changed, until a side is preferred', async () => {
    await pull();
    const manifest = base();
    manifest.profiles.web.patches = [{ ...LOCALE, config: { preference: 'fr' } }];
    fs.writeFileSync(paths.manifestFile, YAML.stringify(manifest));
    fs.writeFileSync(patchFile(), `${fs.readFileSync(patchFile(), 'utf8')}- id: extra\n  config: {}\n`);
    const selection = { name: 'local', via: 'file' as const };

    await expect(pull({ selection })).rejects.toThrow(/changed both in DSH and in the manifest.*--prefer dsh.*--prefer manifest/);

    await pull({ selection, prefer: 'manifest' });
    expect(base().profiles.web.patches).toEqual([{ ...LOCALE, config: { preference: 'fr' } }]);
    expect(live()).toMatchObject({ unmanaged: [], block: { isDigestValid: true, entries: [{ ...LOCALE, config: { preference: 'fr' } }, SKILLS] } });
  });

  it('keeps DSH when DSH is preferred in a conflict', async () => {
    await pull();
    const manifest = base();
    manifest.profiles.web.patches = [];
    fs.writeFileSync(paths.manifestFile, YAML.stringify(manifest));
    fs.writeFileSync(patchFile(), `${fs.readFileSync(patchFile(), 'utf8')}- id: extra\n  config: {}\n`);

    await pull({ selection: { name: 'local', via: 'file' }, prefer: 'dsh' });
    expect(base().profiles.web.patches).toEqual([LOCALE, { id: 'extra', config: {} }]);
  });

  it('with an overlay selected, takes only what DSH changed into the base and keeps what the overlay removes, adds or overrides', async () => {
    const MODEL = { id: 'model', config: { m: 'a' } };
    const overlayPatches = [{ id: 'locale', remove: true }, { id: 'extra', config: { a: 1 } }, { id: 'model', config: { m: 'b' } }];
    fs.writeFileSync(paths.manifestFile, YAML.stringify({ apiVersion: 'dshenv/v1', profiles: { web: { plugins: {}, patches: [LOCALE, MODEL] } } }));
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(path.join(paths.overlaysDir, 'work.yaml'), YAML.stringify({ apiVersion: 'dshenv-overlay/v1', profiles: { web: { patches: overlayPatches } } }));
    fs.writeFileSync(patchFile(), HEADER);
    const selection = { name: 'work', via: 'flag' as const };
    await applyEnvironment(paths, { dryRun: false, overlay: selection });
    fs.writeFileSync(patchFile(), `${fs.readFileSync(patchFile(), 'utf8')}- id: new\n  config: { b: 2 }\n`);

    const result = await pull({ selection });
    expect(result.changes).toMatchObject([{ profile: 'web', added: ['new'], changed: [], removed: [] }]);
    expect(base().profiles.web.patches).toEqual([LOCALE, MODEL, { id: 'new', config: { b: 2 } }]);
    expect(overlay('work').profiles?.web?.patches).toEqual(overlayPatches);
    expect((await applyEnvironment(paths, { dryRun: true, overlay: selection })).plan.operations).toEqual([]);

    // An edit to an entry the overlay overrides stays in the overlay.
    fs.writeFileSync(patchFile(), fs.readFileSync(patchFile(), 'utf8').replace('m: b', 'm: c'));
    await pull({ selection });
    expect(base().profiles.web.patches).toEqual([LOCALE, MODEL, { id: 'new', config: { b: 2 } }]);
    expect(overlay('work').profiles?.web?.patches).toContainEqual({ id: 'model', config: { m: 'c' } });
    expect(overlay('work').profiles?.web?.patches).toContainEqual({ id: 'locale', remove: true });
    expect((await applyEnvironment(paths, { dryRun: true, overlay: selection })).plan.operations).toEqual([]);
  });

  it('leaves a profile whose entries hold ${...} in DSH and still takes the rest', async () => {
    const dynamic = { id: 'skill-filesystem', config: { customSkillDirs: ['${HOME}/skills'] } };
    fs.writeFileSync(patchFile(), `${HEADER}${YAML.stringify([LOCALE, dynamic])}`);
    const before = fs.readFileSync(patchFile(), 'utf8');
    fs.mkdirSync(path.join(paths.dshSkillsDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(paths.dshSkillsDir, 'notes', 'SKILL.md'), 'notes');

    const result = await pull();
    expect(result.warnings).toEqual([expect.stringMatching(/profile 'web'.*\$\{\.\.\.\}.*left in .*cordis\.patch\.yml/)]);
    expect(result.changes).toEqual([]);
    expect(result.skills).toMatchObject({ added: ['notes'] });
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(before);
    expect(base().profiles).toEqual({});
  });

  it('refuses machine-local entries under --no-overlay', async () => {
    await expect(pull({ allowOverlayCreation: false })).rejects.toThrow(/machine-local paths.*overlay/);
    expect(base().profiles).toEqual({});
  });

  it('puts everything into a local overlay when a team remote owns the base', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-pull-remote-'));
    try {
      paths = await writeRemoteOwnedFixture(home);
      setupProfile(home);
      // This test uses its own home; the one beforeEach made would leak once afterEach removes this one instead.
      fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      tempHome = home;
      const manifestBefore = fs.readFileSync(paths.manifestFile, 'utf8');
      const selection = { name: 'mine', via: 'file' as const };

      const result = await pull({ selection });
      expect(result.changes).toMatchObject([{ base: 0, overlay: 2, overlayName: 'mine' }]);
      expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(manifestBefore);
      expect(overlay('mine').profiles?.web?.patches).toEqual([LOCALE, SKILLS]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('refuses in the preview too an overlay it would have to write that the team owns', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-pull-remote-'));
    try {
      paths = await writeRemoteOwnedFixture(home);
      setupProfile(home);
      fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      tempHome = home;
      fs.writeFileSync(path.join(paths.overlaysDir, 'local.yaml'), LOCAL_OVERLAY);
      const config = readRemoteConfig(paths)!;
      await writeRemoteConfig(paths, { ...config, files: { ...config.files, 'overlays/local.yaml': sha256Hex(LOCAL_OVERLAY) } });

      await expect(pull({ dryRun: true })).rejects.toThrow(/Overlay 'local' is owned by remote/);
      await expect(pull({ dryRun: true, selection: { name: 'team', via: 'file' } })).rejects.toThrow(/Overlay 'team' is owned by remote/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('keeps an override of a machine-local insert after it, in the overlay', async () => {
    const insert = { insert: [{ id: 'fs', config: { dir: '/home/me/fs' } }] };
    const override = { id: 'fs', config: { mode: 'rw' } };
    fs.writeFileSync(patchFile(), `${HEADER}${YAML.stringify([insert, override, LOCALE])}`);
    await pull();
    expect(base().profiles.web.patches).toEqual([LOCALE]);
    expect(overlay().profiles?.web?.patches).toEqual([insert, override]);
    expect(live().block?.entries).toEqual([LOCALE, insert, override]);
  });

  // The failure is injected with a read-only directory, which Windows does not enforce for new files.
  it.skipIf(process.platform === 'win32')('puts back patch files it already rewrote when a later profile fails', async () => {
    const other = path.join(tempHome, 'profiles', 'zzz');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
    fs.writeFileSync(path.join(other, 'cordis.patch.yml'), YAML.stringify([{ id: 'x', config: { a: 1 } }]));
    const before = fs.readFileSync(patchFile(), 'utf8');
    fs.chmodSync(other, 0o555);
    try {
      await expect(pull()).rejects.toThrow();
    } finally {
      fs.chmodSync(other, 0o755);
    }
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(before);
    expect(base().profiles).toEqual({});
  });

  it('is undone by rollback, which also drops the selection of the overlay it created', async () => {
    const result = await pull();
    await rollbackEnvironment(paths, { operationId: result.operationId });
    expect(base().profiles).toEqual({});
    expect(fs.existsSync(path.join(paths.overlaysDir, 'local.yaml'))).toBe(false);
    expect(readSelectionFile(paths)).toBeNull();
  });

  describe('plugins', () => {
    const profileDir = () => path.join(tempHome, 'profiles', 'web');
    const lock = () => loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
    const writeJson = (file: string, value: unknown) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    };
    const setProfile = (dependencies: Record<string, string>, bundles: string[]) =>
      writeJson(path.join(profileDir(), 'package.json'), { dependencies, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...bundles] } } });
    const installNpm = (name: string, version: string) =>
      writeJson(path.join(profileDir(), 'node_modules', ...name.split('/'), 'package.json'), { name, version, dsh: { bundle: {} } });
    const linkLocal = (name: string): string => {
      const source = path.join(tempHome, 'src', name);
      writeJson(path.join(source, 'package.json'), { name, version: '0.1.0', dsh: { bundle: {} } });
      fs.mkdirSync(path.join(profileDir(), 'node_modules'), { recursive: true });
      fs.symlinkSync(source, path.join(profileDir(), 'node_modules', name), 'junction');
      return source;
    };

    beforeEach(() => {
      fs.writeFileSync(patchFile(), '[]\n');
    });

    it('takes an npm plugin into the base manifest and locks it so plan has nothing to reinstall', async () => {
      setProfile({ '@acme/dsh-notes': '1.2.3' }, ['@acme/dsh-notes']);
      installNpm('@acme/dsh-notes', '1.2.3');

      const result = await pull();
      expect(result.plugins).toEqual([{ profile: 'web', alias: 'notes', package: '@acme/dsh-notes', sourceType: 'npm', enabled: true, layer: 'base' }]);
      expect(base().profiles.web.plugins).toEqual({ notes: { package: '@acme/dsh-notes', enabled: true, source: { type: 'npm', version: '1.2.3' } } });
      expect(lock().profiles.web.plugins.notes).toEqual({ package: '@acme/dsh-notes', source: { type: 'npm', resolvedVersion: '1.2.3' } });
      expect(fs.existsSync(path.join(paths.overlaysDir, 'local.yaml'))).toBe(false);
      const plan = await planOperations();
      expect(plan.operations).toEqual([]);
      expect(plan.unmanaged).toEqual([]);
      expect((await pull()).plugins).toBeUndefined();
    });

    it('does not take a plugin the base declares and the overlay removes, and says why', async () => {
      setProfile({ '@acme/dsh-notes': '1.2.3' }, ['@acme/dsh-notes']);
      installNpm('@acme/dsh-notes', '1.2.3');
      fs.writeFileSync(paths.manifestFile, YAML.stringify({ apiVersion: 'dshenv/v1', profiles: { web: { plugins: { notes: { package: '@acme/dsh-notes', source: { type: 'npm', version: '1.2.3' } } } } } }));
      fs.mkdirSync(paths.overlaysDir, { recursive: true });
      fs.writeFileSync(path.join(paths.overlaysDir, 'lap.yaml'), YAML.stringify({ apiVersion: 'dshenv-overlay/v1', profiles: { web: { plugins: { notes: { remove: true } } } } }));
      const manifestBefore = fs.readFileSync(paths.manifestFile, 'utf8');

      const result = await pull({ selection: { name: 'lap', via: 'flag' } });
      expect(result.plugins).toBeUndefined();
      expect(result.warnings).toEqual([expect.stringMatching(/@acme\/dsh-notes.*profile 'web'.*base manifest.*overlay 'lap' removes/)]);
      expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(manifestBefore);
    });

    it('takes a local-link plugin into a local overlay it creates and selects, with the digest plan checks', async () => {
      const source = linkLocal('dsh-im-hellotalk');
      setProfile({ 'dsh-im-hellotalk': `link:${source}` }, ['dsh-im-hellotalk']);

      const result = await pull();
      expect(result.plugins).toEqual([
        { profile: 'web', alias: 'im-hellotalk', package: 'dsh-im-hellotalk', sourceType: 'local-link', enabled: true, layer: 'overlay', overlayName: 'local' }
      ]);
      expect(result.overlayCreated).toBe('local');
      expect(base().profiles.web).toBeUndefined();
      expect(overlay().profiles?.web?.plugins).toEqual({
        'im-hellotalk': { package: 'dsh-im-hellotalk', enabled: true, source: { type: 'local-link', path: source } }
      });
      expect(readSelectionFile(paths)).toBe('local');
      expect(lock().profiles.web.plugins['im-hellotalk'].source).toMatchObject({ type: 'local-link', path: source, digest: expect.any(String) });
      const plan = await planOperations();
      expect(plan.operations).toEqual([]);
      expect(plan.unmanaged).toEqual([]);
    });

    it('takes a plugin DSH loads only through an insert row as disabled, with the row as a patch entry', async () => {
      setProfile({ '@acme/dsh-notes': '1.2.3' }, []);
      installNpm('@acme/dsh-notes', '1.2.3');
      const insert = { insert: [{ id: 'notes', name: '@acme/dsh-notes' }] };
      fs.writeFileSync(patchFile(), YAML.stringify([insert]));

      const result = await pull();
      expect(result.plugins).toMatchObject([{ alias: 'notes', enabled: false, layer: 'base' }]);
      expect(base().profiles.web).toEqual({
        plugins: { notes: { package: '@acme/dsh-notes', enabled: false, source: { type: 'npm', version: '1.2.3' } } },
        patches: [insert]
      });
      expect((await planOperations()).operations).toEqual([]);
    });

    it('writes nothing on a dry run', async () => {
      setProfile({ '@acme/dsh-notes': '1.2.3' }, ['@acme/dsh-notes']);
      installNpm('@acme/dsh-notes', '1.2.3');
      const result = await pull({ dryRun: true });
      expect(result.plugins).toHaveLength(1);
      expect(base().profiles).toEqual({});
      expect(fs.existsSync(paths.lockFile)).toBe(false);
      expect(fs.existsSync(paths.stateFile)).toBe(false);
    });

    it('takes only the profile given', async () => {
      setProfile({ '@acme/dsh-notes': '1.2.3' }, ['@acme/dsh-notes']);
      installNpm('@acme/dsh-notes', '1.2.3');
      const other = path.join(tempHome, 'profiles', 'cli');
      writeJson(path.join(other, 'package.json'), { dependencies: { '@acme/dsh-todo': '2.0.0' }, dsh: { profile: { bundles: ['@acme/dsh-todo'] } } });
      writeJson(path.join(other, 'node_modules', '@acme', 'dsh-todo', 'package.json'), { name: '@acme/dsh-todo', version: '2.0.0', dsh: { bundle: {} } });

      const result = await pull({ profiles: ['cli'] });
      expect(result.plugins?.map((plugin) => plugin.profile)).toEqual(['cli']);
      expect(Object.keys(base().profiles)).toEqual(['cli']);
    });

    it('refuses a local-link plugin under --no-overlay', async () => {
      const source = linkLocal('dsh-im-hellotalk');
      setProfile({ 'dsh-im-hellotalk': `link:${source}` }, ['dsh-im-hellotalk']);
      await expect(pull({ allowOverlayCreation: false })).rejects.toThrow(/dsh-im-hellotalk.*machine-local path.*overlay/);
      expect(base().profiles).toEqual({});
      expect(fs.existsSync(paths.lockFile)).toBe(false);
    });

    it('records ownership as adopt does and is undone by rollback', async () => {
      setProfile({ '@acme/dsh-notes': '1.2.3' }, ['@acme/dsh-notes']);
      installNpm('@acme/dsh-notes', '1.2.3');
      const result = await pull();
      const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
      expect(state.resources?.plugin?.web?.['@acme/dsh-notes']).toMatchObject({ alias: 'notes', sourceType: 'npm', lockedVersion: '1.2.3', adoptedBy: result.operationId });

      await rollbackEnvironment(paths, { operationId: result.operationId });
      expect(base().profiles).toEqual({});
      expect(fs.existsSync(paths.lockFile)).toBe(false);
    });
  });

  describe('skills', () => {
    const writeFile = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const dshSkill = () => path.join(paths.dshSkillsDir, 'wiki', 'SKILL.md');
    const declaredSkill = () => path.join(paths.skillsDir, 'wiki', 'SKILL.md');

    beforeEach(() => {
      fs.writeFileSync(patchFile(), '[]\n');
      writeFile(dshSkill(), 'v1');
    });

    it('takes a skill DSH has into envctl/skills and leaves plan clean', async () => {
      const result = await pull();
      expect(result.skills).toEqual({ added: ['wiki'], changed: [], removed: [] });
      expect(fs.readFileSync(declaredSkill(), 'utf8')).toBe('v1');
      expect((await planOperations()).hasChanges).toBe(false);
      expect((await pull()).skills).toBeUndefined();
    });

    it('follows edits and deletions made in DSH', async () => {
      await pull();
      writeFile(dshSkill(), 'v2');
      expect((await pull()).skills).toEqual({ added: [], changed: ['wiki'], removed: [] });
      expect(fs.readFileSync(declaredSkill(), 'utf8')).toBe('v2');

      fs.rmSync(path.join(paths.dshSkillsDir, 'wiki'), { recursive: true });
      expect((await pull()).skills).toEqual({ added: [], changed: [], removed: ['wiki'] });
      expect(fs.existsSync(path.join(paths.skillsDir, 'wiki'))).toBe(false);
    });

    it('refuses a skill changed on both sides until a side is preferred', async () => {
      await pull();
      writeFile(dshSkill(), 'dsh');
      writeFile(declaredSkill(), 'manifest');
      await expect(pull()).rejects.toThrow(/wiki.*changed both in DSH and in the manifest/);
      await pull({ prefer: 'dsh' });
      expect(fs.readFileSync(declaredSkill(), 'utf8')).toBe('dsh');
    });

    it('writes nothing on a dry run and is undone by rollback', async () => {
      await pull({ dryRun: true });
      expect(fs.existsSync(paths.skillsDir)).toBe(false);
      const result = await pull();
      await rollbackEnvironment(paths, { operationId: result.operationId });
      expect(fs.existsSync(path.join(paths.skillsDir, 'wiki'))).toBe(false);
    });
  });
});
