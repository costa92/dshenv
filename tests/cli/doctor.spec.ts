import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli.js';

const officialHarnessFixture = fileURLToPath(new URL('../fixtures/harness-source', import.meta.url));

function makeHarnessSource(parentDir: string): string {
  const sourceDir = path.join(parentDir, 'harness-source');
  fs.cpSync(officialHarnessFixture, sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    private: true,
    scripts: { dsh: 'node ./dsh.cjs' }
  }));
  fs.writeFileSync(path.join(sourceDir, 'dsh.cjs'),
    'if (process.argv.includes("--version")) console.log("0.1.7-rc.2");\n');
  return sourceDir;
}

// The fake DSH here is a set of shell scripts; doctor-remote.spec covers doctor with a Node fake on Windows too.
describe.skipIf(process.platform === 'win32')('CLI doctor', () => {
  let tempHome: string;
  let fakeBinDir: string;
  let fakeDsh: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-home-'));
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-bin-'));
    fakeDsh = path.join(fakeBinDir, 'fake-dsh.sh');

    fs.writeFileSync(
      fakeDsh,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "0.1.7-rc.2"
  exit 0
fi
exit 0
`
    );
    fs.chmodSync(fakeDsh, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it('warns about plaintext credentials in the manifest without failing', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;
    let stderr = '';
    try {
      fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, 'envctl', 'manifest.yaml'),
        'apiVersion: dshenv/v1\nprofiles:\n  web:\n    patches:\n      - id: llm\n        config: { token: abc }\n'
      );
      const code = await runCli(['doctor', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      expect(code).toBe(0);
      expect(stderr).toContain("plaintext credentials (profile 'web' / llm / config.token)");
      expect(stderr).not.toContain('abc');
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('says where the envctl location came from: --envctl-dir, DSHENV_HOME or the default', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;
    const elsewhere = path.join(tempHome, 'data');
    const doctor = async (args: string[]) => {
      let stdout = '';
      await runCli(['doctor', '--dsh-home', tempHome, ...args], { stdout: (chunk) => { stdout += chunk; }, stderr: () => {} });
      return stdout;
    };
    try {
      expect(await doctor([])).toContain(`  Manager Dir: ${path.join(tempHome, 'envctl')} (default)\n`);
      expect(await doctor(['--envctl-dir', elsewhere])).toContain(`  Manager Dir: ${elsewhere} (from --envctl-dir)\n`);
      process.env.DSHENV_HOME = elsewhere;
      expect(await doctor([])).toContain(`  Manager Dir: ${elsewhere} (from DSHENV_HOME)\n`);
      expect(JSON.parse(await doctor(['--json'])).paths.managerDirSource).toBe('env');
    } finally {
      delete process.env.DSHENV_HOME;
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('should pass doctor with supported DSH runtime', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;

    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    try {
      const code = await runCli(['doctor', '--dsh-home', tempHome], io);
      expect(code).toBe(0);
      expect(stdout).toContain('0.1.7-rc.2');
      expect(stdout).toContain('DSH Environment Doctor');
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('should exit with code 4 when DSH version is unsupported', async () => {
    const unsuppDsh = path.join(fakeBinDir, 'unsupported-dsh.sh');
    fs.writeFileSync(
      unsuppDsh,
      `#!/bin/sh
echo "0.0.1"
exit 0
`
    );
    fs.chmodSync(unsuppDsh, 0o755);

    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = unsuppDsh;

    let stderr = '';
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: (chunk: string) => { stderr += chunk; }
    };

    try {
      const code = await runCli(['doctor', '--dsh-home', tempHome], io);
      expect(code).toBe(4);
      expect(stdout).toBe('');
      expect(stderr).toBe(
        'Unsupported DSH version 0.0.1: dshenv supports DSH 0.1.7, 0.2.0 (e.g. 0.2.0-rc.2). Point DSH_CLI at a supported DSH, or pass --allow-untested-dsh to use this one anyway.\n'
      );
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('should pass doctor for untested version when --allow-untested-dsh is specified', async () => {
    const untestedDsh = path.join(fakeBinDir, 'untested-dsh.sh');
    fs.writeFileSync(
      untestedDsh,
      `#!/bin/sh
echo "0.2.0"
exit 0
`
    );
    fs.chmodSync(untestedDsh, 0o755);

    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = untestedDsh;

    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    try {
      const code = await runCli(['doctor', '--allow-untested-dsh', '--dsh-home', tempHome], io);
      expect(code).toBe(0);
      expect(stdout).toContain('0.2.0');
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('does not print an unusual prerelease tag, which a DSH_CLI wrapper may fill with a credential', async () => {
    const wrapped = path.join(fakeBinDir, 'wrapped-dsh.sh');
    fs.writeFileSync(wrapped, '#!/bin/sh\necho "0.2.0-ghp.SECRET123"\nexit 0\n');
    fs.chmodSync(wrapped, 0o755);
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = wrapped;
    try {
      for (const json of [false, true]) {
        let stdout = '';
        const code = await runCli(['doctor', '--allow-untested-dsh', '--dsh-home', tempHome, ...(json ? ['--json'] : [])], { stdout: (chunk) => { stdout += chunk; }, stderr: () => {} });
        expect(code).toBe(0);
        expect(stdout).not.toContain('SECRET123');
        expect(stdout).toContain('0.2.0 (a prerelease)');
      }
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('should print doctor JSON without environment or credential dumps', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;
    process.env.SECRET_FOR_DOCTOR = 'should-not-appear';

    let stdout = '';
    const io = {
      stdout: (chunk: string) => {
        stdout += chunk;
      },
      stderr: () => {}
    };

    try {
      const code = await runCli(['doctor', '--json', '--dsh-home', tempHome], io);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as {
        runtime: {
          version: string;
          discoverySupported: boolean;
          mutationsSupported: boolean;
          capabilities: { packageOperations: { status: string; source: string; reason?: string } };
        };
        paths: { home: string };
      };
      expect(parsed.runtime).toMatchObject({
        version: '0.1.7-rc.2',
        discoverySupported: true,
        mutationsSupported: false,
        capabilities: {
          packageOperations: {
            status: 'disabled',
            source: 'operations-export',
            reason: 'Harness source is unavailable; provide an explicit --harness-source to verify official operations'
          }
        }
      });
      expect(parsed.paths.home).toBe(tempHome);
      expect(stdout).not.toContain('should-not-appear');
      expect(stdout).not.toContain('SECRET_FOR_DOCTOR');
      expect(stdout).not.toContain('Authorization');
      expect(stdout).not.toContain(officialHarnessFixture);
      expect(Object.keys(parsed).sort()).toEqual(['paths', 'runtime']);
    } finally {
      delete process.env.SECRET_FOR_DOCTOR;
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('reports verified official surfaces from an explicit harness source in compatible JSON', async () => {
    const sourceDir = makeHarnessSource(fakeBinDir);
    const oldDshCli = process.env.DSH_CLI;
    delete process.env.DSH_CLI;
    process.env.DOCTOR_AUTHORIZATION = 'Bearer doctor-secret';

    let stdout = '';
    let stderr = '';
    try {
      const code = await runCli(['doctor', '--json', '--dsh-home', tempHome, '--harness-source', sourceDir], {
        stdout: chunk => { stdout += chunk; },
        stderr: chunk => { stderr += chunk; }
      });

      expect(code).toBe(0);
      expect(stderr).toBe('');
      const parsed = JSON.parse(stdout) as { runtime: unknown };
      expect(parsed.runtime).toMatchObject({
        version: '0.1.7-rc.2',
        discoverySupported: true,
        mutationsSupported: false,
        capabilities: {
          packageOperations: { status: 'available', source: 'operations-export' },
          bundleSelection: { status: 'requires-live-service', source: 'live-service' },
          environmentMutation: { status: 'disabled', source: 'dshenv' }
        }
      });
      expect(stdout).not.toContain('Bearer doctor-secret');
      expect(stdout).not.toContain('DOCTOR_AUTHORIZATION');
      expect(stdout).not.toContain('Authorization');
      expect(stdout).not.toContain(officialHarnessFixture);
    } finally {
      delete process.env.DOCTOR_AUTHORIZATION;
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('does not expose DSH_CLI authentication arguments in doctor output', async () => {
    const authDsh = path.join(fakeBinDir, 'auth-dsh.sh');
    fs.writeFileSync(authDsh, '#!/bin/sh\necho "0.1.7-rc.2"\n');
    fs.chmodSync(authDsh, 0o755);
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = JSON.stringify([authDsh, '--Authorization', 'Bearer doctor-secret']);

    try {
      for (const args of [
        ['doctor', '--json', '--dsh-home', tempHome],
        ['doctor', '--dsh-home', tempHome]
      ]) {
        let stdout = '';
        const code = await runCli(args, { stdout: chunk => { stdout += chunk; } });
        expect(code).toBe(0);
        expect(stdout).not.toContain('Authorization');
        expect(stdout).not.toContain('Bearer doctor-secret');
      }
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('returns a fixed execution diagnostic when DSH_CLI exits with sensitive arguments', async () => {
    const failingDsh = path.join(fakeBinDir, 'failing-dsh.sh');
    fs.writeFileSync(failingDsh, '#!/bin/sh\necho "Authorization: Bearer doctor-secret" >&2\nexit 17\n');
    fs.chmodSync(failingDsh, 0o755);
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = JSON.stringify([failingDsh, '--Authorization', 'Bearer doctor-secret', '--argv-marker']);

    let stdout = '';
    let stderr = '';
    try {
      const code = await runCli(['doctor', '--json', '--dsh-home', tempHome], {
        stdout: chunk => { stdout += chunk; },
        stderr: chunk => { stderr += chunk; }
      });
      expect(code).toBe(5);
      expect(stdout).toBe('');
      expect(JSON.parse(stderr).error).toEqual({ type: 'DegradedError', message: 'DSH runtime probe execution failed', exitCode: 5 });
      expect(stderr).not.toContain('doctor-secret');
      expect(stderr).not.toContain('Authorization');
      expect(stderr).not.toContain('--argv-marker');
      expect(stderr).not.toContain(failingDsh);
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('exits 4, as for no DSH at all, when DSH_CLI names a file that does not exist', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = path.join(fakeBinDir, 'missing-dsh');
    let stderr = '';
    try {
      const code = await runCli(['doctor', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      expect(code).toBe(4);
      expect(stderr).toMatch(/DSH_CLI.*does not exist/);
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('exits 4 too when DSH_CLI names a command PATH does not have, as a bare name or in a JSON array', async () => {
    const oldDshCli = process.env.DSH_CLI;
    try {
      for (const value of ['nodsh-missing-cmd', '["nodsh-missing-cmd", "--flag"]']) {
        process.env.DSH_CLI = value;
        let stderr = '';
        const code = await runCli(['doctor', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
        expect(code, value).toBe(4);
        expect(stderr).toMatch(/DSH_CLI names was not found/);
        expect(stderr).not.toContain('--flag');
      }
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('warns that it ignored an invalid manifest, whose harness settings it then cannot use', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'apiVersion: nope\n');
    let stderr = '';
    try {
      const code = await runCli(['doctor', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      expect(code).toBe(0);
      expect(stderr).toMatch(/manifest .* is invalid .*harness/);

      // The same with an overlay selected, as pull and adopt leave one.
      fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
      fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'local.yaml'), 'apiVersion: dshenv-overlay/v1\n');
      stderr = '';
      const withOverlay = await runCli(['doctor', '--overlay', 'local', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      expect(withOverlay).toBe(0);
      expect(stderr).toMatch(/manifest .* is invalid .*harness/);
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('fails on a selected overlay that cannot merge into the base, and warns about an invalid lock', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      x:\n        package: "@scope/x"\n        source: { type: npm, version: "1.0.0" }\n'
    );
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'bad.yaml'), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      x:\n        package: "@scope/y"\n');
    let stderr = '';
    try {
      const code = await runCli(['doctor', '--overlay', 'bad', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
      expect(code).toBe(3);
      expect(stderr).toMatch(/cannot change package/);

      fs.writeFileSync(path.join(tempHome, 'envctl', 'lock.json'), '{bad');
      stderr = '';
      expect(await runCli(['doctor', '--no-overlay', '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } })).toBe(0);
      expect(stderr).toMatch(/lock .* is invalid .*plan and apply refuse it/);
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('returns a fixed parse diagnostic without raw malformed version output', async () => {
    const malformedDsh = path.join(fakeBinDir, 'malformed-dsh.sh');
    fs.writeFileSync(malformedDsh, '#!/bin/sh\necho "Authorization: Bearer doctor-secret malformed-version"\n');
    fs.chmodSync(malformedDsh, 0o755);
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = JSON.stringify([malformedDsh, '--Authorization', 'Bearer doctor-secret', '--argv-marker']);

    let stdout = '';
    let stderr = '';
    try {
      const code = await runCli(['doctor', '--json', '--dsh-home', tempHome], {
        stdout: chunk => { stdout += chunk; },
        stderr: chunk => { stderr += chunk; }
      });
      expect(code).toBe(5);
      expect(stdout).toBe('');
      expect(JSON.parse(stderr).error).toEqual({ type: 'DegradedError', message: 'Unable to parse DSH runtime version', exitCode: 5 });
      expect(stderr).not.toContain('doctor-secret');
      expect(stderr).not.toContain('Authorization');
      expect(stderr).not.toContain('malformed-version');
      expect(stderr).not.toContain('--argv-marker');
      expect(stderr).not.toContain(malformedDsh);
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it.each([
    ['v0.1.7', 5], ['0.1.7garbage', 5], ['0.1.7-', 5], ['0.1.7.0', 5],
    ['00.01.007', 5], ['0.1.7-01', 5],
    ['0.1.70-Authorization_Bearer_doctor-secret', 5],
    ['0.1.70-Authorization-Bearer-doctor-secret', 4],
  ])('rejects %s without echoing the version token', async (version, exitCode) => {
    fs.writeFileSync(fakeDsh, `#!/bin/sh\necho '${version}'\n`);
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;
    try {
      for (const jsonArgs of [[], ['--json']]) {
        let stdout = '';
        let stderr = '';
        const code = await runCli(['doctor', '--dsh-home', tempHome, ...jsonArgs], {
          stdout: chunk => { stdout += chunk; },
          stderr: chunk => { stderr += chunk; }
        });
        expect(code).toBe(exitCode);
        expect(stdout).toBe('');
        // Only the numeric part of an unsupported version is shown; its prerelease tag could echo a secret.
        const message = exitCode === 4
          ? 'Unsupported DSH version 0.1.70 (a prerelease): dshenv supports DSH 0.1.7, 0.2.0 (e.g. 0.2.0-rc.2). Point DSH_CLI at a supported DSH, or pass --allow-untested-dsh to use this one anyway.'
          : 'Unable to parse DSH runtime version';
        expect(jsonArgs.length ? JSON.parse(stderr).error.message : stderr).toBe(jsonArgs.length ? message : `${message}\n`);
        expect(stderr).not.toContain('doctor-secret');
        expect(stderr).not.toContain('Authorization');
      }
    } finally {
      if (oldDshCli === undefined) delete process.env.DSH_CLI;
      else process.env.DSH_CLI = oldDshCli;
    }
  });

  describe('with overlays', () => {
    let oldDshCli: string | undefined;
    let oldOverlayEnv: string | undefined;
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], {
        stdout: (chunk) => { stdout += chunk; },
        stderr: (chunk) => { stderr += chunk; }
      });
      return { code, stdout, stderr };
    };
    const select = (name: string) =>
      fs.writeFileSync(
        path.join(tempHome, 'envctl', 'overlay-selection.json'),
        JSON.stringify({ apiVersion: 'dshenv-overlay-selection/v1', overlay: name })
      );

    beforeEach(() => {
      oldDshCli = process.env.DSH_CLI;
      oldOverlayEnv = process.env.DSHENV_OVERLAY;
      process.env.DSH_CLI = fakeDsh;
      delete process.env.DSHENV_OVERLAY;
      fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
      fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'apiVersion: dshenv/v1\nprofiles: {}\n');
      fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'), 'apiVersion: dshenv-overlay/v1\n');
    });

    afterEach(() => {
      if (oldDshCli === undefined) delete process.env.DSH_CLI;
      else process.env.DSH_CLI = oldDshCli;
      if (oldOverlayEnv === undefined) delete process.env.DSHENV_OVERLAY;
      else process.env.DSHENV_OVERLAY = oldOverlayEnv;
    });

    it('fails with exit 3 when the selected overlay is missing', async () => {
      select('ghost');
      const { code, stderr } = await run(['doctor']);
      expect(code).toBe(3);
      expect(stderr).toContain("Overlay 'ghost' not found");
    });

    it('reports a missing base manifest instead of failing when an overlay is selected', async () => {
      select('laptop');
      fs.rmSync(path.join(tempHome, 'envctl', 'manifest.yaml'));
      const { code, stdout } = await run(['doctor', '--json']);
      expect(code).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.paths.manifestExists).toBe(false);
      expect(report.overlay).toEqual({ name: 'laptop', via: 'file' });
    });

    it('still fails on a missing overlay when the base manifest is missing too', async () => {
      select('ghost');
      fs.rmSync(path.join(tempHome, 'envctl', 'manifest.yaml'));
      const { code, stderr } = await run(['doctor']);
      expect(code).toBe(3);
      expect(stderr).toContain("Overlay 'ghost' not found");
    });

    it('reports the active overlay in text and JSON', async () => {
      select('laptop');
      const text = await run(['doctor']);
      expect(text.code).toBe(0);
      expect(text.stderr.startsWith('overlay: laptop (file)\n')).toBe(true);
      const json = await run(['doctor', '--json']);
      expect(JSON.parse(json.stdout).overlay).toEqual({ name: 'laptop', via: 'file' });
    });

    it('omits the overlay when none is active', async () => {
      const text = await run(['doctor']);
      expect(text.stdout).not.toContain('overlay:');
      expect(JSON.parse((await run(['doctor', '--json'])).stdout)).not.toHaveProperty('overlay');
    });
  });
});
