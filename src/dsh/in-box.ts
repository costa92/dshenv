import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { isBundlePackage } from '../patch/mount.js';
import type { CommandSpec } from './command.js';
import { DSH_TEMPLATE_BUNDLES } from './templates.js';

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The package.json of the dsh app, the nearest one above a file it runs that declares a dsh bin.
function appManifestAbove(file: string): string | null {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(file));
  } catch {
    return null;
  }
  for (;;) {
    const bin = readJson(path.join(dir, 'package.json'))?.bin;
    if (bin !== null && typeof bin === 'object' && Object.hasOwn(bin, 'dsh')) {
      return path.join(dir, 'package.json');
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// What DSH resolves in-box bundles from (its installAnchor); null when the command does not show it.
export function dshInstallAnchor(command: CommandSpec): string | null {
  let files: string[];
  if (command.cwd) {
    // A source checkout runs its package.json `dsh` script, which names the entry file.
    const script = (readJson(path.join(command.cwd, 'package.json'))?.scripts as Record<string, unknown> | undefined)?.dsh;
    files = typeof script === 'string' ? script.split(/\s+/).map((token) => path.resolve(command.cwd!, token)) : [];
  } else {
    // A runtime such as node is not the app; its entry script is.
    files = command.args.length > 0 ? command.args : [command.file];
  }
  for (const file of files) {
    if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const anchor = appManifestAbove(file);
    if (anchor) return anchor;
  }
  return null;
}

// Whether the package DSH would load as an in-box bundle declares dsh.bundle; undefined when it cannot be found.
export function inBoxBundleStatus(anchor: string, packageName: string): boolean | undefined {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const pkg = readJson(path.join(searchPath, packageName, 'package.json'));
    if (pkg) return isBundlePackage(pkg);
  }
  return undefined;
}

export interface OfficialBundle {
  package: string;
  version?: string;
  description?: string;
}

// The bundles DSH ships beyond its templates, off until a profile selects them; the set changes between DSH versions.
export function listOfficialBundles(anchor: string): { dshVersion?: string; bundles: OfficialBundle[] } {
  const app = readJson(anchor);
  const require = createRequire(anchor);
  const bundles: OfficialBundle[] = [];
  for (const name of Object.keys((app?.dependencies as Record<string, unknown> | undefined) ?? {})) {
    if (DSH_TEMPLATE_BUNDLES.has(name)) continue;
    let pkg: Record<string, unknown> | null = null;
    for (const searchPath of require.resolve.paths(name) ?? []) {
      pkg = readJson(path.join(searchPath, name, 'package.json'));
      if (pkg) break;
    }
    if (!pkg || !isBundlePackage(pkg)) continue;
    bundles.push({
      package: name,
      ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
      ...(typeof pkg.description === 'string' ? { description: pkg.description } : {})
    });
  }
  return { ...(typeof app?.version === 'string' ? { dshVersion: app.version } : {}), bundles };
}
