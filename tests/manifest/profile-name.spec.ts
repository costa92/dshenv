import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadLock, loadManifest, parseOverlay } from '../../src/manifest/files.js';

const manifestWith = (profile: string) => `apiVersion: dshenv/v1\nprofiles:\n  "${profile}":\n    plugins: {}\n`;
const overlayWith = (profile: string) => `apiVersion: dshenv-overlay/v1\nprofiles:\n  "${profile}":\n    plugins: {}\n`;
const lockWith = (profile: string) => JSON.stringify({ apiVersion: 'dshenv-lock/v1', profiles: { [profile]: { plugins: {} } } });

// A profile name becomes a directory under profiles/ and an option value for DSH.
describe('profile names', () => {
  it.each(['../outside', '..', '.', 'a/b', 'a\\\\b', '-x', 'with space', ''])('rejects %j in the manifest, an overlay and the lock', (name) => {
    expect(() => loadManifest(manifestWith(name))).toThrow(/Invalid profile name/);
    expect(() => parseOverlay(overlayWith(name), 'overlays/x.yaml')).toThrow(/Invalid profile name/);
    expect(() => loadLock(lockWith(name))).toThrow(/Invalid profile name/);
  });

  it.each(['web', 'my.profile', 'team_1', 'a-b', '.hidden'])('accepts %j', (name) => {
    expect(Object.keys(loadManifest(manifestWith(name)).profiles)).toEqual([name]);
    expect(() => parseOverlay(overlayWith(name), 'overlays/x.yaml')).not.toThrow();
    expect(Object.keys(loadLock(lockWith(name)).profiles)).toEqual([name]);
  });

  it.each(['-h', '--help', '@-x/plugin'])('rejects the package name %j, which pnpm would read as an option', (name) => {
    expect(() => loadManifest(`apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      a:\n        package: "${name}"\n        source: { type: in-box }\n`)).toThrow(/package/i);
  });

  it('checks lock aliases as the manifest checks aliases', () => {
    const lockAlias = (alias: string) =>
      JSON.stringify({ apiVersion: 'dshenv-lock/v1', profiles: { web: { plugins: { [alias]: { package: 'dsh-plugin-demo', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } } });
    expect(() => loadLock(lockAlias('a b'))).toThrow(/whitespace/);
    expect(Object.keys(loadLock(lockAlias('demo')).profiles.web.plugins)).toEqual(['demo']);
  });

  describe('on the command line', () => {
    let tempHome: string;
    const run = async (args: string[]) => {
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], {
        stdout: () => {},
        stderr: (chunk) => {
          stderr += chunk;
        }
      });
      return { code, stderr };
    };

    beforeEach(async () => {
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-profile-name-'));
      await run(['init']);
    });

    afterEach(() => {
      fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it.each(['../outside', '..', 'a/b'])('refuses install -p %j and leaves the manifest alone', async (name) => {
      const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
      const before = fs.readFileSync(manifestFile, 'utf8');
      const { code, stderr } = await run(['install', 'demo-plugin@1.0.0', '-p', name]);
      expect(code).toBe(3);
      expect(stderr).toMatch(/Invalid profile name/);
      expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
    });
  });
});

const gitManifest = (source: string) =>
  `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      demo:\n        package: demo-plugin\n        source: ${source}\n`;

describe('git sources in the manifest', () => {
  it.each([
    ['an option-like URL', '{ type: git, url: "--upload-pack=evil" }', /Git URL must not start with -/],
    ['an option-like ref', '{ type: git, url: "https://example.com/demo.git", ref: "--output=x" }', /ref must not start with -/],
    ['a commit that is not a commit id', '{ type: git, url: "https://example.com/demo.git", commit: "--registry=x" }', /commit/]
  ])('rejects %s', (_label, source, message) => {
    expect(() => loadManifest(gitManifest(source))).toThrow(message);
  });

  it('accepts a URL, a branch and a commit id', () => {
    const manifest = loadManifest(gitManifest('{ type: git, url: "git@github.com:acme/demo.git", ref: main, commit: 1a2b3c4 }'));
    expect(manifest.profiles.web.plugins.demo.source).toMatchObject({ ref: 'main', commit: '1a2b3c4' });
  });
});
