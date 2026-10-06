import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvironmentLock, EnvironmentManifest } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot, snapshotTime } from '../io/backup.js';
import { appendJournalEntry, readJournalEntries } from '../io/journal.js';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { loadState, parseOverlay, serializeLock } from '../manifest/files.js';
import { readOverlay } from '../overlay/effective.js';
import { mergeManifest } from '../overlay/merge.js';
import { overlayFilePath, readSelectionFile, type OverlaySelection } from '../overlay/selection.js';
import { assertMergesWithSavedSelection } from '../overlay/write.js';
import { buildPlan, type EnvironmentPlan } from '../planner/plan.js';
import { readSkillDigests, remoteSkillNames } from '../resources/skill.js';
import { readLocalSourceDigests } from '../source/local.js';
import { isAncestor } from './git.js';
import {
  diffLockEntries,
  findLockEntryConflicts,
  findLockEntryDrift,
  mergeRemoteLock,
  type LockEntryChanges
} from './lock-entries.js';
import { describeRemoteDrift, findLocalDrift, localFileDigest, readLocalLock } from './ownership.js';
import { REMOTE_API_VERSION, compareRemoteKeys, remoteFilePath, skillPathFromKey, writeRemoteConfig, type RemoteConfig } from './schema.js';
import { loadRemoteSnapshot, type RemoteSnapshot } from './snapshot.js';

export interface RemoteSubscription {
  url: string;
  branch: string;
  path: string;
}

export interface RemoteFileChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface PrepareSyncInput {
  paths: EnvironmentPaths;
  repoDir: string;
  subscription: RemoteSubscription;
  target: string;
  // null for `remote add`: nothing is owned yet.
  previous: RemoteConfig | null;
  replace?: boolean;
  discardLocalChanges?: boolean;
  selection: OverlaySelection | null;
}

export interface SyncPreview {
  status: 'up-to-date' | 'pending';
  from: string | null;
  to: string;
  files: RemoteFileChanges;
  lockEntries: LockEntryChanges;
  plan: EnvironmentPlan;
  snapshot: RemoteSnapshot;
  // The local lock with the team entries merged in; null means no lock.json is created.
  lock: EnvironmentLock | null;
  next: RemoteConfig;
}

export interface AcceptResult {
  operationId: string;
  snapshotId: string;
}

function hasChanges(changes: RemoteFileChanges | LockEntryChanges): boolean {
  return changes.added.length + changes.modified.length + changes.removed.length > 0;
}

function assertNoConflicts(input: PrepareSyncInput, snapshot: RemoteSnapshot, localLock: EnvironmentLock | null): void {
  const { paths, previous } = input;
  if (previous && !input.discardLocalChanges) {
    const drift = describeRemoteDrift(findLocalDrift(paths, previous), findLockEntryDrift(localLock, previous.lockEntries));
    if (drift.length > 0) {
      throw new ValidationError(
        `Remote-owned files and lock entries were changed locally: ${drift.join(', ')}; move the changes into a local overlay, or pass --discard-local-changes to overwrite them`
      );
    }
  }
  const ownedFiles = previous?.files ?? {};
  // A skill is one directory: team files added beside a local skill's would mix the two, so the directory must be free.
  const ownedSkills = remoteSkillNames(ownedFiles);
  for (const name of [...remoteSkillNames(snapshot.files)].sort()) {
    const dir = path.join(paths.skillsDir, name);
    if (!ownedSkills.has(name) && fs.existsSync(dir)) {
      throw new ValidationError(
        `Local skill '${name}' at ${dir} is not owned by the remote, but the remote now provides it; move it aside, then ${previous ? 'sync' : 'run remote add'} again`
      );
    }
  }
  for (const key of Object.keys(snapshot.files).sort(compareRemoteKeys)) {
    const file = remoteFilePath(paths, key);
    if (Object.hasOwn(ownedFiles, key) || !fs.existsSync(file) || holdsOnlyOwnedFiles(file, key, ownedFiles, snapshot.files)) {
      continue;
    }
    if (previous) {
      throw new ValidationError(`Local file ${file} is not owned by the remote, but the remote now provides it; move it aside, then sync again`);
    }
    if (!input.replace) {
      throw new ValidationError(`Local file ${file} already exists; pass --replace to overwrite it with the remote copy (a snapshot is taken first)`);
    }
  }
  for (const entry of findLockEntryConflicts(localLock, previous?.lockEntries ?? {}, snapshot.lockEntries)) {
    if (previous) {
      throw new ValidationError(`Local lock entry '${entry}' is not owned by the remote, but the remote lock now pins it; remove the local entry, then sync again`);
    }
    if (!input.replace) {
      throw new ValidationError(`Local lock entry '${entry}' already exists; pass --replace to overwrite it with the remote entry (a snapshot is taken first)`);
    }
  }
}

