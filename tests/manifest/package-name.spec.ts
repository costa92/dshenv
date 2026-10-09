import { describe, it, expect } from 'vitest';
import { loadManifest } from '../../src/manifest/files.js';
import { managedGitSourceDir } from '../../src/source/git.js';

const manifestWith = (pkg: string) => `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo:
        package: "${pkg}"
        source: { type: npm, version: "1.0.0" }
`;

describe('package names', () => {
  it.each(['.', '..', '.hidden', '@scope/..', '@./demo'])('rejects %j, which could name a directory outside its own', (pkg) => {
    expect(() => loadManifest(manifestWith(pkg))).toThrow();
  });

  it.each(['_demo', 'node_modules', 'favicon.ico', 'a'.repeat(215)])('rejects %j, which npm refuses', (pkg) => {
    expect(() => loadManifest(manifestWith(pkg))).toThrow();
  });

  it.each(['demo', '@scope/demo', 'dsh.plugin', 'a_b-c', '@scope/_demo', 'a'.repeat(214)])('accepts %j', (pkg) => {
    expect(loadManifest(manifestWith(pkg)).profiles.web.plugins.demo.package).toBe(pkg);
  });

  it.each(['.', '..'])('refuses %j as a managed source directory', (pkg) => {
    expect(() => managedGitSourceDir('/home/u/.dsh/envctl', 'web', pkg)).toThrow(/Invalid package name/);
  });
});
