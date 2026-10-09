import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadLock, loadManifest } from '../../src/manifest/files.js';
import { runCli } from '../../src/cli.js';

const manifestWithUrl = (url: string) => `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo:
        package: demo-plugin
        source: { type: git, url: "${url}" }
`;

describe('git URLs with embedded credentials', () => {
  it.each([
    'https://alice:ghp_SECRET@github.com/x/demo.git',
    'https://ghp_SECRET@github.com/x/demo.git',
    'git+https://alice:ghp_SECRET@github.com/x/demo.git',
    'ssh://git:ghp_SECRET@example.com/x/demo.git',
    'alice:ghp_SECRET@github.com:x/demo.git',
    'https://gitlab.example.com/x/demo.git?private_token=ghp_SECRET',
    'https://example.com/x/demo.git?ref=main&access_token=ghp_SECRET'
  ])('are rejected in the manifest without echoing the secret: %s', (url) => {
    let message = '';
    try {
      loadManifest(manifestWithUrl(url));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must not embed credentials/);
    expect(message).not.toContain('ghp_SECRET');
  });

  it.each(['https://github.com/x/demo.git', 'https://example.com/x/demo.git?ref=main', 'git@github.com:x/demo.git', 'ssh://git@example.com/x/demo.git', 'file:///srv/demo.git'])(
    'are allowed when they carry none: %s',
    (url) => {
      expect(loadManifest(manifestWithUrl(url)).profiles.web.plugins.demo.source).toEqual({ type: 'git', url });
    }
  );

  it('are rejected in the lock', () => {
    const lock = JSON.stringify({
      apiVersion: 'dshenv-lock/v1',
      profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'git', url: 'https://tok@github.com/x/demo.git', commit: 'abc1234' } } } } }
    });
    expect(() => loadLock(lock)).toThrow(/must not embed credentials/);
  });
});

describe('CLI refuses to store git credentials', () => {
  let tempHome: string;
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-creds-'));
    await run(['init']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('refuses install from a URL with credentials', async () => {
    const before = fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');
    const { code, stderr } = await run(['install', 'https://alice:ghp_SECRET@github.com/x/demo.git', '--profile', 'web']);
    expect(code).toBe(3);
    expect(stderr).not.toContain('ghp_SECRET');
    expect(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).toBe(before);
  });

  it('refuses install from an scp-style URL with a password, without echoing it', async () => {
    const before = fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');
    const { code, stdout, stderr } = await run(['install', 'alice:ghp_SECRET@github.com:o/dsh-plugin-w.git', '--profile', 'web']);
    expect(code).toBe(3);
    expect(stdout + stderr).not.toContain('ghp_SECRET');
    expect(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).toBe(before);
  });

  it('refuses source clone from a URL with credentials, even without --profile', async () => {
    const { code, stderr } = await run(['source', 'clone', 'https://ghp_SECRET@github.com/x/demo.git', path.join(tempHome, 'out')]);
    expect(code).toBe(3);
    expect(stderr).toMatch(/must not embed credentials/);
    expect(fs.existsSync(path.join(tempHome, 'out'))).toBe(false);
  });

  it('skips such dependencies when capturing and warns without the secret', async () => {
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        dependencies: { 'demo-plugin': 'git+https://alice:ghp_SECRET@github.com/x/demo.git#abcdef1234567' },
        dsh: { profile: { bundles: ['demo-plugin'] } }
      })
    );
    const { code, stdout } = await run(['capture', '--json']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('ghp_SECRET');
    const doc = JSON.parse(stdout) as { manifest: { profiles: Record<string, { plugins: Record<string, unknown> }> }; warnings: string[] };
    expect(doc.manifest.profiles.web?.plugins ?? {}).toEqual({});
    expect(doc.warnings.some((warning) => /demo-plugin.*credentials/.test(warning))).toBe(true);
  });
});