// A team file can replace a directory of team files the same update removes; a local file left in it still clashes.
function holdsOnlyOwnedFiles(dir: string, key: string, owned: Record<string, string>, next: Record<string, unknown>): boolean {
  if (!fs.lstatSync(dir).isDirectory()) {
    return false;
  }
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .every((entry) => {
      const rel = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
      const fileKey = `${key}/${rel}`;
      return Object.hasOwn(owned, fileKey) && !Object.hasOwn(next, fileKey);
    });
}

// A write keeps the mode of the file it replaces, so Git's executable bit is applied both ways.
async function applyExecutableBit(file: string, executable: boolean): Promise<void> {
  const mode = (await fs.promises.stat(file)).mode & 0o777;
  const next = executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
  if (next !== mode) {
    await fs.promises.chmod(file, next);
  }
}

// Git records only whether a file is executable; Windows has no such bit to compare.
function executableDiffers(file: string, executable: boolean): boolean {
  return process.platform !== 'win32' && fs.existsSync(file) && ((fs.statSync(file).mode & 0o111) !== 0) !== executable;
}

function computeChanges(
  paths: EnvironmentPaths,
  owned: Record<string, string>,
  next: Record<string, string>,
  executables: string[]
): RemoteFileChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const key of Object.keys(next).sort(compareRemoteKeys)) {
    if (!Object.hasOwn(owned, key)) {
      added.push(key);
    } else if (
      owned[key] !== next[key] ||
      localFileDigest(remoteFilePath(paths, key)) !== next[key] ||
      executableDiffers(remoteFilePath(paths, key), executables.includes(key))
    ) {
      // The second test catches owned files changed locally, which only get here with --discard-local-changes.
      modified.push(key);
    }
  }
  for (const key of Object.keys(owned).sort(compareRemoteKeys)) {
    if (!Object.hasOwn(next, key)) {
      removed.push(key);
    }
  }
  return { added, modified, removed };
}

function manifestAfter(
  paths: EnvironmentPaths,
  snapshot: RemoteSnapshot,
  files: RemoteFileChanges,
  selection: OverlaySelection | null
): EnvironmentManifest {
  // The overlay saved as selected comes from the update too when the remote owns it.
  assertMergesWithSavedSelection(paths, selection, snapshot.manifest, (name) => {
    const key = `overlays/${name}.yaml`;
    if (files.removed.includes(key)) return null;
    if (Object.hasOwn(snapshot.files, key)) return parseOverlay(snapshot.files[key].toString('utf8'), key);
    return fs.existsSync(overlayFilePath(paths, name)) ? readOverlay(paths, name) : null;
  });
  if (!selection) {
    return snapshot.manifest;
  }
  const key = `overlays/${selection.name}.yaml`;
  if (files.removed.includes(key)) {
    throw new ValidationError(
      `The active overlay '${selection.name}' is removed by the remote; select another overlay with dshenv overlay use, then sync again`
    );
  }
  const overlay = Object.hasOwn(snapshot.files, key)
    ? parseOverlay(snapshot.files[key].toString('utf8'), key)
    : readOverlay(paths, selection.name);
  // Every later command merges this pair, so an update that breaks the merge is refused now.
  return mergeManifest(snapshot.manifest, overlay, selection.name).manifest;
}

