import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { OverlaySelectionFileSchema } from './schema.js';

export type OverlaySelectionVia = 'flag' | 'env' | 'file';

export interface OverlaySelection {
  name: string;
  via: OverlaySelectionVia;
}

// A leading '-' would read as an option to overlay use; Windows drops a trailing '.' from the file name.
const OverlayNameRegex = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function isValidOverlayName(name: string): boolean {
  return OverlayNameRegex.test(name) && name.length <= 100 && !name.endsWith('.');
}

export function validateOverlayName(name: string): string {
  if (!isValidOverlayName(name)) {
    throw new ValidationError(
      `Invalid overlay name: '${name}' (allowed: letters, digits, '.', '_', '-', at most 100 characters; not starting with '.' or '-', not ending in '.')`
    );
  }
  return name;
}

export function overlayFilePath(paths: EnvironmentPaths, name: string): string {
  return path.join(paths.overlaysDir, `${validateOverlayName(name)}.yaml`);
}

export function readSelectionFile(paths: EnvironmentPaths): string | null {
  if (!fs.existsSync(paths.overlaySelectionFile)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.overlaySelectionFile, 'utf8'));
  } catch {
    raw = null;
  }
  const res = OverlaySelectionFileSchema.safeParse(raw);
  if (!res.success) {
    throw new ValidationError(`Invalid overlay selection file: ${paths.overlaySelectionFile}`);
  }
  return validateOverlayName(res.data.overlay);
}

export async function writeSelectionFile(paths: EnvironmentPaths, name: string | null): Promise<void> {
  if (name === null) {
    await fs.promises.rm(paths.overlaySelectionFile, { force: true });
    return;
  }
  const content = { apiVersion: 'dshenv-overlay-selection/v1', overlay: validateOverlayName(name) };
  await writeAtomic(paths.overlaySelectionFile, `${JSON.stringify(content, null, 2)}\n`, 'overwrite');
}

export function resolveOverlaySelection(
  paths: EnvironmentPaths,
  input: { flag?: string | false; env?: string }
): OverlaySelection | null {
  if (input.flag === false) {
    return null;
  }
  if (typeof input.flag === 'string') {
    return { name: validateOverlayName(input.flag), via: 'flag' };
  }
  if (input.env) {
    return { name: validateOverlayName(input.env), via: 'env' };
  }
  const fromFile = readSelectionFile(paths);
  return fromFile ? { name: fromFile, via: 'file' } : null;
}
