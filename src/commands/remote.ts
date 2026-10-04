import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationError } from '../errors.js';
import { withEnvironmentLock } from '../io/lock.js';
import { hasEmbeddedCredentials } from '../manifest/schema.js';
import { renderPlan } from '../output/render.js';
import { planJson } from '../planner/plan.js';
import { cloneOrigin, cloneRemoteRepo, defaultBranch, fetchBranch, isAncestor, resolveTargetRef } from '../remote/git.js';
import { lockEntryId } from '../remote/lock-entries.js';
import { findLocalDrift, findRemoteLockDrift } from '../remote/ownership.js';
import {
  DEFAULT_REMOTE_PATH,
  compareRemoteKeys,
  isValidBranchName,
  isValidRemotePath,
  readRemoteConfig,
  remoteRepoDir,
  type RemoteConfig
} from '../remote/schema.js';
import { acceptSync, prepareSync, type AcceptResult, type SyncPreview } from '../remote/sync.js';
import { resolveCliOverlay, resolveCliPaths, type CommandContext } from './context.js';
import { reportPreview } from './confirm.js';

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function renderChangeList(title: string, changes: { added: string[]; modified: string[]; removed: string[] }): string[] {
  const { added, modified, removed } = changes;
  if (added.length + modified.length + removed.length === 0) {
    return [`${title}: no changes`];
  }
  return [
    `${title}:`,
    ...added.map((item) => `  + ${item}`),
    ...modified.map((item) => `  ~ ${item}`),
    ...removed.map((item) => `  - ${item}`)
  ];
}

function renderChanges(preview: SyncPreview): string[] {
  return [...renderChangeList('Files', preview.files), ...renderChangeList('Lock entries', preview.lockEntries)];
}

function ownedEntryIds(config: RemoteConfig): string[] {
  return Object.entries(config.lockEntries)
    .flatMap(([profile, aliases]) => Object.keys(aliases).map((alias) => lockEntryId(profile, alias)))
    .sort();
}

// git records a relative clone path resolved against the directory it ran in, so only a URL or an absolute path
// can be compared with the clone's origin.
function comparableUrl(url: string): boolean {
  return url.includes(':') || path.isAbsolute(url);
}

// The branch tip, or the commit a ref names on that branch.
async function targetCommit(repoDir: string, branch: string, ref: string | undefined): Promise<string> {
  const tip = await fetchBranch(repoDir, branch);
  if (ref === undefined) {
    return tip;
  }
  const target = await resolveTargetRef(repoDir, ref);
  if (!(await isAncestor(repoDir, target, tip))) {
    throw new ValidationError(`Ref '${ref}' (${target}) is not on branch '${branch}'`);
  }
  return target;
}

