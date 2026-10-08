import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as YAML from 'yaml';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { pullProfilePatches } from '../../src/import/pull.js';
import { applyEnvironment } from '../../src/apply/apply.js';
import { loadManifest, parseOverlay, serializeManifest } from '../../src/manifest/files.js';
import { readSelectionFile } from '../../src/overlay/selection.js';
import { HOME_PATCH_TARGET, readProfilePatchState } from '../../src/profile-patches/entries.js';
import type { EnvironmentManifest } from '../../src/domain.js';
import { writeProfilePatches } from '../../src/apply/patches.js';
import { buildStatus } from '../../src/planner/plan.js';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';

const HEADER = '# Global machine patch layer for all dsh profiles\n';
const SUBAGENT = { id: 'tool-subagent', config: { maxDepth: 2 } };
const PROMPT = { id: 'system-prompt', config: { personaPrefix: 'Be brief.' } };
const LOCAL_TOOL = { insert: [{ id: 'my-tool', name: '@acme/my-tool', config: { cwd: '/home/me/tools' } }] };

describe('global cordis.patch.yml', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  const homeFile = () => path.join(tempHome, 'cordis.patch.yml');
  const profileFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const base = () => loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const writeBase = (manifest: EnvironmentManifest) => fs.writeFileSync(paths.manifestFile, serializeManifest(manifest));
  const homeState = () => readProfilePatchState(fs.readFileSync(homeFile(), 'utf8'), HOME_PATCH_TARGET);
  const selection = () => (readSelectionFile(paths) ? { name: readSelectionFile(paths)!, via: 'file' as const } : null);
  const pull = (options: Partial<Parameters<typeof pullProfilePatches>[1]> = {}) =>
    pullProfilePatches(paths, { selection: selection(), allowOverlayCreation: true, ...options });
  const plan = async (profile?: string) => (await applyEnvironment(paths, { dryRun: true, overlay: selection(), profile })).plan;
  const apply = () => applyEnvironment(paths, { overlay: selection(), executor: async () => ({ success: true }) });

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-global-patches-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
    fs.writeFileSync(profileFile(), '[]\n');
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('pulls the entries written by hand, machine-local ones into the local overlay, and leaves a clean plan', async () => {
    fs.writeFileSync(homeFile(), `${HEADER}${YAML.stringify([SUBAGENT, PROMPT, LOCAL_TOOL])}`);
    expect((await plan()).unmanagedHomePatches).toEqual(['tool-subagent', 'system-prompt', 'insert']);

    const result = await pull();
    expect(result.changes).toMatchObject([{ profile: HOME_PATCH_TARGET, added: ['tool-subagent', 'system-prompt', 'insert'], base: 2, overlay: 1 }]);
    expect(base().patches).toEqual([SUBAGENT, PROMPT]);
    const overlayFile = path.join(paths.overlaysDir, 'local.yaml');
    expect(parseOverlay(fs.readFileSync(overlayFile, 'utf8'), overlayFile).patches).toEqual([LOCAL_TOOL]);

    expect(fs.readFileSync(homeFile(), 'utf8').startsWith(HEADER)).toBe(true);
    expect(homeState()).toMatchObject({ unmanaged: [], block: { entries: [SUBAGENT, PROMPT, LOCAL_TOOL], isDigestValid: true } });
    const after = await plan();
    expect(after.operations).toEqual([]);
    expect(after.unmanagedHomePatches).toBeUndefined();
    expect((await pull()).changes).toEqual([]);
  });

  it('writes declared global patches into a new file, and empties it to [] once none are declared', async () => {
    writeBase({ apiVersion: 'dshenv/v1', profiles: {}, patches: [SUBAGENT] });
    expect((await plan()).operations).toEqual([{ resource: 'home-patch', kind: 'configure', reason: 'Global patches are not written yet' }]);

    await apply();
    expect(homeState()).toMatchObject({ unmanaged: [], block: { entries: [SUBAGENT], isDigestValid: true } });
    expect((await plan()).operations).toEqual([]);

    writeBase({ apiVersion: 'dshenv/v1', profiles: {} });
    expect((await plan()).operations).toMatchObject([{ resource: 'home-patch', reason: 'Global patches are no longer declared' }]);
    await apply();
    // An empty or comment-only file fails DSH's boot; an empty list is what it expects.
    expect(YAML.parse(fs.readFileSync(homeFile(), 'utf8'))).toEqual([]);
    expect((await plan()).operations).toEqual([]);
  });

  it('reports a hand edit inside the block, and pull keeps it', async () => {
    writeBase({ apiVersion: 'dshenv/v1', profiles: {}, patches: [SUBAGENT] });
    await apply();
    fs.writeFileSync(homeFile(), fs.readFileSync(homeFile(), 'utf8').replace('maxDepth: 2', 'maxDepth: 5'));

    expect((await plan()).operations).toMatchObject([{ resource: 'home-patch', reason: expect.stringContaining('edited by hand') }]);
    await pull();
    expect(base().patches).toEqual([{ ...SUBAGENT, config: { maxDepth: 5 } }]);
    expect((await plan()).operations).toEqual([]);
  });

  it('leaves the global file out of -p, which acts on one profile', async () => {
    fs.writeFileSync(homeFile(), YAML.stringify([SUBAGENT]));
    writeBase({ apiVersion: 'dshenv/v1', profiles: { web: { plugins: {} } }, patches: [PROMPT] });

    const narrowed = await plan('web');
    expect(narrowed.operations).toEqual([]);
    expect(narrowed.unmanagedHomePatches).toBeUndefined();
    expect((await pull({ profiles: ['web'] })).changes).toEqual([]);
    expect(homeState().unmanaged).toEqual([SUBAGENT]);
  });

  it('warns about profile entries the global file overrides, even when in sync', async () => {
    const own = { id: 'system-prompt', config: { personaPrefix: 'Web.' } };
    writeBase({ apiVersion: 'dshenv/v1', profiles: { web: { plugins: {}, patches: [own] } }, patches: [PROMPT] });
    await writeProfilePatches(paths, 'web', [own]);
    await writeProfilePatches(paths, HOME_PATCH_TARGET, [PROMPT]);
    const result = await plan();
    expect(result.hasChanges).toBe(false);
    expect(result.shadowedPatches).toEqual([{ profile: 'web', ids: ['system-prompt'] }]);
  });

  it('compares the fields each layer writes, and calls out a disabled the global file sets', async () => {
    const profileEntries = [
      { id: 'system-prompt', config: { personaPrefix: 'Web.' } },
      { id: 'tool-subagent', config: { maxDepth: 3 } },
      { id: 'tool-web', disabled: true }
    ];
    const globalEntries = [
      { id: 'system-prompt', config: { personaPrefix: 'Be brief.' } },
      { id: 'tool-subagent', disabled: true },
      { id: 'tool-web', config: { timeout: 5 } }
    ];
    writeBase({ apiVersion: 'dshenv/v1', profiles: { web: { plugins: {}, patches: profileEntries } }, patches: globalEntries });
    await writeProfilePatches(paths, 'web', profileEntries);
    await writeProfilePatches(paths, HOME_PATCH_TARGET, globalEntries);
    // tool-web: the profile writes only disabled, the global file only config, so neither replaces the other's field.
    expect((await plan()).shadowedPatches).toEqual([{ profile: 'web', ids: ['system-prompt', 'tool-subagent'], disabled: ['tool-subagent'] }]);
  });

  it('still warns about global overrides under -p, without planning the global file', async () => {
    const own = { id: 'system-prompt', config: { personaPrefix: 'Web.' } };
    writeBase({ apiVersion: 'dshenv/v1', profiles: { web: { plugins: {}, patches: [own] }, cli: { plugins: {}, patches: [own] } }, patches: [PROMPT] });
    await writeProfilePatches(paths, 'web', [own]);
    const narrowed = await plan('web');
    expect(narrowed.operations).toEqual([]);
    expect(narrowed.shadowedPatches).toEqual([{ profile: 'web', ids: ['system-prompt'] }]);
  });

  it('merges global patches of the selected overlay over the base ones', async () => {
    writeBase({ apiVersion: 'dshenv/v1', profiles: {}, patches: [SUBAGENT, PROMPT] });
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.overlaysDir, 'laptop.yaml'),
      YAML.stringify({ apiVersion: 'dshenv-overlay/v1', patches: [{ id: 'tool-subagent', config: { maxDepth: 1 } }, { id: 'system-prompt', remove: true }] })
    );
    await applyEnvironment(paths, { overlay: { name: 'laptop', via: 'flag' }, executor: async () => ({ success: true }) });
    expect(homeState().block?.entries).toEqual([{ id: 'tool-subagent', config: { maxDepth: 1 } }]);
  });

  it('counts the global layer in status, as plan does', async () => {
    const status = async () => buildStatus(base(), null, await readEnvironmentInventory(paths), await plan());
    fs.writeFileSync(homeFile(), YAML.stringify([SUBAGENT]));
    expect((await status()).status).toBe('unmanaged');

    writeBase({ apiVersion: 'dshenv/v1', profiles: {}, patches: [PROMPT] });
    fs.writeFileSync(homeFile(), '[]\n');
    expect((await status()).status).toBe('drifted');

    fs.writeFileSync(homeFile(), 'id: not-a-list\n');
    expect((await status()).status).toBe('degraded');

    await apply().catch(() => {});
    fs.writeFileSync(homeFile(), '[]\n');
    await apply();
    expect((await status()).status).toBe('healthy');
  });

  it('blocks apply on a global file it cannot parse, and pull still takes the profiles', async () => {
    fs.writeFileSync(homeFile(), 'id: not-a-list\n');
    fs.writeFileSync(profileFile(), YAML.stringify([PROMPT]));
    writeBase({ apiVersion: 'dshenv/v1', profiles: {}, patches: [SUBAGENT] });

    expect((await plan()).operations).toMatchObject([{ resource: 'home-patch', kind: 'blocked' }]);
    await expect(apply()).rejects.toThrow(/Apply is blocked: Cannot read/);
    expect(fs.readFileSync(homeFile(), 'utf8')).toBe('id: not-a-list\n');

    const result = await pull();
    expect(result.changes).toMatchObject([{ profile: 'web', added: ['system-prompt'] }]);
    expect(result.warnings).toEqual([expect.stringContaining('The global cordis.patch.yml was not pulled')]);
  });
});
