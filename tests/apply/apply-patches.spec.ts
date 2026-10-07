import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as YAML from 'yaml';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { extractManagedPatches } from '../../src/patch/patch.js';
import { loadManifest } from '../../src/manifest/files.js';

describe('apply managed patches', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  const patchFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const writeManifest = (patches: string) =>
    fs.writeFileSync(
      paths.manifestFile,
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo:
        package: demo-plugin
        source: { type: npm, version: "1.0.0" }
${patches}`
    );
  const livePatchIds = () => extractManagedPatches(fs.readFileSync(patchFile(), 'utf8'), 'web').map((patch) => patch.id);

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-patches-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'demo-plugin': '1.0.0' }, dsh: { profile: { bundles: ['demo-plugin'] } } })
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('repairs a patch file the old append left invalid although every block already matches', async () => {
    writeManifest(`        patches:
          - { id: p1, config: { a: 1 } }
`);
    await applyEnvironment(paths);
    const blocks = fs.readFileSync(patchFile(), 'utf8');
    fs.writeFileSync(patchFile(), `[{id: user-owned, config: {}}]\n\n${blocks}`);

    const plan = (await applyEnvironment(paths, { dryRun: true })).plan;
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['configure']);
    await applyEnvironment(paths);

    const repaired = fs.readFileSync(patchFile(), 'utf8');
    expect(YAML.parseAllDocuments(repaired).flatMap((doc) => doc.errors)).toEqual([]);
    expect(YAML.parse(repaired).map((entry: { id: string }) => entry.id)).toEqual(['user-owned', 'p1']);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.hasChanges).toBe(false);
  });

  it('converges a plugin that declares several patches', async () => {
    writeManifest(`        patches:
          - { id: p1, config: { a: 1 } }
          - { id: p2, config: { b: 2 } }
`);
    await applyEnvironment(paths);
    expect(livePatchIds()).toEqual(['p1', 'p2']);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.hasChanges).toBe(false);
  });

  it('does not write a disabled patch and removes it once disabled', async () => {
    writeManifest(`        patches:
          - { id: p1, config: { a: 1 } }
          - { id: p2, config: { b: 2 } }
`);
    await applyEnvironment(paths);
    writeManifest(`        patches:
          - { id: p1, config: { a: 1 } }
          - { id: p2, config: { b: 2 }, enabled: false }
`);
    await applyEnvironment(paths);
    expect(livePatchIds()).toEqual(['p1']);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.hasChanges).toBe(false);
  });

  // DSH does not load a disabled plugin, so a patch of it fails at every start with "entry not found".
  it('clears the patches of a disabled plugin and writes them back once it is enabled again', async () => {
    const patches = `        patches:
          - { id: p1, config: { a: 1 } }
`;
    writeManifest(patches);
    await applyEnvironment(paths);
    writeManifest(`        enabled: false\n${patches}`);
    await applyEnvironment(paths);
    expect(livePatchIds()).toEqual([]);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.hasChanges).toBe(false);
    writeManifest(patches);
    await applyEnvironment(paths);
    expect(livePatchIds()).toEqual(['p1']);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.hasChanges).toBe(false);
  });

  it('clears managed blocks once the manifest drops all patches of a plugin', async () => {
    writeManifest(`        patches:
          - { id: p1, config: { a: 1 } }
`);
    await applyEnvironment(paths);
    writeManifest('');
    const plan = (await applyEnvironment(paths, { dryRun: true })).plan;
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['configure']);
    await applyEnvironment(paths);
    expect(livePatchIds()).toEqual([]);
  });
});

describe('plugin alias format', () => {
  it.each(['has space', 'line\nbreak'])('rejects alias %j, which cannot round-trip through a patch marker', (alias) => {
    const manifest = `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      ${JSON.stringify(alias)}:
        package: demo-plugin
        source: { type: npm, version: "1.0.0" }
`;
    expect(() => loadManifest(manifest)).toThrow(/alias/i);
  });
});
