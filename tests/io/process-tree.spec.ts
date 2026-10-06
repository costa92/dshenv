import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { killProcessTree, processAlive as alive } from '../../src/io/process-tree.js';

describe.skipIf(process.platform === 'win32')('killProcessTree', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-process-tree-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns once the whole tree is gone, killing a descendant that ignores SIGTERM', async () => {
    const pidFile = path.join(dir, 'grandchild.pid');
    const parent = path.join(dir, 'parent.mjs');
    fs.writeFileSync(parent, `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => {}); require('fs').writeFileSync(\${JSON.stringify(${JSON.stringify(pidFile)})}, String(process.pid)); setInterval(() => {}, 1000)\`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
    const child = execa(process.execPath, [parent], { reject: false });
    while (!fs.existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));

    await killProcessTree(child.pid!);
    expect(alive(grandchild)).toBe(false);
    expect((await child).signal).toBe('SIGTERM');
  }, 30_000);

  // A slim container image has no ps; /proc still shows the tree.
  it.skipIf(process.platform !== 'linux')('finds the descendants through /proc when ps is missing', async () => {
    const pidFile = path.join(dir, 'grandchild.pid');
    const parent = path.join(dir, 'parent.mjs');
    fs.writeFileSync(parent, `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', \`require('fs').writeFileSync(\${JSON.stringify(${JSON.stringify(pidFile)})}, String(process.pid)); setInterval(() => {}, 1000)\`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
    const child = execa(process.execPath, [parent], { reject: false });
    while (!fs.existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));

    const previousPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await killProcessTree(child.pid!)).toContain(grandchild);
    } finally {
      process.env.PATH = previousPath;
    }
    expect(alive(grandchild)).toBe(false);
    await child;
  }, 30_000);
});
