import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import {
  overlayFilePath,
  readSelectionFile,
  resolveOverlaySelection,
  validateOverlayName,
  writeSelectionFile
} from '../../src/overlay/selection.js';

describe('overlay selection', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-overlay-selection-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('applies flag > env > file precedence', async () => {
    await writeSelectionFile(paths, 'from-file');
    expect(resolveOverlaySelection(paths, { flag: 'from-flag', env: 'from-env' })).toEqual({ name: 'from-flag', via: 'flag' });
    expect(resolveOverlaySelection(paths, { env: 'from-env' })).toEqual({ name: 'from-env', via: 'env' });
    expect(resolveOverlaySelection(paths, {})).toEqual({ name: 'from-file', via: 'file' });
  });

  it('lets --no-overlay win over env and file', async () => {
    await writeSelectionFile(paths, 'from-file');
    expect(resolveOverlaySelection(paths, { flag: false, env: 'from-env' })).toBeNull();
  });

  it('ignores an empty environment variable', () => {
    expect(resolveOverlaySelection(paths, { env: '' })).toBeNull();
  });

  it.each(['../escape', '..', '.', 'a/b', 'has space', '', '-dash', 'work.', 'o'.repeat(101)])('rejects the name %j', (name) => {
    expect(() => validateOverlayName(name)).toThrow(/Invalid overlay name/);
  });

  it('writes, reads and clears the selection file', async () => {
    await writeSelectionFile(paths, 'laptop');
    expect(readSelectionFile(paths)).toBe('laptop');
    expect(JSON.parse(fs.readFileSync(paths.overlaySelectionFile, 'utf8'))).toEqual({
      apiVersion: 'dshenv-overlay-selection/v1',
      overlay: 'laptop'
    });
    await writeSelectionFile(paths, null);
    expect(fs.existsSync(paths.overlaySelectionFile)).toBe(false);
    expect(readSelectionFile(paths)).toBeNull();
  });

  it('rejects a corrupt selection file instead of ignoring it', () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.overlaySelectionFile, '{"overlay":"x"}');
    expect(() => resolveOverlaySelection(paths, {})).toThrow(/Invalid overlay selection file/);
  });

  it('maps names to files under the overlays directory', () => {
    expect(overlayFilePath(paths, 'laptop')).toBe(path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'));
  });
});
