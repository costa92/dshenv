import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { assertEnvctlClearOfDsh, type EnvironmentPaths } from './paths.js';
import { DshError, ValidationError } from '../errors.js';
import { withEnvironmentLock } from '../io/lock.js';
import { MOVED_FILE, assertEnvctlNotMoved } from './moved.js';
import { loadLock, loadManifest, parseOverlay, serializeLock, serializeManifest, serializeOverlay } from '../manifest/files.js';

export interface MigrateResult {
  dryRun: boolean;
  from: string;
  to: string;
  // envctl itself or its entries that were symlinks; their content is copied, their targets are left as they are.
  linked: string[];
  // Paths into the old envctl in the manifest, overlays, lock and snapshots, as `file: old -> new`; rewritten to the new location.
  rewritten: string[];
  // Snapshot files that could not be read, so any old paths in them were left as they are.
  skipped: string[];
}

const LOCK_FILE = 'dshenv.lock';
// The lock and the .wanted/.reclaim files of commands waiting for it come and go while migrate runs.
const isLockEntry = (name: string): boolean => name.startsWith(LOCK_FILE);
// Every environment has one of these; without them the directory is not envctl, and migrate will not delete it.
const ENVIRONMENT_FILES = ['manifest.yaml', 'lock.json', 'state.json'];

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function linkedEntries(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

// Every entry with its type and size; top-level links are listed as what they point to, as they are copied by content,
// and deeper links by their text, as they are copied verbatim.
async function treeListing(dir: string, top = true, prefix = ''): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (top && isLockEntry(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const relative = prefix + entry.name;
    const stat = await fs.promises.lstat(full);
    const followed = top && stat.isSymbolicLink() ? await fs.promises.stat(full) : stat;
    if (followed.isSymbolicLink()) {
      lines.push(`l ${relative} ${await fs.promises.readlink(full)}`);
    } else if (followed.isDirectory()) {
      lines.push(`d ${relative}`);
      lines.push(...(await treeListing(full, false, `${relative}/`)));
    } else {
      lines.push(`f ${relative} ${followed.size}`);
    }
  }
  return lines;
}

// Windows paths compare without case: a manifest may spell the drive or a directory differently from realpath.
export function rewritePath(value: string, prefixes: string[], target: string, ignoreCase = process.platform === 'win32'): string {
  const fold = (text: string) => (ignoreCase ? text.toLowerCase() : text);
  for (const prefix of prefixes) {
    if (fold(value) === fold(prefix) || fold(value).startsWith(fold(prefix + path.sep))) {
      return target + value.slice(prefix.length);
    }
  }
  return value;
}

function rewriteStrings(value: unknown, rewrite: (s: string) => string): unknown {
  if (typeof value === 'string') return rewrite(value);
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, rewrite));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStrings(item, rewrite)]));
  }
  return value;
}

interface Rewrite {
  file: string;
  content: string;
  changes: string[];
}

type Rewriter = (content: string, file: string, rewrite: (value: string) => string) => string;

function rewriteWith<T>(load: (content: string, file: string) => T, serialize: (data: T) => string): Rewriter {
  return (content, file, rewrite) => serialize(rewriteStrings(load(content, file), rewrite) as T);
}

function environmentFiles(dir: string, prefix: string, overlayDirs: string[]): [string, Rewriter][] {
  const files: [string, Rewriter][] = [
    [path.join(prefix, 'manifest.yaml'), rewriteWith(loadManifest, serializeManifest)],
    [path.join(prefix, 'lock.json'), rewriteWith(loadLock, serializeLock)]
  ];
  for (const overlayDir of overlayDirs) {
    const full = path.join(dir, prefix, overlayDir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).filter((entry) => entry.endsWith('.yaml')).sort()) {
      files.push([path.join(prefix, overlayDir, name), rewriteWith(parseOverlay, serializeOverlay)]);
    }
  }
  return files;
}

