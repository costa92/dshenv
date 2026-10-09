import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { listEnvironmentSnapshots, snapshotOperationId, snapshotTime } from './backup.js';
import { acquireEnvironmentLock } from './lock.js';

export interface JournalEntry {
  operationId: string;
  type: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export async function appendJournalEntry(
  paths: EnvironmentPaths,
  entry: JournalEntry
): Promise<void> {
  await fs.promises.mkdir(paths.logsDir, { recursive: true });
  const logFile = path.join(paths.logsDir, 'journal.jsonl');
  const line = JSON.stringify(entry) + '\n';
  // Synced, so a started record is on disk before the writes it announces.
  const handle = await fs.promises.open(logFile, 'a');
  try {
    await handle.appendFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJournalEntries(
  paths: EnvironmentPaths
): Promise<JournalEntry[]> {
  const logFile = path.join(paths.logsDir, 'journal.jsonl');
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const content = await fs.promises.readFile(logFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore corrupted lines
    }
  }
  return entries;
}

// Operations that write several envctl files between a <kind>-started and a <kind>-completed (or -rollback) record.
const TRACKED_KINDS = ['sync', 'pull', 'adopt', 'apply'] as const;

export interface UnfinishedOperation {
  kind: (typeof TRACKED_KINDS)[number];
  operationId: string;
  // What the user ran: remote add records its accept as a sync from no commit.
  command: string;
}

// The last operation of each kind whose process died, or failed to undo itself, before it finished.
export async function findUnfinishedOperations(paths: EnvironmentPaths): Promise<UnfinishedOperation[]> {
  const entries = await readJournalEntries(paths);
  const unfinished: UnfinishedOperation[] = [];
  for (const kind of TRACKED_KINDS) {
    const last = entries.filter((entry) => entry.type.startsWith(`${kind}-`)).at(-1);
    if (!last || (last.type !== `${kind}-started` && last.type !== `${kind}-rollback-failed`)) {
      continue;
    }
    const started = entries.find((entry) => entry.type === `${kind}-started` && entry.operationId === last.operationId);
    const startedAt = started?.timestamp ?? last.timestamp;
    // Only a rollback to a snapshot from before it started puts its files back; a newer one restores them half-written.
    const undone = entries.some((entry) => {
      const restored = entry.type === 'rollback-completed' && entry.timestamp > last.timestamp ? snapshotTime(entry.details?.snapshotId) : null;
      return restored !== null && restored <= startedAt;
    });
    if (!undone) {
      const command = kind === 'sync' && started?.details?.from === null ? 'remote add' : kind;
      unfinished.push({ kind, operationId: last.operationId, command });
    }
  }
  return unfinished;
}

// Refuses to work on files a killed sync, pull, adopt or remote add left half-written; an interrupted apply only warns,
// as running it again converges. Without the environment lock held, a live operation's records are left alone.
export async function assertNoUnfinishedOperations(
  paths: EnvironmentPaths,
  options: { warn?: (message: string) => void; locked?: boolean } = {}
): Promise<void> {
  let unfinished = await findUnfinishedOperations(paths);
  if (unfinished.length > 0 && !options.locked) {
    let handle;
    try {
      handle = await acquireEnvironmentLock(paths, 0);
    } catch {
      return;
    }
    try {
      unfinished = await findUnfinishedOperations(paths);
    } finally {
      await handle.release();
    }
  }
  for (const operation of unfinished.filter((item) => item.kind === 'apply')) {
    options.warn?.(
      `Warning: the previous apply ${operation.operationId} was interrupted, so state.json may have lost which plugins need a DSH restart; ` +
        'run dshenv apply --yes again, then restart DSH\n'
    );
  }
  const blocking = unfinished.find((item) => item.kind !== 'apply');
  if (blocking) {
    const snapshot = (await listEnvironmentSnapshots(paths)).find((item) => snapshotOperationId(item.snapshotId) === blocking.operationId);
    throw new ValidationError(
      `The previous ${blocking.command} ${blocking.operationId} did not finish; run dshenv rollback ${snapshot?.snapshotId ?? blocking.operationId} --yes ` +
        `to restore the files it started changing, then ${blocking.command} again`
    );
  }
}

// An apply that ran to the end after an interrupted one has made DSH match the manifest, which settles the warning.
export async function settleInterruptedApply(paths: EnvironmentPaths): Promise<void> {
  const interrupted = async () => (await findUnfinishedOperations(paths)).find((item) => item.kind === 'apply');
  if (!(await interrupted())) {
    return;
  }
  // Under the lock, so an apply started meanwhile is not taken for the interrupted one.
  const handle = await acquireEnvironmentLock(paths);
  try {
    const operation = await interrupted();
    if (operation) {
      await appendJournalEntry(paths, { operationId: operation.operationId, type: 'apply-settled', timestamp: new Date().toISOString() });
    }
  } finally {
    await handle.release();
  }
}
