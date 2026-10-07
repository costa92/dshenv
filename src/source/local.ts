import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { EnvironmentManifest } from '../domain.js';
import { ValidationError } from '../errors.js';
import { PackageNameRegex } from '../manifest/schema.js';
import type { LocalSourceDigests } from '../planner/plan.js';

export interface LocalSourceInfo {
  isValid: boolean;
  name?: string;
  version?: string;
  digest: string;
  packageJson?: Record<string, unknown>;
}

// Entries no digest counts, and so no skill copy carries: dependencies, Git data, Finder files and atomic-write leftovers.
export function isUndigestedEntry(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === '.DS_Store' || name.startsWith('.tmp-');
}

// A skill is copied whole, so every file counts, executable bit included; only a plugin source is narrowed to what npm
// would publish, and its digest never changes with modes, so a plugin recorded before stays in sync.
export async function calculateSourceDigest(dirPath: string, options: { publishedOnly?: boolean; executableBit?: boolean } = {}): Promise<string> {
  const hash = crypto.createHash('sha256');

  async function walk(current: string): Promise<string[]> {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    const files: string[] = [];

    // Sort entries for deterministic hashing
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (isUndigestedEntry(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await walk(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const publishes = options.publishedOnly === false ? () => true : await publishedFilter(dirPath);
  const allFiles = (await walk(dirPath)).filter((file) => publishes(path.relative(dirPath, file).split(path.sep).join('/')));
  allFiles.sort();

  for (const file of allFiles) {
    const relative = path.relative(dirPath, file);
    hash.update(relative);
    // A symlink counts by where it points; a tree without one digests as it always has.
    const stat = await fs.promises.lstat(file);
    const content = stat.isSymbolicLink() ? `\0symlink\0${await fs.promises.readlink(file)}` : await fs.promises.readFile(file);
    hash.update(content);
    // Only an executable file adds anything, so a tree without one digests as before.
    if (options.executableBit && process.platform !== 'win32' && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0) {
      hash.update('\0executable');
    }
  }

  return hash.digest('hex');
}

// With a `files` list, only what npm would publish counts, so docs or tests changing in the checkout are not an update.
async function publishedFilter(dirPath: string): Promise<(rel: string) => boolean> {
  let pkg: { files?: unknown; main?: unknown };
  try {
    pkg = JSON.parse(await fs.promises.readFile(path.join(dirPath, 'package.json'), 'utf8'));
  } catch {
    return () => true;
  }
  if (!Array.isArray(pkg.files) || !pkg.files.every((entry) => typeof entry === 'string')) {
    return () => true;
  }
  const normalize = (entry: string) => entry.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const include = pkg.files.filter((entry) => !entry.startsWith('!')).map(normalize).map(entryMatcher);
  const exclude = pkg.files.filter((entry) => entry.startsWith('!')).map((entry) => entryMatcher(normalize(entry.slice(1))));
  const main = typeof pkg.main === 'string' ? normalize(pkg.main) : undefined;
  return (rel) => {
    if (rel === 'package.json' || rel === main || /^(readme|licen[cs]e)(\.[^/]*)?$/i.test(rel)) {
      return true;
    }
    return include.some((matches) => matches(rel)) && !exclude.some((matches) => matches(rel));
  };
}

// A files entry names a file or a directory (everything under it counts), either of which may be a glob.
function entryMatcher(entry: string): (rel: string) => boolean {
  const pattern = new RegExp(
    `^${entry
      .split('/')
      .map((part) => (part === '**' ? '.*' : part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')))
      .join('/')
      .replace(/\/\.\*\//g, '(?:/.*)?/')
      .replace(/^\.\*\//, '(?:.*/)?')}(?:/.*)?$`
  );
  return (rel) => pattern.test(rel);
}

export async function inspectLocalSource(sourcePath: string): Promise<LocalSourceInfo> {
  if (!path.isAbsolute(sourcePath)) {
    throw new ValidationError(`Local source path must be absolute: ${sourcePath}`);
  }

  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new ValidationError(`Local source directory does not exist: ${sourcePath}`);
  }

  const pkgJsonPath = path.join(sourcePath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new ValidationError(`Missing package.json in local source: ${sourcePath}`);
  }

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch (err) {
    throw new ValidationError(`Invalid package.json in ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const name = typeof pkgJson.name === 'string' ? pkgJson.name : undefined;
  const version = typeof pkgJson.version === 'string' ? pkgJson.version : undefined;

  const digest = await calculateSourceDigest(sourcePath);

  return {
    isValid: true,
    name,
    version,
    digest,
    packageJson: pkgJson
  };
}

export async function readLocalSourceDigests(manifest: EnvironmentManifest | null): Promise<LocalSourceDigests> {
  const digests: LocalSourceDigests = {};
  for (const [profileName, profile] of Object.entries(manifest?.profiles ?? {})) {
    for (const [alias, plugin] of Object.entries(profile.plugins)) {
      if (plugin.source.type !== 'local-file' && plugin.source.type !== 'local-link') {
        continue;
      }
      try {
        const digest = await calculateSourceDigest(plugin.source.path);
        (digests[profileName] ??= {})[alias] = digest;
      } catch {
        // Left out on purpose: the planner reports an installed plugin whose source has no digest as unverified.
      }
    }
  }
  return digests;
}

// The name DSH installs the package under; directory and URL names are only a fallback.
export function readPackageJsonName(dir: string): string | undefined {
  try {
    const name: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    return typeof name === 'string' && PackageNameRegex.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