// envctl/skills as accepting would leave it, laid out in a scratch copy so the preview plan can digest it.
async function declaredSkillsAfter(paths: EnvironmentPaths, snapshot: RemoteSnapshot, files: RemoteFileChanges): Promise<Record<string, string>> {
  const changed = [...files.added, ...files.modified, ...files.removed].filter((key) => skillPathFromKey(key) !== null);
  if (changed.length === 0) {
    return readSkillDigests(paths.skillsDir);
  }
  // Only the skills the sync touches are laid out again; every other one, linked in or not, stays as it is.
  const touched = new Set(changed.map((key) => (skillPathFromKey(key) as string[])[0]));
  const current = await readSkillDigests(paths.skillsDir);
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dshenv-sync-skills-'));
  try {
    for (const name of touched) {
      const dir = path.join(paths.skillsDir, name);
      if (fs.existsSync(dir)) {
        // Symlinks are left out as copySkillDir leaves them out; copied as links, the preview would write through them.
        await fs.promises.cp(dir, path.join(scratch, name), { recursive: true, filter: (source) => !fs.lstatSync(source).isSymbolicLink() });
      }
    }
    // Removals first, as accepting does, so a path can turn from a file into a directory or back.
    const removed = changed.filter((key) => files.removed.includes(key));
    for (const key of [...removed, ...changed.filter((key) => !files.removed.includes(key))]) {
      const file = path.join(scratch, ...(skillPathFromKey(key) as string[]));
      if (files.removed.includes(key)) {
        await fs.promises.rm(file, { force: true });
        await removeEmptySkillDirs(scratch, key);
      } else {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, snapshot.files[key]);
        await applyExecutableBit(file, snapshot.executables.includes(key));
      }
    }
    const after = await readSkillDigests(scratch);
    const untouched = Object.entries(current).filter(([name]) => !touched.has(name));
    return { ...Object.fromEntries(untouched), ...after };
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}

// A killed accept leaves files half-written and remote.json stale; drift errors would then give the wrong advice.
async function assertNoUnfinishedSync(paths: EnvironmentPaths): Promise<void> {
  const entries = await readJournalEntries(paths);
  const last = entries.filter((entry) => entry.type.startsWith('sync-')).at(-1);
  if (!last || (last.type !== 'sync-started' && last.type !== 'sync-rollback-failed')) {
    return;
  }
  const started = entries.find((entry) => entry.type === 'sync-started' && entry.operationId === last.operationId)?.timestamp ?? last.timestamp;
  // Only a rollback to a snapshot from before that sync put its files back; a newer one restores them half-written.
  const undone = entries.some((entry) => {
    const restored = entry.type === 'rollback-completed' && entry.timestamp > last.timestamp ? snapshotTime(entry.details?.snapshotId) : null;
    return restored !== null && restored <= started;
  });
  if (!undone) {
    throw new ValidationError(
      `The previous sync ${last.operationId} did not finish; run dshenv rollback ${last.operationId} --yes to restore the files it started changing, then sync again`
    );
  }
}

export async function prepareSync(input: PrepareSyncInput): Promise<SyncPreview> {
  const { paths, repoDir, subscription, target, previous } = input;
  if (previous) {
    await assertNoUnfinishedSync(paths);
  }
  if (previous && previous.commit !== target && !(await isAncestor(repoDir, previous.commit, target))) {
    if (await isAncestor(repoDir, target, previous.commit)) {
      throw new ValidationError(
        `Remote commit ${target} is older than the pinned commit ${previous.commit}; sync only moves forward, so go back with dshenv rollback <snapshot id> --yes`
      );
    }
    throw new ValidationError(
      `Remote commit ${target} does not descend from the pinned commit ${previous.commit}; the remote history was rewritten or the ref is not on the subscribed history`
    );
  }
  // Read first: an unparseable lock may hold local entries, so even --discard-local-changes must not replace it.
  const localLock = readLocalLock(paths);
  const snapshot = await loadRemoteSnapshot(repoDir, target, subscription.path);
  assertNoConflicts(input, snapshot, localLock);

  const ownedEntries = previous?.lockEntries ?? {};
  const files = computeChanges(paths, previous?.files ?? {}, snapshot.digests, snapshot.executables);
  // Later commands fall back to the overlay saved as selected, so a sync run with --no-overlay must not delete it either.
  const saved = readSelectionFile(paths);
  if (saved !== null && saved !== input.selection?.name && files.removed.includes(`overlays/${saved}.yaml`)) {
    throw new ValidationError(
      `The overlay '${saved}' selected on this machine is removed by the remote; select another overlay with dshenv overlay use, then sync again`
    );
  }
  const lockEntries = diffLockEntries(localLock, ownedEntries, snapshot.lockEntries);
  const manifest = manifestAfter(paths, snapshot, files, input.selection);
  const lock = mergeRemoteLock(localLock, ownedEntries, snapshot.lock);
  const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
  const inventory = await readEnvironmentInventory(paths);
  if (inventory.skills) {
    inventory.skills = { ...inventory.skills, declared: await declaredSkillsAfter(paths, snapshot, files) };
  }
  const plan = buildPlan(manifest, lock, inventory, state, await readLocalSourceDigests(manifest));

  const next: RemoteConfig = {
    apiVersion: REMOTE_API_VERSION,
    url: subscription.url,
    branch: subscription.branch,
    path: subscription.path,
    commit: target,
    files: snapshot.digests,
    lockEntries: snapshot.lockEntries
  };
  const unchanged = !hasChanges(files) && !hasChanges(lockEntries);
  return {
    status: previous !== null && previous.commit === target && unchanged ? 'up-to-date' : 'pending',
    from: previous?.commit ?? null,
    to: target,
    files,
    lockEntries,
    plan,
    snapshot,
    lock,
    next
  };
}

