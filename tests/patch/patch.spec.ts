import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import {
  computePatchDigest,
  renderPatchBlock,
  applyPatchBlock,
  removePatchBlock,
  replacePluginBlocks,
  extractManagedPatches,
  assertPatchFileArray,
  repairPatchFile
} from '../../src/patch/patch.js';

describe('Managed Patch Block Manager', () => {
  const sampleConfig = {
    taskPlanning: 'captain',
    maxIterations: 10
  };

  it('should compute deterministic patch digest', () => {
    const digest1 = computePatchDigest(sampleConfig);
    const digest2 = computePatchDigest({ maxIterations: 10, taskPlanning: 'captain' });
    expect(digest1).toBe(digest2);
    expect(digest1).toHaveLength(64);
  });

  it('should render well-formed patch block with digest marker', () => {
    const block = renderPatchBlock('web', 'agent-teams', 'agent-teams', sampleConfig);
    expect(block).toContain('# dshenv:begin profile=web plugin=agent-teams digest=');
    expect(block).toContain('- id: agent-teams');
    expect(block).toContain('# dshenv:end profile=web plugin=agent-teams');
  });

  it('should insert patch block and preserve external file content', () => {
    const originalFile = `# Header comment
unrelated_setting: true

# Another block
`;
    const updated = applyPatchBlock(originalFile, 'web', 'agent-teams', 'agent-teams', sampleConfig);
    expect(updated).toContain('# Header comment');
    expect(updated).toContain('unrelated_setting: true');
    expect(updated).toContain('# dshenv:begin profile=web plugin=agent-teams');
    expect(updated).toContain('# dshenv:end profile=web plugin=agent-teams');
  });

  it('should update existing patch block without modifying surrounding text', () => {
    const originalFile = `prefix: true
# dshenv:begin profile=web plugin=agent-teams digest=old
- id: agent-teams
  config:
    oldKey: true
# dshenv:end profile=web plugin=agent-teams
suffix: true
`;
    const updated = applyPatchBlock(originalFile, 'web', 'agent-teams', 'agent-teams', sampleConfig);
    expect(updated).toContain('prefix: true');
    expect(updated).toContain('suffix: true');
    expect(updated).not.toContain('oldKey: true');
    expect(updated).toContain('taskPlanning: captain');
  });

  it('should remove patch block cleanly and preserve outside content', () => {
    const fileWithBlock = `prefix: true
# dshenv:begin profile=web plugin=agent-teams digest=xyz
- id: agent-teams
  config:
    taskPlanning: captain
# dshenv:end profile=web plugin=agent-teams
suffix: true
`;
    const cleaned = removePatchBlock(fileWithBlock, 'web', 'agent-teams');
    expect(cleaned).toContain('prefix: true');
    expect(cleaned).toContain('suffix: true');
    expect(cleaned).not.toContain('dshenv:begin');
    expect(cleaned).not.toContain('agent-teams');
  });

  it('should extract managed patches and verify digests', () => {
    const fileContent = `
# dshenv:begin profile=web plugin=agent-teams digest=${computePatchDigest(sampleConfig)}
- id: agent-teams
  config:
    taskPlanning: captain
    maxIterations: 10
# dshenv:end profile=web plugin=agent-teams
`;
    const patches = extractManagedPatches(fileContent, 'web');
    expect(patches).toHaveLength(1);
    expect(patches[0].plugin).toBe('agent-teams');
    expect(patches[0].isDigestValid).toBe(true);
    expect(patches[0].config).toEqual(sampleConfig);
  });

  it('keeps every patch of a plugin, each in its own verifiable block', () => {
    const content = replacePluginBlocks('', 'web', 'demo', [
      { id: 'p1', config: { a: 1 } },
      { id: 'p2', config: { b: 2 } }
    ]);
    const patches = extractManagedPatches(content, 'web');
    expect(patches.map((patch) => [patch.id, patch.isDigestValid])).toEqual([['p1', true], ['p2', true]]);
  });

  it('rewrites all blocks of a plugin in place, dropping patches no longer declared', () => {
    const start = replacePluginBlocks('before: 1\n', 'web', 'demo', [
      { id: 'p1', config: { a: 1 } },
      { id: 'p2', config: { b: 2 } }
    ]) + 'after: 1\n';
    const next = replacePluginBlocks(start, 'web', 'demo', [{ id: 'p2', config: { b: 3 } }]);
    expect(extractManagedPatches(next, 'web').map((patch) => [patch.id, patch.config])).toEqual([['p2', { b: 3 }]]);
    expect(next.startsWith('before: 1\n')).toBe(true);
    expect(next.endsWith('after: 1\n')).toBe(true);
  });

  it('writes config values containing $ replacement patterns verbatim when updating a block', () => {
    const config = { tpl: 'x$$y', re: "end$'", all: 'a$&b' };
    const first = applyPatchBlock('', 'web', 'demo', 'demo', { tpl: 'old' });
    const updated = applyPatchBlock(first, 'web', 'demo', 'demo', config);
    const [patch] = extractManagedPatches(updated, 'web');
    expect(patch.config).toEqual(config);
    expect(patch.isDigestValid).toBe(true);
  });

  it('treats aliases literally instead of as regular expressions', () => {
    const both = applyPatchBlock(applyPatchBlock('', 'web', 'axb', 'axb', { k: 1 }), 'web', 'a.b', 'a.b', { k: 2 });
    expect(extractManagedPatches(removePatchBlock(both, 'web', 'a.b'), 'web').map((patch) => patch.plugin)).toEqual(['axb']);
    expect(() => applyPatchBlock('', 'web', 'c++', 'c++', { k: 1 })).not.toThrow();
    expect(extractManagedPatches(applyPatchBlock('', 'web', 'c++', 'c++', { k: 1 }), 'web')[0].plugin).toBe('c++');
  });

  it('inserts into a fresh profile patch file whose base is an empty flow array', () => {
    const originalFile = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
    const updated = applyPatchBlock(originalFile, 'web', 'demo', 'demo', { k: 1 });
    expect(() => YAML.parseAllDocuments(updated).forEach((doc) => doc.errors.forEach((error) => {
      throw error;
    }))).not.toThrow();
    expect(extractManagedPatches(updated, 'web')[0].config).toEqual({ k: 1 });
  });

  it.each([
    ['a comment after the array', '# head\n[]\n# tail note\n', ['# head\n', '# tail note\n']],
    ['a comment on the array line', '[]  # empty\n', ['# empty\n']],
    ['spaces inside the brackets', '[ ]\n', []],
    ['no trailing newline', '[]', []]
  ])('replaces an empty flow array with %s and keeps everything around it', (_name, originalFile, kept) => {
    const updated = applyPatchBlock(originalFile, 'web', 'demo', 'demo', { k: 1 });
    const docs = YAML.parseAllDocuments(updated);
    expect(docs).toHaveLength(1);
    expect(docs[0].errors).toEqual([]);
    expect(extractManagedPatches(updated, 'web')[0].config).toEqual({ k: 1 });
    for (const text of kept) expect(updated).toContain(text);
  });

  it('keeps a non-empty flow array valid by rewriting it as a block sequence', () => {
    const updated = applyPatchBlock('[{id: existing, config: {}}]\n', 'web', 'demo', 'demo', { k: 1 });
    const docs = YAML.parseAllDocuments(updated);
    expect(docs).toHaveLength(1);
    expect(docs[0].errors).toEqual([]);
    expect(YAML.parse(updated)).toEqual([{ id: 'existing', config: {} }, expect.objectContaining({ id: 'demo', config: { k: 1 } })]);
  });

  it.each(['~\n', 'null\n', '---\n', '# note\n~  # empty\n'])('treats a null document %j as an empty array', (originalFile) => {
    const updated = applyPatchBlock(originalFile, 'web', 'demo', 'demo', { k: 1 });
    expect(() => assertPatchFileArray(updated, 'cordis.patch.yml')).not.toThrow();
    expect(YAML.parse(updated)).toEqual([expect.objectContaining({ id: 'demo', config: { k: 1 } })]);
  });

  it('repairs a file the old append left invalid and keeps every managed block', () => {
    const other = renderPatchBlock('web', 'other', 'o1', { b: 1 });
    const broken = `[{id: existing, config: {}}]\n\n${other}\n`;
    expect(() => assertPatchFileArray(broken, 'cordis.patch.yml')).toThrow();

    const repaired = repairPatchFile(broken);
    expect(repaired).not.toBeNull();
    expect(() => assertPatchFileArray(repaired!, 'cordis.patch.yml')).not.toThrow();
    expect(YAML.parse(repaired!).map((entry: { id: string }) => entry.id)).toEqual(['existing', 'o1']);
    expect(repaired).toContain(other);
  });

  it('does not repair a file whose own content is not an array', () => {
    expect(repairPatchFile('keep: 1\n')).toBeNull();
  });

  it('leaves a top-level empty array when the last block leaves a fresh profile patch file', () => {
    const originalFile = '# Your patch layer for this dsh profile\n[]\n';
    const withBlock = applyPatchBlock(originalFile, 'web', 'demo', 'demo', { k: 1 });
    const cleared = removePatchBlock(withBlock, 'web', 'demo');
    // DSH refuses a profile patch file that is not a top-level array.
    expect(YAML.parse(cleared)).toEqual([]);
    expect(cleared.startsWith('# Your patch layer for this dsh profile\n')).toBe(true);
  });

  it('removes a block without collapsing blank lines elsewhere in the file', () => {
    const userContent = 'keep: 1\n\n\n\nother: 2\n';
    const withBlock = applyPatchBlock(userContent, 'web', 'demo', 'demo', { k: 1 });
    expect(removePatchBlock(withBlock, 'web', 'demo')).toBe(userContent);
  });
});

describe('plugin patch blocks with JavaScript expressions', () => {
  it('writes { __jsExpr } as a !!js value DSH evaluates, and reads it back with a valid digest', () => {
    const config = { when: { __jsExpr: 'ctx.ready' }, stateDir: '.sd' };
    const block = renderPatchBlock('web', 'agent-teams', 'agent-teams', config);
    expect(block).toContain("when: !!js ctx.ready");
    const [read] = extractManagedPatches(`${block}\n`, 'web');
    expect(read.config).toEqual(config);
    expect(read.isDigestValid).toBe(true);
  });
});