// A local plugin cloned under envctl/sources, say, is declared by a path that migrate would delete; such paths move
// with envctl. DSH keeps the old path in the profile until apply reinstalls the plugin, which plan then lists.
// Snapshots hold the same files (overlays under existing-overlays), and a rollback to one taken before the move would
// bring the old paths back; one that does not load, say from an older dshenv, is left alone rather than block the move.
function planRewrites(dir: string, prefixes: string[], target: string): { rewrites: Rewrite[]; skipped: string[] } {
  const files = environmentFiles(dir, '', ['overlays']).map(([file, rewriter]) => ({ file, rewriter, snapshot: false }));
  const backupsDir = path.join(dir, 'backups');
  if (fs.existsSync(backupsDir)) {
    const snapshots = fs
      .readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
    for (const name of snapshots) {
      for (const [file, rewriter] of environmentFiles(dir, path.join('backups', name), ['overlays', 'existing-overlays'])) {
        files.push({ file, rewriter, snapshot: true });
      }
    }
  }
  const rewrites: Rewrite[] = [];
  const skipped: string[] = [];
  for (const { file, rewriter, snapshot } of files) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const changes: string[] = [];
    let content: string;
    try {
      content = rewriter(fs.readFileSync(full, 'utf8'), full, (value) => {
        if (!path.isAbsolute(value)) return value;
        const moved = rewritePath(path.normalize(value), prefixes, target);
        if (moved === path.normalize(value)) return value;
        changes.push(`${file}: ${value} -> ${moved}`);
        return moved;
      });
    } catch (err) {
      if (snapshot) {
        skipped.push(file);
        continue;
      }
      throw new ValidationError(`Could not read ${full}; nothing was moved: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (changes.length > 0) rewrites.push({ file, content, changes });
  }
  return { rewrites, skipped };
}

// The target may not exist yet, so resolve its nearest existing ancestor: on macOS /var is a link to /private/var.
function realpathOfExisting(target: string): string {
  let dir = target;
  const rest: string[] = [];
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return target;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

// The listing the copy has once its paths are rewritten: only the rewritten files change, and only in size.
async function expectedListing(source: string, prefixes: string[], target: string): Promise<string> {
  const sizes = new Map(planRewrites(source, prefixes, target).rewrites.map((rewrite) => [rewrite.file.split(path.sep).join('/'), Buffer.byteLength(rewrite.content)]));
  return (await treeListing(source))
    .map((line) => {
      const file = line.match(/^f (.+) \d+$/)?.[1];
      return file !== undefined && sizes.has(file) ? `f ${file} ${String(sizes.get(file))}` : line;
    })
    .join('\n');
}

// True when the target already holds this envctl, as a migrate killed before marking the old location leaves it.
// Otherwise it must be empty, or hold only the marker of an envctl moved away from it, which can be moved back.
async function targetHoldsCopy(target: string, source: string, prefixes: string[]): Promise<boolean> {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || (stat.isDirectory() && fs.readdirSync(target).every((name) => name === MOVED_FILE))) {
    return false;
  }
  if (stat.isDirectory() && (await treeListing(target)).join('\n') === (await expectedListing(source, prefixes, target))) {
    return true;
  }
  throw new ValidationError(
    `Target ${target} already exists and is not an empty directory; if an interrupted dshenv migrate left it there, delete it and migrate again`
  );
}

// Only an empty directory is replaced, never one with content: another envctl that landed there meanwhile stays, and
// this migrate fails instead.
async function moveIntoPlace(staging: string, target: string): Promise<void> {
  try {
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      await fs.promises.rm(path.join(target, MOVED_FILE), { force: true });
      await fs.promises.rmdir(target);
    }
    await fs.promises.rename(staging, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw new ValidationError(`Target ${target} is no longer empty, something else was moved there meanwhile; nothing was moved`);
    }
    throw err;
  }
}

export async function migrateEnvctl(paths: EnvironmentPaths, to: string, options: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  const from = paths.managerDir;
  const fromStat = fs.lstatSync(from, { throwIfNoEntry: false });
  if (!fromStat) {
    throw new ValidationError(`No envctl directory at ${from} to migrate`);
  }
  assertEnvctlNotMoved(from);
  const source = fs.realpathSync(from);
  if (!fs.statSync(source).isDirectory()) {
    throw new ValidationError(`${from} is not a directory`);
  }
  if (!ENVIRONMENT_FILES.some((name) => fs.existsSync(path.join(source, name)))) {
    throw new ValidationError(`${from} is not a dshenv data directory (it has no ${ENVIRONMENT_FILES.join(', ')}); nothing was moved`);
  }
  const target = path.resolve(to);
  const realTarget = realpathOfExisting(target);
  if ([target, realTarget].some((t) => isPathInside(source, t) || isPathInside(t, source) || isPathInside(from, t) || isPathInside(t, from))) {
    throw new ValidationError(`Cannot migrate ${from} to ${target}: one contains the other`);
  }
  assertEnvctlClearOfDsh(target, path.resolve(paths.home), 'Target');
  assertEnvctlClearOfDsh(realTarget, realpathOfExisting(path.resolve(paths.home)), 'Target');
  const links = linkedEntries(source);
  const dangling = links.find((name) => !fs.existsSync(path.join(source, name)));
  if (dangling !== undefined) {
    throw new ValidationError(`${path.join(from, dangling)} is a symlink to nothing; remove it or point it at its content, then migrate`);
  }
  const linked = [...(fromStat.isSymbolicLink() ? [from] : []), ...links.map((name) => path.join(from, name))];
  // Longest first, so a link inside the real directory is not cut at a shorter prefix.
  const prefixes = [...new Set([path.normalize(from), source])].sort((a, b) => b.length - a.length);
  await targetHoldsCopy(target, source, prefixes);
  if (options.dryRun) {
    const { rewrites, skipped } = planRewrites(source, prefixes, target);
    return { dryRun: true, from, to: target, linked, rewritten: rewrites.flatMap((rewrite) => rewrite.changes), skipped };
  }

  const staging = `${target}.dshenv-migrate-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const rewritten: string[] = [];
  const skipped: string[] = [];
  await withEnvironmentLock(paths, async () => {
    // Checked again under the lock; it guards only the old location, so another envctl may be moving here as well.
    if (await targetHoldsCopy(target, source, prefixes)) {
      const plan = planRewrites(source, prefixes, target);
      rewritten.push(...plan.rewrites.flatMap((rewrite) => rewrite.changes));
      skipped.push(...plan.skipped);
    } else {
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.cp(source, staging, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (entry) => !(path.dirname(entry) === source && isLockEntry(path.basename(entry)))
        });
        // A linked entry is moved by its content, so the new envctl holds no link.
        for (const name of links) {
          await fs.promises.rm(path.join(staging, name));
          await fs.promises.cp(fs.realpathSync(path.join(source, name)), path.join(staging, name), { recursive: true, verbatimSymlinks: true });
        }
        const expected = (await treeListing(source)).join('\n');
        if ((await treeListing(staging)).join('\n') !== expected) {
          throw new DshError(`Copy of ${from} does not match it; nothing was moved`);
        }
        // In the copy, so a file that fails to load leaves the old envctl as it was.
        const plan = planRewrites(staging, prefixes, target);
        for (const rewrite of plan.rewrites) {
          await fs.promises.writeFile(path.join(staging, rewrite.file), rewrite.content);
          rewritten.push(...rewrite.changes);
        }
        skipped.push(...plan.skipped);
        await moveIntoPlace(staging, target);
      } catch (err) {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    }
    // Marked first, while still locked: from then on no command uses the old location, even one that gets the lock
    // next or one that runs after a cleanup that failed halfway. A symlinked envctl keeps its link and its target, which
    // only gains the marker, so the lock taken through the link stays the one file every command contends for.
    try {
      await fs.promises.writeFile(path.join(from, MOVED_FILE), `${target}\n`);
    } catch (err) {
      throw new DshError(
        `envctl was copied to ${target}, but ${from} could not be marked as moved: ${err instanceof Error ? err.message : String(err)}; nothing was removed from it, run the same migrate again to finish`
      );
    }
    if (fromStat.isSymbolicLink()) return;
    // The environment files go first, so what a failed cleanup leaves does not read as an environment either.
    // rm removes a link itself (a junction too), never what it points to.
    try {
      const names = fs.readdirSync(from).filter((entry) => !isLockEntry(entry) && entry !== MOVED_FILE);
      for (const name of [...ENVIRONMENT_FILES.filter((file) => names.includes(file)), ...names.filter((n) => !ENVIRONMENT_FILES.includes(n))]) {
        await fs.promises.rm(path.join(from, name), { recursive: true });
      }
    } catch (err) {
      throw new DshError(
        `envctl was copied to ${target} and ${from} is marked as moved, but it could not be emptied: ${err instanceof Error ? err.message : String(err)}; remove what is left by hand`
      );
    }
  });
  return { dryRun: false, from, to: target, linked, rewritten, skipped };
}
