import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { createEnvironmentSnapshot } from '../../src/io/backup.js';
import { appendJournalEntry, findUnfinishedOperations } from '../../src/io/journal.js';

describe('findUnfinishedOperations', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-journal-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // The clock was set back between the snapshot and the journal entry, so their times disagree; their order does not.
  it('counts a rollback to the operation’s own snapshot as undoing it whatever the clock said', async () => {
    const snapshot = await createEnvironmentSnapshot(paths, 'sync-aaaa');
    await appendJournalEntry(paths, { operationId: 'sync-aaaa', type: 'sync-started', timestamp: '2000-01-01T00:00:00.000Z' });
    expect(await findUnfinishedOperations(paths)).toEqual([expect.objectContaining({ kind: 'sync', operationId: 'sync-aaaa' })]);

    await appendJournalEntry(paths, {
      operationId: 'rollback-bbbb',
      type: 'rollback-completed',
      timestamp: '2000-01-01T00:00:01.000Z',
      details: { snapshotId: snapshot.snapshotId }
    });
    expect(await findUnfinishedOperations(paths)).toEqual([]);
  });

  it('keeps an operation unfinished after a rollback to a snapshot taken later than its own', async () => {
    await createEnvironmentSnapshot(paths, 'sync-aaaa');
    await appendJournalEntry(paths, { operationId: 'sync-aaaa', type: 'sync-started', timestamp: new Date().toISOString() });
    const later = await createEnvironmentSnapshot(paths, 'pre-rollback-cccc');
    await appendJournalEntry(paths, {
      operationId: 'rollback-bbbb',
      type: 'rollback-completed',
      timestamp: new Date().toISOString(),
      details: { snapshotId: later.snapshotId }
    });
    expect(await findUnfinishedOperations(paths)).toEqual([expect.objectContaining({ kind: 'sync', operationId: 'sync-aaaa' })]);
  });
});
