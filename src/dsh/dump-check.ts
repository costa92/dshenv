import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandSpec } from './command.js';
import { dumpProfileConfig } from './hmr.js';

const PATCH_FILE = 'cordis.patch.yml';
// DSH rewrites it on every dump, so the copy gets its own.
const PROFILE_ROOT_FILE = 'cordis.yml';

// A patch entry DSH skipped because its id matched no row: `layer` is 'profile', 'global' or a bundle package.
export interface UnmatchedPatch {
  profile: string;
  layer: string;
  id: string;
}

export interface SkippedBundle {
  profile: string;
  package: string;
  reason: string;
}

export interface DumpDiagnostics {
  unmatched: UnmatchedPatch[];
  skippedBundles: SkippedBundle[];
}

const SKIPPED_BUNDLE = /^dsh: skipping profile bundle ("(?:[^"\\]|\\.)*"): (.*)$/;
// The include's messages for a patch it skips, prefixed with the layer's label (a bundle package or a patch file path).
const UNMATCHED = /^dsh: \[(.+)\] patch(?: insert)?: (?:entry ("(?:[^"\\]|\\.)*") not found|name mismatch for ("(?:[^"\\]|\\.)*") .*, skipping)$/;

// A patch file's label is its path under the DSH_HOME the dump ran with; bundle labels are package names.
function layerOf(label: string, home: string, profile: string): string {
  const file = path.resolve(label);
  if (file === path.resolve(home, PATCH_FILE)) return 'global';
  if (file === path.resolve(home, 'profiles', profile, PATCH_FILE)) return 'profile';
  return label;
}

export function parseDumpDiagnostics(stderr: string, profile: string, home: string): DumpDiagnostics {
  const unmatched: UnmatchedPatch[] = [];
  const skippedBundles: SkippedBundle[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const skipped = SKIPPED_BUNDLE.exec(line);
    if (skipped) {
      skippedBundles.push({ profile, package: JSON.parse(skipped[1]) as string, reason: skipped[2] });
      continue;
    }
    const patch = UNMATCHED.exec(line);
    if (patch) {
      unmatched.push({ profile, layer: layerOf(patch[1], home, profile), id: JSON.parse(patch[2] ?? patch[3]) as string });
    }
  }
  return { unmatched, skippedBundles };
}

export interface DumpCheckOptions {
  command: CommandSpec | null;
  home: string;
  profilesDir: string;
  timeoutMs?: number;
}

export type DumpCheckResult = ({ ok: true } & DumpDiagnostics) | { ok: false; reason: string };

// What DSH composes for the profile now. The caller makes sure the profile exists: a dump creates a missing one.
export async function readDumpDiagnostics(profile: string, options: DumpCheckOptions): Promise<DumpCheckResult> {
  const dump = await dumpProfileConfig(profile, { command: options.command, dshHome: options.home, timeoutMs: options.timeoutMs });
  if (!dump.ok) return dump;
  return { ok: true, ...parseDumpDiagnostics(dump.stderr, profile, options.home) };
}

// What the entry is once links are followed; null for a dangling link or one that cannot be read, which DSH cannot use either.
function kindOf(file: string): 'directory' | 'file' | null {
  try {
    const stat = fs.statSync(file);
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

function linkOrCopy(source: string, target: string): void {
  const kind = kindOf(source);
  if (kind === 'directory') {
    fs.symlinkSync(source, target, 'junction');
  } else if (kind === 'file') {
    // A file is copied: DSH may rewrite the profile's package.json, which must not reach the real one.
    fs.copyFileSync(source, target);
  }
}

// What DSH would compose with these patch files in place, read from a throwaway DSH_HOME so the real one is untouched:
// the home's directories are linked into it (its other files left out), and the profile's directories linked, files copied.
export async function readCandidateDiagnostics(
  profile: string,
  candidate: { profilePatch?: string; homePatch?: string },
  options: DumpCheckOptions
): Promise<DumpCheckResult> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-dump-'));
  try {
    const profilesName = path.relative(options.home, options.profilesDir);
    for (const name of fs.readdirSync(options.home)) {
      if (name !== PATCH_FILE && name !== profilesName && kindOf(path.join(options.home, name)) === 'directory') {
        fs.symlinkSync(path.join(options.home, name), path.join(home, name), 'junction');
      }
    }
    const realProfile = path.join(options.profilesDir, profile);
    const copyProfile = path.join(home, profilesName, profile);
    fs.mkdirSync(copyProfile, { recursive: true });
    for (const name of fs.readdirSync(realProfile)) {
      if (name !== PATCH_FILE && name !== PROFILE_ROOT_FILE) linkOrCopy(path.join(realProfile, name), path.join(copyProfile, name));
    }
    const write = (file: string, content: string | undefined, real: string) => {
      if (content !== undefined) fs.writeFileSync(file, content);
      else if (fs.existsSync(real)) fs.copyFileSync(real, file);
    };
    write(path.join(copyProfile, PATCH_FILE), candidate.profilePatch, path.join(realProfile, PATCH_FILE));
    write(path.join(home, PATCH_FILE), candidate.homePatch, path.join(options.home, PATCH_FILE));

    return await readDumpDiagnostics(profile, { ...options, home });
  } catch (err) {
    return { ok: false, reason: `could not prepare a copy of DSH_HOME: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export function describeUnmatched(item: UnmatchedPatch): string {
  const layer = item.layer === 'profile' ? 'its cordis.patch.yml' : item.layer === 'global' ? 'the global cordis.patch.yml' : `bundle ${item.layer}`;
  return `[${item.profile}] ${item.id} (${layer})`;
}

// Bundles DSH skips when it loads these profiles; dshenv's plan still counts them as in sync.
export async function readSkippedBundles(
  profiles: string[],
  options: DumpCheckOptions
): Promise<{ skippedBundles: SkippedBundle[]; unchecked: string[] }> {
  const results = await Promise.all(profiles.map((profile) => readDumpDiagnostics(profile, options)));
  return {
    skippedBundles: results.flatMap((result) => (result.ok ? result.skippedBundles : [])),
    unchecked: results.flatMap((result, index) => (result.ok ? [] : [`${profiles[index]}: ${result.reason}`]))
  };
}
