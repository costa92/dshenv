import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A dsh on the developer's PATH must never run in tests: its --dump-config writes profile files and its
// hot reload state differs per machine. This stub shadows it, and a DSH_CLI exported in the developer's
// shell is dropped for the same reason; tests that need DSH set DSH_CLI to a fake.
export default function setup(): () => void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-test-bin-'));
  fs.writeFileSync(path.join(binDir, 'dsh'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  // Windows finds commands through PATHEXT, so there the stub is the dsh.cmd an npm install would put first.
  fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@exit /b 127\r\n');
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const originalDshCli = process.env.DSH_CLI;
  delete process.env.DSH_CLI;
  // A default profile exported in the developer's shell would fill in every -p the tests leave out.
  const originalProfile = process.env.DSHENV_PROFILE;
  delete process.env.DSHENV_PROFILE;
  const originalLayer = process.env.DSHENV_LAYER;
  delete process.env.DSHENV_LAYER;
  // The same goes for the rest of the environment dshenv reads: an overlay, a dsh web URL or a DSH home in the
  // developer's shell would point tests at the developer's own setup.
  const dropped = ['DSHENV_OVERLAY', 'DSHENV_DSH_URL', 'DSH_HOME', 'DSHENV_HOME', 'DSH_PLUGIN_SOURCE_HOME'].map((name) => {
    const value = process.env[name];
    delete process.env[name];
    return [name, value] as const;
  });
  // install asks npm whether a version exists; tests must not depend on the registry, so they opt in per test.
  const originalNpmCheck = process.env.DSHENV_NPM_CHECK;
  process.env.DSHENV_NPM_CHECK = 'off';
  // Commits made in tests must not depend on the developer's git identity or on signing being set up.
  const gitConfig = Object.entries({ 'user.name': 'dshenv-test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'tag.gpgsign': 'false' });
  process.env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return () => {
    if (originalDshCli !== undefined) process.env.DSH_CLI = originalDshCli;
    if (originalProfile !== undefined) process.env.DSHENV_PROFILE = originalProfile;
    if (originalLayer !== undefined) process.env.DSHENV_LAYER = originalLayer;
    for (const [name, value] of dropped) {
      if (value !== undefined) process.env[name] = value;
    }
    if (originalNpmCheck === undefined) delete process.env.DSHENV_NPM_CHECK;
    else process.env.DSHENV_NPM_CHECK = originalNpmCheck;
    fs.rmSync(binDir, { recursive: true, force: true });
  };
}