export function registerRemoteCommands(ctx: CommandContext): void {
  const { program, writeOut, setExitCode } = ctx;

  function reportSync(
    opts: { json?: boolean },
    url: string,
    preview: SyncPreview,
    accepted: AcceptResult | null,
    dryRun: boolean | undefined,
    extra: Record<string, unknown> = {}
  ): void {
    const status = accepted ? 'accepted' : preview.status;
    setExitCode(status === 'pending' ? 2 : 0);
    if (opts.json) {
      writeOut(
        JSON.stringify(
          {
            status,
            ...extra,
            from: preview.from,
            to: preview.to,
            files: preview.files,
            lockEntries: preview.lockEntries,
            plan: planJson(preview.plan),
            ...(accepted ? { operationId: accepted.operationId, snapshotId: accepted.snapshotId } : {})
          },
          null,
          2
        ) + '\n'
      );
      return;
    }
    if (status === 'up-to-date') {
      writeOut(`Already up to date with ${url} at ${preview.to}.\n`);
      return;
    }
    const range = preview.from ? `${shortCommit(preview.from)} -> ${shortCommit(preview.to)}` : `at ${shortCommit(preview.to)}`;
    writeOut(`${[`Remote ${url} ${range}`, ...renderChanges(preview), 'Plan after accepting:'].join('\n')}\n${renderPlan(preview.plan)}`);
    if (accepted) {
      writeOut(`Accepted ${preview.to} (snapshot ${accepted.snapshotId}).\nNext: dshenv plan, then dshenv apply --yes.\n`);
    } else {
      // The branch can move on after the review; --ref pins the accept to the commit shown here.
      const accept = `--ref ${preview.to} --yes`;
      writeOut(
        `Accepting means agreeing to run the plugins this commit declares. ` +
          `${dryRun ? `Run it again without --dry-run and with ${accept}` : `Re-run with ${accept}`} to accept this commit.\n`
      );
    }
  }

  const remoteCmd = program.command('remote').description('Follow a team configuration repository');

  remoteCmd
    .command('add <url>')
    .description('Subscribe to a team configuration repository and pin its newest commit')
    .option('--branch <name>', 'branch to follow; defaults to the branch the remote HEAD points to')
    .option('--path <dir>', 'directory inside the repository that holds manifest.yaml', DEFAULT_REMOTE_PATH)
    .option('--ref <ref>', 'commit or tag on the branch to pin instead of its newest commit')
    .option('--replace', 'overwrite a local manifest, same-named overlay or lock entry the team lock pins (a snapshot is taken first)')
    .option('--dry-run', 'show what remote add would write without writing; exit code 2 when there is any')
    .option('-y, --yes', 'accept and write the remote files; without it remote add only previews')
    .action(async (url: string, cmdOpts: { branch?: string; path: string; ref?: string; replace?: boolean; dryRun?: boolean; yes?: boolean }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (hasEmbeddedCredentials(url)) {
        throw new ValidationError('Git URL must not embed credentials; use SSH or a git credential helper');
      }
      if (url.startsWith('-')) {
        throw new ValidationError(`Invalid Git URL: ${url}`);
      }
      if (!isValidRemotePath(cmdOpts.path)) {
        throw new ValidationError(`Invalid --path '${cmdOpts.path}': use '.' or a relative directory without '.' or '..' segments`);
      }
      if (cmdOpts.branch !== undefined && !isValidBranchName(cmdOpts.branch)) {
        throw new ValidationError(`Invalid --branch '${cmdOpts.branch}'`);
      }

      const { subscription, preview, accepted } = await withEnvironmentLock(paths, async () => {
        if (fs.existsSync(paths.remoteFile)) {
          throw new ValidationError(`A remote is already configured in ${paths.remoteFile}; run dshenv remote remove --yes first`);
        }
        // Without remote.json any clone here is stale; this command owns the directory until it succeeds.
        await fs.promises.rm(paths.remoteDir, { recursive: true, force: true });
        const repoDir = remoteRepoDir(paths);
        try {
          await cloneRemoteRepo(url, repoDir);
          const branch = cmdOpts.branch ?? (await defaultBranch(repoDir));
          if (!isValidBranchName(branch)) {
            throw new ValidationError(`Remote default branch '${branch}' is not a supported branch name; pass --branch`);
          }
          const target = await targetCommit(repoDir, branch, cmdOpts.ref);
          const subscription = { url, branch, path: cmdOpts.path };
          const preview = await prepareSync({
            paths,
            repoDir,
            subscription,
            target,
            previous: null,
            replace: Boolean(cmdOpts.replace),
            selection: resolveCliOverlay(opts, paths)
          });
          if (cmdOpts.dryRun || !cmdOpts.yes) {
            await fs.promises.rm(paths.remoteDir, { recursive: true, force: true });
            return { subscription, preview, accepted: null };
          }
          return { subscription, preview, accepted: await acceptSync(paths, preview) };
        } catch (err) {
          await fs.promises.rm(paths.remoteDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
      });
      reportSync(opts, url, preview, accepted, cmdOpts.dryRun, subscription);
    });

  remoteCmd
    .command('show')
    .description('Show the subscribed remote, its pinned commit, and remote files and lock entries changed locally')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const config = readRemoteConfig(paths);
      if (!config) {
        writeOut(opts.json ? `${JSON.stringify({ subscribed: false }, null, 2)}\n` : 'No remote configured.\n');
        return;
      }
      const drift = findLocalDrift(paths, config);
      const lockDrift = findRemoteLockDrift(paths, config);
      const files = Object.keys(config.files).sort(compareRemoteKeys);
      const lockEntries = ownedEntryIds(config);
      if (opts.json) {
        writeOut(
          JSON.stringify(
            { subscribed: true, url: config.url, branch: config.branch, path: config.path, commit: config.commit, files, lockEntries, drift, lockDrift },
            null,
            2
          ) + '\n'
        );
        return;
      }
      const fileStatus = new Map(drift.map((entry) => [entry.file, entry.status]));
      const entryStatus = new Map(lockDrift.map((entry) => [entry.entry, entry.status]));
      const lines = [`Remote: ${config.url}`, `Branch: ${config.branch}`, `Path: ${config.path}`, `Commit: ${config.commit}`, 'Files:'];
      for (const file of files) {
        const state = fileStatus.get(file);
        lines.push(`  ${file}${state ? ` (${state})` : ''}`);
      }
      lines.push(lockEntries.length > 0 ? 'Lock entries:' : 'Lock entries: none');
      for (const entry of lockEntries) {
        const state = entryStatus.get(entry);
        lines.push(`  ${entry}${state ? ` (${state})` : ''}`);
      }
      writeOut(`${lines.join('\n')}\n`);
    });

  remoteCmd
    .command('remove')
    .description('Stop following the remote; its files and lock entries stay in place as local ones')
    .option('--dry-run', 'show what remote remove would leave in place; exit code 2')
    .option('-y, --yes', 'remove it; without it remote remove only previews')
    .action(async (cmdOpts: { dryRun?: boolean; yes?: boolean }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (cmdOpts.dryRun || !cmdOpts.yes) {
        const current = readRemoteConfig(paths);
        if (!current) {
          throw new ValidationError('No remote is configured');
        }
        const files = Object.keys(current.files).sort(compareRemoteKeys);
        const lockEntries = ownedEntryIds(current);
        if (opts.json) {
          writeOut(JSON.stringify({ status: 'pending', url: current.url, files, lockEntries }, null, 2) + '\n');
        } else {
          writeOut(`Would stop following ${current.url}; ${files.length} file(s) and ${lockEntries.length} lock entry(ies) would stay in place as local ones.\n`);
        }
        reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: true, action: 'remove the remote' });
        return;
      }
      const config = await withEnvironmentLock(paths, async () => {
        const current = readRemoteConfig(paths);
        if (!current) {
          throw new ValidationError('No remote is configured');
        }
        await fs.promises.rm(paths.remoteFile, { force: true });
        await fs.promises.rm(paths.remoteDir, { recursive: true, force: true });
        return current;
      });
      const files = Object.keys(config.files).sort(compareRemoteKeys);
      const lockEntries = ownedEntryIds(config);
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'removed', url: config.url, files, lockEntries }, null, 2) + '\n');
      } else {
        writeOut(`Removed remote ${config.url}; ${files.length} file(s) and ${lockEntries.length} lock entry(ies) stay in place as local ones.\n`);
      }
    });

  // remote sync, and the top-level sync it replaced, kept out of help for old scripts.
  for (const syncCmd of [remoteCmd.command('sync'), program.command('sync', { hidden: true })]) {
    syncCmd
      .description('Fetch the subscribed remote and preview or accept its newest commit')
      .option('--ref <ref>', 'commit or tag on the subscribed branch to move to')
      .option('--discard-local-changes', 'overwrite remote-owned files and lock entries that were changed locally')
      .option('--dry-run', 'show what remote sync would write without writing; exit code 2 when there is any')
      .option('-y, --yes', 'accept and write the remote files; without it remote sync only previews')
      .action(async (cmdOpts: { ref?: string; discardLocalChanges?: boolean; dryRun?: boolean; yes?: boolean }) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        const { url, preview, accepted } = await withEnvironmentLock(paths, async () => {
          const config = readRemoteConfig(paths);
          if (!config) {
            throw new ValidationError('No remote is configured; run dshenv remote add <url> first');
          }
          const repoDir = remoteRepoDir(paths);
          // remote remove deletes the clone, and rolling back past it brings remote.json back without one, or with
          // the clone of a remote added since.
          if (!fs.existsSync(repoDir) || (comparableUrl(config.url) && (await cloneOrigin(repoDir)) !== config.url)) {
            await fs.promises.rm(repoDir, { recursive: true, force: true });
            await cloneRemoteRepo(config.url, repoDir);
          }
          const target = await targetCommit(repoDir, config.branch, cmdOpts.ref);
          const preview = await prepareSync({
            paths,
            repoDir,
            subscription: config,
            target,
            previous: config,
            discardLocalChanges: Boolean(cmdOpts.discardLocalChanges),
            selection: resolveCliOverlay(opts, paths)
          });
          const accepted = preview.status === 'pending' && cmdOpts.yes && !cmdOpts.dryRun ? await acceptSync(paths, preview) : null;
          return { url: config.url, preview, accepted };
        });
        reportSync(opts, url, preview, accepted, cmdOpts.dryRun);
      });
  }
}
