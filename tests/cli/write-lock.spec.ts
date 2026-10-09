import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { acquireEnvironmentLock } from '../../src/io/lock.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('CLI write commands wait for the environment lock', () => {
  let tempHome: string;
  const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
  const manifest = () => fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-writelock-'));
    await run(['init']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const expectWaitsForLock = async (args: string[], changed: () => boolean) => {
    const handle = await acquireEnvironmentLock(resolveEnvironmentPaths({ cliDshHome: tempHome }));
    const lockPath = handle.lockPath;
    // Counts tries to create the held lock, so the test knows the command is waiting rather than guessing a delay.
    let tries = 0;
    const open = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((file: fs.PathLike, ...rest: [never]) => {
      if (file === lockPath && rest[0] === 'wx') tries += 1;
      return open(file, ...rest);
    }) as typeof fs.promises.open);
    try {
      const pending = run(args);
      // Each round tries twice (before and after the stale check); a third try means it waited a round.
      while (tries < 3) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(changed()).toBe(false);
      await handle.release();
      expect(await pending).toBe(0);
      expect(changed()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  };

  it('holds the lock while editing the base manifest', async () => {
    await expectWaitsForLock(['install', 'demo-plugin@1.0.0', '--profile', 'web'], () => manifest().includes('demo-plugin'));
  });

  it('holds the lock while editing an overlay', async () => {
    const overlayFile = path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml');
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.writeFileSync(overlayFile, 'apiVersion: dshenv-overlay/v1\n');
    await expectWaitsForLock(
      ['install', 'demo-plugin@1.0.0', '--profile', 'web', '--overlay', 'laptop', '--layer', 'overlay'],
      () => fs.readFileSync(overlayFile, 'utf8').includes('demo-plugin')
    );
  });

  it('holds the lock while creating an overlay', async () => {
    const overlayFile = path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml');
    await expectWaitsForLock(['overlay', 'create', 'laptop'], () => fs.existsSync(overlayFile));
  });

  it('holds the lock while selecting an overlay', async () => {
    const overlayFile = path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml');
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.writeFileSync(overlayFile, 'apiVersion: dshenv-overlay/v1\n');
    const selectionFile = path.join(tempHome, 'envctl', 'overlay-selection.json');
    await expectWaitsForLock(['overlay', 'use', 'laptop'], () => fs.existsSync(selectionFile));
  });

  it('holds the lock while adopting', async () => {
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'demo-plugin': '1.0.0' }, dsh: { profile: { bundles: ['demo-plugin'] } } })
    );
    const captured = path.join(tempHome, 'capture.yaml');
    expect(await run(['capture', '-o', captured])).toBe(0);
    await expectWaitsForLock(['adopt', '--from', captured, '--yes'], () => manifest().includes('demo-plugin'));
  });
});
