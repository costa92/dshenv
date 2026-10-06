import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dshInstallAnchor, inBoxBundleStatus } from '../../src/dsh/in-box.js';

describe('in-box bundle check', () => {
  let root: string;
  const write = (file: string, content: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-in-box-')));
    // An npm install: node_modules/@deepseek-ai/dsh with its in-box packages beside it.
    const modules = path.join(root, 'install', 'node_modules');
    write(path.join(modules, '@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } });
    write(path.join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '');
    write(path.join(modules, '@deepseek-ai', 'dsh-base', 'package.json'), { name: '@deepseek-ai/dsh-base', dsh: { bundle: {} } });
    write(path.join(modules, '@deepseek-ai', 'dsh-plain', 'package.json'), { name: '@deepseek-ai/dsh-plain' });
    fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
    fs.symlinkSync(path.join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), path.join(modules, '.bin', 'dsh'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('finds the dsh app a linked bin runs and tells a bundle from a plain plugin', () => {
    const anchor = dshInstallAnchor({ file: path.join(root, 'install', 'node_modules', '.bin', 'dsh'), args: [] });
    expect(anchor).toBe(path.join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    expect(inBoxBundleStatus(anchor!, '@deepseek-ai/dsh-base')).toBe(true);
    expect(inBoxBundleStatus(anchor!, '@deepseek-ai/dsh-plain')).toBe(false);
    expect(inBoxBundleStatus(anchor!, '@deepseek-ai/dsh-missing')).toBeUndefined();
  });

  it('finds the dsh app of a source checkout through its dsh script', () => {
    const source = path.join(root, 'harness');
    write(path.join(source, 'package.json'), { scripts: { dsh: 'node --import tsx/esm apps/cli/src/bin.ts' } });
    write(path.join(source, 'apps', 'cli', 'package.json'), { name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } });
    write(path.join(source, 'apps', 'cli', 'src', 'bin.ts'), '');
    expect(dshInstallAnchor({ file: 'pnpm', args: ['--silent', '--dir', source, 'dsh'], cwd: source })).toBe(
      path.join(source, 'apps', 'cli', 'package.json')
    );
  });

  it('cannot tell from a runtime alone or a script outside any dsh app', () => {
    const script = path.join(root, 'fake-dsh.mjs');
    write(script, '');
    expect(dshInstallAnchor({ file: process.execPath, args: [script] })).toBeNull();
  });
});
