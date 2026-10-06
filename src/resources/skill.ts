import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { readRemoteConfig, skillPathFromKey } from '../remote/schema.js';
import { calculateSourceDigest } from '../source/local.js';
import { retryWhileBusy } from '../io/windows-retry.js';
import type { SkillPlanOperation } from '../planner/plan.js';
import type { EnvironmentState, SkillOwnershipRecord } from '../domain.js';

// name -> the digest both sides had when they last matched, as state.resources.skill records it.
export function ownedSkillDigests(state: EnvironmentState | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(state?.resources?.skill ?? {}).map(([name, record]) => [name, record.digest]));
}

export function skillOwnership(digests: Record<string, string>): Record<string, SkillOwnershipRecord> {
  return Object.fromEntries(Object.entries(digests).map(([name, digest]) => [name, { digest }]));
}

// name -> content digest of each skill directory
export interface SkillInventory {
  // envctl/skills: what the manifest declares
  declared: Record<string, string>;
  // $DSH_HOME/skills: what DSH loads
  live: Record<string, string>;
  // names of the skills the subscribed team remote owns
  remote?: string[];
}


const SkillNameRegex = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// The same entries calculateSourceDigest skips, so a copy digests like its source.
const SKIPPED = new Set(['node_modules', '.git', '.DS_Store']);

export async function readSkillDigests(dir: string): Promise<Record<string, string>> {
  if (!fs.existsSync(dir)) {
    return {};
  }
  const digests: Record<string, string> = {};
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false })?.isDirectory());
    // npm install in a skills directory leaves node_modules there; it is no skill.
    if (isDir && SkillNameRegex.test(entry.name) && !SKIPPED.has(entry.name)) {
      digests[entry.name] = await calculateSourceDigest(path.join(dir, entry.name), { publishedOnly: false, executableBit: true });
    }
  }
  return digests;
}

export async function readSkillInventory(paths: EnvironmentPaths): Promise<SkillInventory> {
  const remote = [...remoteSkillNames(readRemoteConfig(paths)?.files ?? {})];
  return { declared: await readSkillDigests(paths.skillsDir), live: await readSkillDigests(paths.dshSkillsDir), remote };
}

export function remoteSkillNames(remoteFiles: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(remoteFiles).flatMap((key) => skillPathFromKey(key)?.[0] ?? []));
}

function skillUpdateReason(declared: string, recorded: string | undefined, team: boolean): string {
  if (recorded === undefined) {
    return team
      ? 'Skill differs between the team copy and DSH, which were never synced; apply installs the team copy (the DSH copy goes to trash)'
      : "Skill differs between the manifest and DSH, which were never synced; apply installs the manifest copy (the DSH copy goes to trash), or 'dshenv pull --yes --prefer dsh' keeps the DSH copy";
  }
  if (recorded !== declared) {
    return 'Skill changed in the manifest';
  }
  return team
    ? 'Skill was edited in DSH but belongs to the team remote; change it in the team repository, or apply to restore the team copy (the DSH copy goes to trash)'
    : "Skill was edited in DSH; run 'dshenv pull --yes' to keep the edits, or apply to overwrite them (the DSH copy goes to trash)";
}

// `owned` holds the digest each skill had when both sides last matched (state.skills).
export function planSkills(
  skills: SkillInventory,
  owned: Record<string, string> | undefined
): { operations: SkillPlanOperation[]; unmanaged: string[] } {
  const operations: SkillPlanOperation[] = [];
  const unmanaged: string[] = [];
  for (const [name, digest] of Object.entries(skills.declared)) {
    const live = skills.live[name];
    if (live === undefined) {
      operations.push({ resource: 'skill', kind: 'install', name, reason: 'Skill is declared but not in DSH_HOME/skills' });
    } else if (live !== digest) {
      operations.push({ resource: 'skill', kind: 'update', name, reason: skillUpdateReason(digest, owned?.[name], skills.remote?.includes(name) ?? false) });
    }
  }
  for (const name of Object.keys(skills.live)) {
    if (skills.declared[name] !== undefined) {
      continue;
    }
    if (owned?.[name] !== undefined) {
      operations.push({ resource: 'skill', kind: 'remove', name, reason: 'Owned skill is no longer declared; apply moves it to trash' });
    } else {
      unmanaged.push(name);
    }
  }
  return { operations, unmanaged };
}