export async function acceptSync(paths: EnvironmentPaths, preview: SyncPreview): Promise<AcceptResult> {
  const operationId = `sync-${crypto.randomBytes(6).toString('hex')}`;
  // Local files a new remote overlay replaces (remote add --replace) must be restorable too.
  const overlayKeys = Object.keys(preview.snapshot.files).filter((key) => key.startsWith('overlays/'));
  const snapshot = await createEnvironmentSnapshot(paths, operationId, { overlayKeys });
  await appendJournalEntry(paths, {
    operationId,
    type: 'sync-started',
    timestamp: new Date().toISOString(),
    details: { from: preview.from, to: preview.to, files: preview.files, lockEntries: preview.lockEntries }
  });

  const created: string[] = [];
  try {
    // Removals first, so a path can turn from a file into a directory or back.
    for (const key of preview.files.removed) {
      await fs.promises.rm(remoteFilePath(paths, key), { force: true });
      await removeEmptySkillDirs(paths.skillsDir, key);
    }
    for (const key of [...preview.files.added, ...preview.files.modified].sort(compareRemoteKeys)) {
      const file = remoteFilePath(paths, key);
      if (!fs.existsSync(file)) {
        created.push(file);
      }
      await writeAtomic(file, preview.snapshot.files[key], 'overwrite');
      await applyExecutableBit(file, preview.snapshot.executables.includes(key));
    }
    // Local entries are untouched by the merge, so the lock is only rewritten when a team entry changes.
    if (preview.lock && hasChanges(preview.lockEntries)) {
      await writeAtomic(paths.lockFile, serializeLock(preview.lock), 'overwrite');
    }
    await writeRemoteConfig(paths, preview.next);
  } catch (err) {
    try {
      // The snapshot knows nothing of overlays that did not exist, so those are removed first; lock.json is restored whole.
      for (const file of created) {
        await fs.promises.rm(file, { force: true });
      }
      await restoreEnvironmentSnapshot(snapshot, paths);
      await appendJournalEntry(paths, {
        operationId,
        type: 'sync-rollback',
        timestamp: new Date().toISOString(),
        details: { reason: err instanceof Error ? err.message : String(err) }
      });
    } catch (restoreErr) {
      const reason = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      await appendJournalEntry(paths, {
        operationId,
        type: 'sync-rollback-failed',
        timestamp: new Date().toISOString(),
        details: { reason: err instanceof Error ? err.message : String(err), restoreError: reason }
      }).catch(() => {});
      // Keep the original error (and its exit code), but tell the user the files are half-written and how to recover.
      if (err instanceof Error) {
        err.message += `; restoring the snapshot also failed (${reason}), run dshenv rollback ${operationId} --yes`;
      }
    }
    throw err;
  }

  await appendJournalEntry(paths, {
    operationId,
    type: 'sync-completed',
    timestamp: new Date().toISOString(),
    details: { commit: preview.to }
  });
  return { operationId, snapshotId: snapshot.snapshotId };
}

// A team skill whose last file went away leaves no empty directory for apply to install.
async function removeEmptySkillDirs(skillsDir: string, key: string): Promise<void> {
  const skillPath = skillPathFromKey(key);
  if (!skillPath) {
    return;
  }
  for (let depth = skillPath.length - 1; depth >= 1; depth--) {
    const dir = path.join(skillsDir, ...skillPath.slice(0, depth));
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) {
      return;
    }
    await fs.promises.rmdir(dir);
  }
}
