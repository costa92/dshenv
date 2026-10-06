import { describe, it, expect } from 'vitest';
import {
  loadManifest,
  parseYamlStrict,
  serializeManifest,
  CaptureDocumentSchema
} from '../../src/manifest/index.js';
import { ValidationError } from '../../src/errors.js';

describe('Manifest schema and loader', () => {
  it('should parse valid manifest', () => {
    const yamlStr = `
apiVersion: dshenv/v1
environment:
  sourceRoot: /Users/costalong/code/dsh/plugins
  harness:
    sourceDir: /Users/costalong/code/dsh/deepseek-harness
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
        patches:
          - id: agent-teams
            config:
              taskPlanning: captain
`;
    const manifest = loadManifest(yamlStr);
    expect(manifest.apiVersion).toBe('dshenv/v1');
    expect(manifest.profiles.web.plugins['agent-teams'].package).toBe('@nanmicoder/dsh-agent-teams');
  });

  it('should reject manifest with wrong apiVersion', () => {
    const yamlStr = `
apiVersion: dshenv/v2
profiles: {}
`;
    expect(() => loadManifest(yamlStr)).toThrow(ValidationError);
  });

  it('should reject unknown fields (strict schema)', () => {
    const yamlStr = `
apiVersion: dshenv/v1
unknownField: 123
profiles: {}
`;
    expect(() => loadManifest(yamlStr)).toThrow(ValidationError);
  });

  it('should reject non-absolute local path', () => {
    const yamlStr = `
apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      local-plug:
        package: "local-plug"
        enabled: true
        source:
          type: local-link
          path: "./relative/path"
`;
    expect(() => loadManifest(yamlStr)).toThrow(ValidationError);
  });

  it('should reject duplicate package names under the same profile', () => {
    const yamlStr = `
apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      alias1:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
      alias2:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: false
        source:
          type: npm
          version: "0.1.22"
`;
    expect(() => loadManifest(yamlStr)).toThrow(/duplicate package/i);
  });

  it('should serialize manifest deterministically with single trailing newline', () => {
    const manifest = {
      apiVersion: 'dshenv/v1' as const,
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: {
                type: 'npm' as const,
                version: '0.1.21'
              }
            }
          }
        }
      }
    };
    const serialized = serializeManifest(manifest);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.endsWith('\n\n')).toBe(false);

    const reloaded = loadManifest(serialized);
    expect(reloaded).toEqual(manifest);
  });

  it('should reject YAML with too many aliases', () => {
    const plugins = Array.from({ length: 22 }, (_, i) => {
      const source = i === 0
        ? `        source: &src\n          type: npm\n          version: "1.0.0"`
        : `        source: *src`;
      return `      pkg-${i}:\n        package: "pkg-${i}"\n${source}`;
    }).join('\n');
    const yamlStr = `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n${plugins}\n`;
    expect(() => loadManifest(yamlStr)).toThrow(ValidationError);
  });

  it('should reject cyclic YAML aliases', () => {
    expect(() => parseYamlStrict('a: &a\n  b: *a\n')).toThrow(ValidationError);
  });

  it('should validate CaptureDocument schema', () => {
    const captureDoc = {
      apiVersion: 'dshenv-capture/v1' as const,
      manifest: {
        apiVersion: 'dshenv/v1' as const,
        profiles: {}
      },
      lock: {
        apiVersion: 'dshenv-lock/v1' as const,
        profiles: {}
      },
      warnings: ['warn1']
    };

    const parsed = CaptureDocumentSchema.parse(captureDoc);
    expect(parsed.apiVersion).toBe('dshenv-capture/v1');
    expect(parsed.warnings).toEqual(['warn1']);
  });

  it('keeps profile patch entries verbatim and requires an id or an insert list', () => {
    const manifest = loadManifest(`apiVersion: dshenv/v1
profiles:
  web:
    plugins: {}
    patches:
      - id: skill-filesystem
        disabled: false
        config: { includeDefaultRoots: false }
      - insert: [{ id: x, name: y }]
`);
    expect(manifest.profiles.web.patches).toEqual([
      { id: 'skill-filesystem', disabled: false, config: { includeDefaultRoots: false } },
      { insert: [{ id: 'x', name: 'y' }] }
    ]);
    expect(() => loadManifest('apiVersion: dshenv/v1\nprofiles:\n  web:\n    patches:\n      - config: {}\n')).toThrow(/needs an id or an insert list/);
  });

  it('reserves the @profile alias for the profile patch block', () => {
    expect(() =>
      loadManifest('apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      "@profile":\n        package: p\n        source: { type: in-box }\n')
    ).toThrow(/Plugin alias is reserved/);
    expect(() =>
      loadManifest('apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      "@mount:foo":\n        package: p\n        source: { type: in-box }\n')
    ).toThrow(/Plugin alias must not start with '@'/);
  });
});