// A skill directory that is a symlink is copied as its content; symlinks inside stay symlinks, never their targets' files.
export async function copySkillDir(from: string, to: string): Promise<void> {
  await fs.promises.cp(await fs.promises.realpath(from), to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !SKIPPED.has(path.basename(source))
  });
}

// Replaces `target` with a copy of `source` (or removes it when source is null), keeping the old one under `trash`.
// Returns how to undo it.
export async function replaceSkillDir(source: string | null, target: string, trash: string): Promise<() => Promise<void>> {
  const staging = source ? `${target}.dshenv-${process.pid}-${Date.now()}` : null;
  const hadTarget = fs.existsSync(target);
  // A staging copy left in DSH's skills directory would read as one more skill.
  try {
    if (source && staging) {
      await copySkillDir(source, staging);
    }
    if (hadTarget) {
      await fs.promises.mkdir(path.dirname(trash), { recursive: true });
      await retryWhileBusy(() => fs.promises.rename(target, trash));
    }
    if (staging) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      try {
        await retryWhileBusy(() => fs.promises.rename(staging, target));
      } catch (err) {
        if (hadTarget) {
          await retryWhileBusy(() => fs.promises.rename(trash, target));
        }
        throw err;
      }
    }
  } catch (err) {
    if (staging) {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
    throw err;
  }
  return async () => {
    await fs.promises.rm(target, { recursive: true, force: true });
    if (hadTarget) {
      await retryWhileBusy(() => fs.promises.rename(trash, target));
    }
  };
}

export async function applySkillOperation(paths: EnvironmentPaths, operation: SkillPlanOperation, trashRoot: string): Promise<() => Promise<void>> {
  const source = operation.kind === 'remove' ? null : path.join(paths.skillsDir, operation.name);
  return replaceSkillDir(source, path.join(paths.dshSkillsDir, operation.name), path.join(trashRoot, 'skills', operation.name));
}

export interface SkillImportChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface SkillImportAction {
  name: string;
  kind: 'added' | 'changed' | 'removed';
}

// `owned` holds each skill's digest from when both sides last matched; without one, the manifest copy is the base.
export function planSkillImport(
  skills: { declared: Record<string, string>; live: Record<string, string> },
  owned: Record<string, string>,
  prefer: 'dsh' | 'manifest' | undefined
): { actions: SkillImportAction[]; conflicts: string[]; owned: Record<string, string> } {
  const actions: SkillImportAction[] = [];
  const conflicts: string[] = [];
  const nextOwned = { ...owned };
  for (const name of [...new Set([...Object.keys(skills.declared), ...Object.keys(skills.live)])].sort()) {
    const declared = skills.declared[name];
    const live = skills.live[name];
    const recorded = owned[name];
    if (live !== undefined && live === declared) {
      nextOwned[name] = live;
      continue;
    }
    // A declared skill DSH never had is apply's to install, not a deletion to pull.
    const dshChanged = live !== (recorded ?? declared) && !(live === undefined && recorded === undefined);
    if (!dshChanged) {
      continue;
    }
    // Two differing copies never synced have no base to tell which side changed.
    const manifestChanged = recorded !== undefined ? declared !== recorded : declared !== undefined && live !== undefined;
    if (manifestChanged && !prefer) {
      conflicts.push(name);
      continue;
    }
    if (manifestChanged && prefer === 'manifest') {
      continue;
    }
    actions.push({ name, kind: declared === undefined ? 'added' : live === undefined ? 'removed' : 'changed' });
    if (live === undefined) {
      delete nextOwned[name];
    } else {
      nextOwned[name] = live;
    }
  }
  return { actions, conflicts, owned: nextOwned };
}

export function summarizeSkillImport(actions: SkillImportAction[]): SkillImportChanges {
  const names = (kind: SkillImportAction['kind']) => actions.filter((action) => action.kind === kind).map((action) => action.name);
  return { added: names('added'), changed: names('changed'), removed: names('removed') };
}

// Takes the DSH copy of a skill into envctl/skills; the replaced declaration goes to trash.
export async function importSkill(paths: EnvironmentPaths, action: SkillImportAction, operationId: string): Promise<void> {
  const live = path.join(paths.dshSkillsDir, action.name);
  await replaceSkillDir(action.kind === 'removed' ? null : live, path.join(paths.skillsDir, action.name), path.join(paths.trashDir, operationId, 'envctl-skills', action.name));
}
