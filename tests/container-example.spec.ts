import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleDir = path.join(projectDir, 'docs', 'examples', 'container');
const read = (name: string) => fs.readFileSync(path.join(exampleDir, name), 'utf8');

const dockerfile = read('Dockerfile');
const argDefault = (name: string): string | undefined =>
  dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];
const ciPnpmVersion = String(
  (YAML.parse(fs.readFileSync(path.join(projectDir, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ uses?: string; with?: { version?: unknown } }> }>;
  }).jobs.check.steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'))?.with?.version
);

describe('container example', () => {
  it('pins the DSH and pnpm versions dshenv supports', () => {
    expect(argDefault('DSH_VERSION')).toBe('0.1.7-rc.2');
    expect(argDefault('PNPM_VERSION')).toBe(ciPnpmVersion);
    expect(argDefault('NODE_VERSION')).toBe('22');
    expect(dockerfile).toMatch(/npm install -g .*"@deepseek-ai\/dsh@\$\{DSH_VERSION\}"/);
  });

  it('applies the manifest as a non-root user and fails the build on drift', () => {
    expect(Array.from(dockerfile.matchAll(/^USER\s+(.*)$/gm), (match) => match[1])).toEqual(['dsh']);
    const userAt = dockerfile.indexOf('USER dsh');
    for (const step of ['mkdir -p /home/dsh/.dsh/sessions', 'COPY --chown=dsh:dsh envctl/', 'COPY --chown=dsh:dsh cordis.patch.yml']) {
      expect(dockerfile.indexOf(step)).toBeGreaterThan(userAt);
    }
    expect(dockerfile).toMatch(/^ENV DSH_HOME=\/home\/dsh\/\.dsh$/m);
    expect(dockerfile).toContain('dshenv apply --yes');
    expect(dockerfile).toContain('dshenv plan');
    expect(dockerfile.indexOf('USER dsh')).toBeLessThan(dockerfile.indexOf('dshenv apply --yes'));
    expect(dockerfile).toMatch(/COPY --from=dshenv /);
  });

  it('ignores machine-local envctl state so builds depend only on the manifest', () => {
    // Without --no-overlay an empty DSHENV_OVERLAY falls back to envctl/overlay-selection.json.
    expect(dockerfile).toContain('--no-overlay');
    expect(dockerfile).toContain('--overlay "${DSHENV_OVERLAY}"');
    const ignored = read('.dockerignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(ignored).toEqual(
      expect.arrayContaining([
        '.git',
        'envctl/state.json',
        'envctl/overlay-selection.json',
        'envctl/dshenv.lock',
        'envctl/backups',
        'envctl/logs',
        'envctl/trash',
        'envctl/sources',
        'envctl/run',
        'envctl/remote.json',
        'envctl/remote',
        'envctl/dshenv.lock.*'
      ])
    );
  });

  it('starts dsh web without --host or extra trusted authorities', () => {
    const cmd = dockerfile.match(/^CMD (\[.*\])$/m)?.[1];
    expect(cmd).toBeDefined();
    expect(JSON.parse(cmd as string)).toEqual(['dsh', 'web', '--no-open']);
  });

  it('does not EXPOSE the port, so docker run -P cannot publish it on all host interfaces', () => {
    expect(dockerfile).not.toMatch(/^EXPOSE\b/m);
  });

  it('binds the webserver to all container interfaces while restating its full config', () => {
    const rows = YAML.parse(read('cordis.patch.yml')) as Array<Record<string, unknown>>;
    const webserver = rows.find((row) => row.id === 'webserver');
    expect(webserver).toEqual({
      id: 'webserver',
      config: { host: '0.0.0.0', port: 3080, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 }
    });
  });

  it('publishes the port to host loopback only and keeps secrets out of the build', () => {
    const compose = YAML.parse(read('compose.yaml')) as {
      services: Record<string, { ports?: string[]; environment?: Record<string, string>; build?: { args?: Record<string, string> } }>;
    };
    const ports = Object.values(compose.services).flatMap((service) => service.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      expect(port.startsWith('127.0.0.1:')).toBe(true);
    }
    for (const service of Object.values(compose.services)) {
      expect(JSON.stringify(service.build?.args ?? {})).not.toMatch(/KEY|TOKEN|SECRET/i);
    }
    // Reject any ARG or ENV instruction whose variable name matches secret-like patterns
    const instructionMatches = Array.from(dockerfile.matchAll(/^(ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)/gm));
    const secretLikeNames = instructionMatches
      .map(([, , varName]) => varName)
      .filter((name) => /KEY|TOKEN|SECRET|PASS|CREDENTIAL/i.test(name));
    expect(secretLikeNames).toEqual([]);
    // Also check for the literal DEEPSEEK_API_KEY
    expect(dockerfile).not.toContain('DEEPSEEK_API_KEY');
  });

  it('persists session data without shadowing the applied plugin environment', () => {
    const compose = YAML.parse(read('compose.yaml')) as { services: Record<string, { volumes?: string[] }> };
    const targets = Object.values(compose.services)
      .flatMap((service) => service.volumes ?? [])
      .map((volume) => volume.split(':')[1]);
    expect(targets).toEqual(['/home/dsh/.dsh/sessions']);
    for (const target of targets) {
      expect(target.replace(/\/+$/, '')).not.toBe('/home/dsh/.dsh');
      expect(target.startsWith('/home/dsh/.dsh/profiles')).toBe(false);
      expect(target.startsWith('/home/dsh/.dsh/envctl')).toBe(false);
    }
    expect(dockerfile.indexOf('USER dsh')).toBeLessThan(dockerfile.indexOf('mkdir -p /home/dsh/.dsh/sessions'));
  });
});
