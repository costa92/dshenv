import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { readJournalEntries } from '../../src/io/journal.js';
import { createEnvironmentSnapshot } from '../../src/io/backup.js';
import { acquireEnvironmentLock } from '../../src/io/lock.js';
import { ownedSkillDigests, planSkills, readSkillInventory } from '../../src/resources/skill.js';
import { loadState } from '../../src/manifest/files.js';

describe('rollbackEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-rollback-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(
      path.join(managerDir, 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
`
    );
    fs.writeFileSync(
      path.join(managerDir, 'lock.json'),
      `{"apiVersion":"dshenv-lock/v1","profiles":{"web":{"plugins":{}}}}`
    );
    fs.writeFileSync(
      path.join(managerDir, 'state.json'),
      `{"apiVersion":"dshenv-state/v1","lastApplied":"2026-01-01T00:00:00.000Z","appliedLockHash":"","profiles":{}}`
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should restore the previous manifest from the latest apply snapshot', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const original = fs.readFileSync(paths.manifestFile, 'utf8');

    await applyEnvironment(paths, {
      executor: async () => {
        const profileDir = path.join(tempHome, 'profiles', 'web');
        const packageDir = path.join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams');
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(
          path.join(profileDir, 'package.json'),
          JSON.stringify({
            name: 'dsh-profile-web',
            private: true,
            dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.21' },
            dsh: { profile: { bundles: ['@nanmicoder/dsh-agent-teams'] } }
          })
        );
        fs.writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21', dsh: { bundle: {} } })
        );
        return { success: true };
      }
    });

    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    const result = await rollbackEnvironment(paths);
    expect(result.rolledBack).toBe(true);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(original);
    const journal = await readJournalEntries(paths);
    expect(journal.some((entry) => entry.type === 'rollback-completed')).toBe(true);
  });

  it('keeps the baseline of a skill an apply put into DSH, so the next apply removes it again', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    await createEnvironmentSnapshot(paths, 'apply-before-skill');
    fs.mkdirSync(path.join(paths.skillsDir, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(paths.skillsDir, 'demo', 'SKILL.md'), '# demo\n');
    const applied = await applyEnvironment(paths, { executor: async () => ({ success: true }) });
    expect(applied.applied).toBe(true);
    expect(fs.existsSync(path.join(paths.dshSkillsDir, 'demo', 'SKILL.md'))).toBe(true);

    await rollbackEnvironment(paths, { operationId: 'apply-before-skill' });

    expect(fs.existsSync(path.join(paths.skillsDir, 'demo'))).toBe(false);
    const plan = planSkills(await readSkillInventory(paths), ownedSkillDigests(loadState(fs.readFileSync(paths.stateFile, 'utf8'))));
    expect(plan.unmanaged).toEqual([]);
    expect(plan.operations).toEqual([expect.objectContaining({ kind: 'remove', name: 'demo' })]);
  });

  it('keeps a committed apply when the journal cannot record its completion', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    fs.mkdirSync(path.join(paths.skillsDir, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(paths.skillsDir, 'demo', 'SKILL.md'), '# demo\n');
    const journal = path.join(paths.logsDir, 'journal.jsonl');
    const applied = await applyEnvironment(paths, {
      executor: async () => {
        // A directory where the journal file was makes the completion entry fail to append.
        fs.rmSync(journal, { force: true });
        fs.mkdirSync(journal);
        return { success: true };
      }
    });
    expect(applied.applied).toBe(true);
    expect(fs.existsSync(path.join(paths.dshSkillsDir, 'demo', 'SKILL.md'))).toBe(true);
    expect(ownedSkillDigests(loadState(fs.readFileSync(paths.stateFile, 'utf8')))).toHaveProperty('demo');
  });

  it('picks the snapshot once it holds the lock, so one taken while it waited counts', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await createEnvironmentSnapshot(paths, 'apply-older');
    const held = await acquireEnvironmentLock(paths);
    const rolling = rollbackEnvironment(paths);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const newer = await createEnvironmentSnapshot(paths, 'apply-newer');
    await held.release();
    expect((await rolling).snapshotId).toBe(newer.snapshotId);
  });

  it('should preview rollback without writing when dry-run', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await applyEnvironment(paths, {
      executor: async () => {
        const profileDir = path.join(tempHome, 'profiles', 'web');
        const packageDir = path.join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams');
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(
          path.join(profileDir, 'package.json'),
          JSON.stringify({
            name: 'dsh-profile-web',
            private: true,
            dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.21' },
            dsh: { profile: { bundles: ['@nanmicoder/dsh-agent-teams'] } }
          })
        );
        fs.writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21', dsh: { bundle: {} } })
        );
        return { success: true };
      }
    });
    fs.writeFileSync(paths.manifestFile, 'changed\n');
    const result = await rollbackEnvironment(paths, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe('changed\n');
  });

  it('saves the files it replaces so the rollback itself can be undone', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await createEnvironmentSnapshot(paths, 'apply-1');
    const handEdited = 'apiVersion: dshenv/v1\nprofiles:\n  api:\n    plugins: {}\n';
    fs.writeFileSync(paths.manifestFile, handEdited);

    const result = await rollbackEnvironment(paths, { operationId: 'apply-1' });
    const restored = fs.readFileSync(paths.manifestFile, 'utf8');
    expect(restored).not.toBe(handEdited);
    expect(result.backupSnapshotId).toMatch(/rollback/);

    // The saved snapshot must not be mistaken for the one it was taken against.
    await rollbackEnvironment(paths, { operationId: 'apply-1' });
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(restored);

    await rollbackEnvironment(paths, { operationId: result.backupSnapshotId });
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(handEdited);
  });

  it('names the snapshot that undoes a rollback which failed halfway', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(path.join(paths.skillsDir, 'alpha'), { recursive: true });
    const snapshot = await createEnvironmentSnapshot(paths, 'apply-3');
    const cp = fs.promises.cp;
    const spy = vi.spyOn(fs.promises, 'cp').mockImplementation(async (src, dest, options) => {
      if (String(src).startsWith(snapshot.snapshotDir)) {
        throw new Error('disk full');
      }
      return cp(src, dest, options);
    });
    let message = '';
    try {
      await rollbackEnvironment(paths, { operationId: 'apply-3' }).catch((err: Error) => {
        message = err.message;
      });
    } finally {
      spy.mockRestore();
    }
    const backup = message.match(/dshenv rollback (\S+) --yes/)?.[1];
    expect(message).toContain('disk full');
    expect(backup).toMatch(/pre-rollback-/);
    expect(fs.existsSync(path.join(paths.backupsDir, backup!))).toBe(true);
  });

  it('removes files that did not exist when the snapshot was taken', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.rmSync(paths.lockFile);
    await createEnvironmentSnapshot(paths, 'apply-2');
    fs.writeFileSync(paths.lockFile, '{"apiVersion":"dshenv-lock/v1","profiles":{}}');

    await rollbackEnvironment(paths, { operationId: 'apply-2' });
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });
});
