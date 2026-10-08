import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { loadManifest, loadLock, serializeLock, serializeManifest } from '../manifest/files.js';
import { writeAtomic } from '../io/atomic-file.js';
import {
  inspectGitWorkingTree,
  cloneManagedGit,
  safeFastForwardManagedGit,
  managedGitSourceDir,
  packageNameFromGitUrl,
  normalizeGitUrl,
  sameGitUrl,
  checkoutCommit,
  assertCheckoutServes,
  assertCommitOnOrigin
} from '../source/git.js';
import { inspectLocalSource } from '../source/local.js';
import { ValidationError, missingManifestError } from '../errors.js';
import { mergeManifest } from '../overlay/merge.js';
import { loadEffectiveManifest, readOverlay } from '../overlay/effective.js';
import { acquireEnvironmentLock, withEnvironmentLock } from '../io/lock.js';
import { retryWhileBusy } from '../io/windows-retry.js';
import { hasEmbeddedCredentials } from '../manifest/schema.js';
import { readPackageJsonName } from '../source/local.js';
import { assertLockEntryNotRemoteOwned, assertNotRemoteOwned } from '../remote/ownership.js';
import { assertBaseMergesWithOverlay, resolveWriteLayer, saveOverlay, setOverlayPluginFields, type WriteLayer } from '../overlay/write.js';
import { overlayFilePath, type OverlaySelection } from '../overlay/selection.js';
import { isSameCommit } from '../resources/plugin.js';
import { reportPreview } from './confirm.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { PluginSource } from '../domain.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, aliasOption, assertKnownProfile, writeLayer, type CommandContext } from './context.js';

// The git source the layer being written declares for this alias and repository, as the effective manifest has it.
function declaredGitSource(
  paths: EnvironmentPaths,
  selection: OverlaySelection | null,
  layer: WriteLayer,
  profile: string,
  alias: string,
  url: string
): Extract<PluginSource, { type: 'git' }> | undefined {
  if (!fs.existsSync(paths.manifestFile)) {
    return undefined;
  }
  const manifest = layer === 'overlay'
    ? loadEffectiveManifest(paths, selection).manifest
    : loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const source = manifest.profiles[profile]?.plugins[alias]?.source;
  return source?.type === 'git' && sameGitUrl(source.url, url) ? source : undefined;
}

function overlaySuffix(name: string): string {
  return ` (overlay '${name}')`;
}

export function registerSourceCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  const sourceCmd = program.command('source').description('Manage local and Git plugin sources');

  sourceCmd
    .command('show [dir]')
    .alias('status')
    .description('Show the Git working tree and digest of a source directory')
    .option('-p, --profile <name>', 'inspect the managed clone for this profile', profileOption)
    .option('--as <alias>', 'manifest alias when --profile is set', aliasOption)
    .action(async (sourcePath?: string, cmdOpts?: { profile?: string; as?: string }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      let targetDir: string;
      if (cmdOpts?.profile) {
        const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
        let alias = cmdOpts.as;
        if (!alias) {
          const gitAliases = Object.entries(manifest.profiles[cmdOpts.profile]?.plugins ?? {})
            .filter(([, plugin]) => plugin.source.type === 'git')
            .map(([name]) => name);
          if (gitAliases.length !== 1) {
            throw new ValidationError('source show --profile requires --as when the profile does not have exactly one git plugin');
          }
          alias = gitAliases[0];
        }
        const plugin = manifest.profiles[cmdOpts.profile]?.plugins[alias];
        if (!plugin || plugin.source.type !== 'git') {
          throw new ValidationError(`Git plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
        }
        targetDir = sourcePath
          ? path.resolve(process.cwd(), sourcePath)
          : managedGitSourceDir(paths.managerDir, cmdOpts.profile, plugin.package);
      } else {
        targetDir = sourcePath ? path.resolve(process.cwd(), sourcePath) : process.cwd();
      }
      const gitStatus = await inspectGitWorkingTree(targetDir);
      let localInfo: unknown = null;
      try {
        localInfo = await inspectLocalSource(targetDir);
      } catch {
        // Not a standard plugin source dir
      }

      const result = {
        dir: targetDir,
        git: gitStatus,
        local: localInfo
      };

      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`Source: ${targetDir}\n`);
        writeOut(`  Git Repo: ${gitStatus.isGitRepo ? 'Yes' : 'No'}\n`);
        if (gitStatus.isGitRepo) {
          writeOut(`  Dirty: ${gitStatus.isDirty ? 'Yes (uncommitted changes)' : 'No'}\n`);
          writeOut(`  Commit: ${gitStatus.commit ?? 'unknown'}\n`);
          if (gitStatus.branch) {
            writeOut(`  Branch: ${gitStatus.branch}\n`);
          }
        }
      }
    });

  sourceCmd
    .command('clone <url> [dir]')
    .description('Clone a Git plugin repository; with --profile, store under envctl/sources and lock the commit')
    .option('--ref <ref>', 'branch or tag to clone')
    .option('-p, --profile <name>', 'record the clone as a managed git plugin for this profile', profileOption)
    .option('--as <alias>', 'manifest alias when --profile is set', aliasOption)
    .option('--package <name>', 'package name when --profile is set; defaults to the cloned package.json name')
    .addOption(writeLayer())
    .option('--new-profile', 'with --profile: allow a profile that is neither declared nor created yet')
    .action(async (given: string, targetDir: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const url = normalizeGitUrl(given);
      // git would also keep such a URL in the clone's .git/config, so refuse it even without --profile.
      if (hasEmbeddedCredentials(url)) {
        throw new ValidationError('Git URL must not embed credentials; use SSH or a git credential helper');
      }
      // The same default alias install gives this repository, so cloning after install names the same plugin.
      const alias: string = cmdOpts.as || packageNameFromGitUrl(url).replace(/^(dsh-plugin-|dsh-)/, '');
      if (!targetDir && !cmdOpts.profile) {
        throw new ValidationError('source clone requires <dir> or --profile');
      }
      if (!cmdOpts.profile && cmdOpts.layer !== undefined) {
        throw new ValidationError('--layer requires --profile for source clone');
      }
      if (cmdOpts.profile) {
        assertKnownProfile(paths, opts, cmdOpts.profile, cmdOpts.newProfile);
      }
      const selection = cmdOpts.profile ? resolveCliOverlay(opts, paths) : null;
      const layer = resolveWriteLayer(selection, cmdOpts.layer);
      const explicitTarget = targetDir ? path.resolve(process.cwd(), targetDir) : null;
      const sourcesDir = path.join(paths.managerDir, 'sources');
      // A managed clone is named after its package, which is only known once cloned, so it lands in a staging dir first.
      const cloneDir = explicitTarget ?? path.join(sourcesDir, `.staging-${crypto.randomBytes(6).toString('hex')}`);

      // Hold the lock from reading the manifest until the lock file is written, cloning included.
      const lockHandle = cmdOpts.profile ? await acquireEnvironmentLock(paths) : null;
      // Checked under the lock, so a concurrent clone's directories are never counted as ours.
      let ownedClone: string | null = fs.existsSync(cloneDir) ? null : cloneDir;
      const createdParents = explicitTarget || fs.existsSync(sourcesDir) ? [] : [sourcesDir];
      let res: Awaited<ReturnType<typeof cloneManagedGit>>;
      let resolvedTarget = cloneDir;
      // Set once the manifest (or overlay) is written, to put it back if the lock write then fails.
      let restoreManifest: (() => Promise<void>) | null = null;
      try {
        if (cmdOpts.profile && !fs.existsSync(paths.manifestFile)) {
          throw missingManifestError(paths.manifestFile);
        }
        if (cmdOpts.profile) {
          // Refuse before cloning: this command writes the alias's lock entry, and the base unless it targets the overlay.
          assertLockEntryNotRemoteOwned(paths, cmdOpts.profile, alias);
          if (layer !== 'overlay') {
            assertNotRemoteOwned(paths, paths.manifestFile);
          } else if (selection) {
            assertNotRemoteOwned(paths, overlayFilePath(paths, selection.name));
          }
        }
        // A commit or ref the manifest already declares for this repository is what gets cloned and locked; --ref replaces it.
        const declared = cmdOpts.profile ? declaredGitSource(paths, selection, layer, cmdOpts.profile, alias, url) : undefined;
        const pinned = cmdOpts.ref === undefined && declared?.commit !== undefined ? declared.commit : undefined;
        const ref: string | undefined = cmdOpts.ref ?? (pinned === undefined ? declared?.ref : undefined);
        res = await cloneManagedGit(url, cloneDir, ref);
        if (pinned !== undefined) {
          const commit = await checkoutCommit(cloneDir, pinned);
          if (commit === null) {
            throw new ValidationError(`Commit ${pinned} that the manifest pins for '${alias}' is not in ${url}; fix the manifest commit, or pass --ref`);
          }
          res = { commit };
        }
        // The manifest keeps its own spelling of the URL, which the lock must match.
        const source: PluginSource = { type: 'git', url: declared?.url ?? url, ...(pinned !== undefined ? { commit: pinned } : ref !== undefined ? { ref } : {}) };

        if (cmdOpts.profile) {
          const profile: string = cmdOpts.profile;
          const packageName: string = cmdOpts.package ?? readPackageJsonName(cloneDir) ?? packageNameFromGitUrl(url);
          let writeManifest: () => Promise<void>;
          const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
          // install names a git plugin after its repository, not knowing its package.json; the clone does know it.
          const sameRepository = (declaredSource: PluginSource | undefined) => declaredSource?.type === 'git' && sameGitUrl(declaredSource.url, url);
          // Replacing the entry would drop the other package's patches and enabled state without a word.
          const aliasTaken = (current: string) => new ValidationError(
            `Alias '${alias}' is '${current}' in profile '${profile}'; clone '${packageName}' under another alias with --as <alias>, or remove '${alias}' first`
          );
          const manifestTarget = layer === 'overlay' && selection ? overlayFilePath(paths, selection.name) : paths.manifestFile;
          const original = fs.existsSync(manifestTarget) ? fs.readFileSync(manifestTarget) : null;
          if (layer === 'overlay' && selection) {
            const overlayDoc = readOverlay(paths, selection.name);
            const baseEntry = base.profiles[profile]?.plugins[alias];
            if (baseEntry && baseEntry.package !== packageName) {
              throw new ValidationError(`Alias '${alias}' is '${baseEntry.package}' in the base manifest; an overlay cannot change its package`);
            }
            const overlayEntry = overlayDoc.profiles?.[profile]?.plugins?.[alias];
            if (overlayEntry && !overlayEntry.remove && overlayEntry.package !== undefined && overlayEntry.package !== packageName) {
              if (!sameRepository(overlayEntry.source)) {
                throw aliasTaken(overlayEntry.package);
              }
              overlayEntry.package = packageName;
            }
            // An overlay entry without a package only adjusts a base plugin, so with none in the base nothing is declared yet.
            const exists = baseEntry ? !overlayEntry?.remove : overlayEntry?.package !== undefined && !overlayEntry.remove;
            setOverlayPluginFields(overlayDoc, profile, alias, exists
              ? { source }
              : baseEntry
                ? { enabled: true, source }
                : { package: packageName, enabled: true, source });
            mergeManifest(base, overlayDoc, selection.name);
            writeManifest = () => saveOverlay(paths, selection.name, base, overlayDoc);
          } else {
            if (!base.profiles[profile]) {
              base.profiles[profile] = { plugins: {} };
            }
            const current = base.profiles[profile].plugins[alias];
            if (current && current.package !== packageName && !sameRepository(current.source)) {
              throw aliasTaken(current.package);
            }
            base.profiles[profile].plugins[alias] = current
              ? { ...current, package: packageName, source }
              : { package: packageName, enabled: true, source };
            assertBaseMergesWithOverlay(paths, selection, base);
            writeManifest = () => writeAtomic(paths.manifestFile, serializeManifest(base), 'overwrite');
          }

          if (!explicitTarget) {
            const managedDir = managedGitSourceDir(paths.managerDir, profile, packageName);
            if (fs.existsSync(managedDir)) {
              throw new ValidationError(`Managed source already exists: ${managedDir}`);
            }
            if (!fs.existsSync(path.dirname(managedDir))) {
              createdParents.unshift(path.dirname(managedDir));
            }
            await fs.promises.mkdir(path.dirname(managedDir), { recursive: true });
            await retryWhileBusy(() => fs.promises.rename(cloneDir, managedDir));
            ownedClone = managedDir;
            resolvedTarget = managedDir;
          }

          // Parsed before any write, so a corrupt lock fails the command with the manifest unchanged.
          const lock = fs.existsSync(paths.lockFile)
            ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
            : { apiVersion: 'dshenv-lock/v1' as const, profiles: {} };
          await writeManifest();
          restoreManifest = () =>
            original ? writeAtomic(manifestTarget, original, 'overwrite') : fs.promises.rm(manifestTarget, { force: true });

          if (!lock.profiles[profile]) {
            lock.profiles[profile] = { plugins: {} };
          }
          lock.profiles[profile].plugins[alias] = {
            package: packageName,
            source: { type: 'git', url: source.url, commit: res.commit }
          };
          await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
        }
      } catch (err) {
        // Leave nothing behind that this command created: the manifest edit, the clone, and parent directories only while empty.
        await restoreManifest?.().catch(() => {});
        if (ownedClone) {
          await fs.promises.rm(ownedClone, { recursive: true, force: true }).catch(() => {});
        }
        for (const dir of createdParents) {
          await fs.promises.rmdir(dir).catch(() => {});
        }
        throw err;
      } finally {
        await lockHandle?.release();
      }

      const wroteOverlay = Boolean(cmdOpts.profile) && layer === 'overlay' && Boolean(selection);
      if (opts.json) {
        writeOut(JSON.stringify({
          status: 'cloned',
          url,
          target: resolvedTarget,
          commit: res.commit,
          profile: cmdOpts.profile,
          alias,
          ...(wroteOverlay && selection ? { layer: 'overlay', overlay: selection.name } : {})
        }, null, 2) + '\n');
      } else {
        writeOut(`Cloned ${url} to ${resolvedTarget} (HEAD at ${res.commit})${wroteOverlay && selection ? overlaySuffix(selection.name) : ''}\n`);
      }
    });

  sourceCmd
    .command('sync [dir] [targetRef]')
    .alias('pull')
    .description('Fast-forward a Git checkout; with --profile, also update the lock commit')
    // A second positional ref still works; --ref is the one spelling shown, as in source clone.
    .usage('[options] [dir]')
    .option('-p, --profile <name>', 'update this profile\'s managed clone under envctl/sources and its lock commit, instead of a directory', profileOption)
    .option('--as <alias>', 'manifest alias when --profile is set', aliasOption)
    .option('--ref <ref>', 'commit or ref to fast-forward to (default: the upstream of the checked-out branch)')
    .option('--dry-run', 'show where the checkout and lock would move without moving them; exit code 2 when they would')
    .option('-y, --yes', 'move them; without it source sync only previews, like --dry-run')
    .action(async (targetDir: string | undefined, targetRef: string | undefined, cmdOpts, command: Command) => {
      // dshenv pull runs the other way, so the old name says which of the two this is.
      if (command.parent?.args[0] === 'pull') {
        ctx.writeErr("'source pull' is an old name for 'source sync', which moves a clone from its upstream Git; 'dshenv pull' takes changes made in DSH into the manifest\n");
      }
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (cmdOpts.ref !== undefined && targetRef !== undefined) {
        throw new ValidationError('Give the ref once: with --ref or as the second argument, not both');
      }
      const ref = cmdOpts.ref || targetRef || undefined;
      const dryRun = Boolean(cmdOpts.dryRun) || !cmdOpts.yes;

      // Resolve the manifest and ownership only after locking, and hold it through Git and lock.json writes.
      const sync = async () => {
        let resolvedTarget: string;
        let alias: string | undefined;
        let packageName: string | undefined;
        let gitUrl: string | undefined;
        let declaredRef: string | undefined;
        let pinnedCommit: string | undefined;
        if (cmdOpts.profile) {
          const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
          alias = cmdOpts.as;
          if (!alias) {
            const plugins = manifest.profiles[cmdOpts.profile]?.plugins ?? {};
            const gitAliases = Object.entries(plugins)
              .filter(([, plugin]) => plugin.source.type === 'git')
              .map(([name]) => name);
            if (gitAliases.length !== 1) {
              throw new ValidationError('source sync --profile requires --as when the profile does not have exactly one git plugin');
            }
            alias = gitAliases[0];
          }
          const plugin = manifest.profiles[cmdOpts.profile]?.plugins[alias];
          if (!plugin || plugin.source.type !== 'git') {
            throw new ValidationError(`Git plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
          }
          packageName = plugin.package;
          gitUrl = plugin.source.url;
          declaredRef = plugin.source.ref;
          pinnedCommit = plugin.source.commit;
          resolvedTarget = targetDir
            ? path.resolve(process.cwd(), targetDir)
            : managedGitSourceDir(paths.managerDir, cmdOpts.profile, packageName);
        } else {
          resolvedTarget = path.resolve(process.cwd(), targetDir ?? '.');
        }

        if (cmdOpts.profile && alias) {
          // The lock entry is rewritten after the fast-forward, so refuse before touching the checkout.
          assertLockEntryNotRemoteOwned(paths, cmdOpts.profile, alias);
        }
        if (gitUrl) {
          await assertCheckoutServes(resolvedTarget, gitUrl);
        }

        // A clone under envctl/sources is dshenv's to move either way; a pinned clone is detached, so it follows the declared ref.
        // Validate the lock before moving the checkout, while the same environment lock is held.
        const lock = cmdOpts.profile
          ? fs.existsSync(paths.lockFile)
            ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
            : { apiVersion: 'dshenv-lock/v1' as const, profiles: {} }
          : null;
        const res = await safeFastForwardManagedGit(resolvedTarget, ref, {
          ...(cmdOpts.profile && !targetDir ? { managed: true, detachedRef: declaredRef ?? 'origin/HEAD' } : {}),
          dryRun,
          afterUpdate: async (result) => {
            if (gitUrl) await assertCommitOnOrigin(resolvedTarget, result.newCommit);
            if (cmdOpts.profile && alias && packageName && gitUrl && lock) {
              (lock.profiles[cmdOpts.profile] ??= { plugins: {} }).plugins[alias] = {
                package: packageName, source: { type: 'git', url: gitUrl, commit: result.newCommit }
              };
              await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
            }
          }
        });

        if (cmdOpts.profile && pinnedCommit !== undefined && !isSameCommit(pinnedCommit, res.newCommit)) {
          ctx.writeErr(
            `The manifest pins commit ${pinnedCommit} for ${alias} in profile '${cmdOpts.profile}', so plan stays blocked until it matches the locked ${res.newCommit}: ` +
              `declare it with dshenv install git+${gitUrl}#${res.newCommit} --as ${alias} -p ${cmdOpts.profile}, or move the lock back with --ref ${pinnedCommit}\n`
          );
        }

        if (dryRun) {
          const lockedSource = cmdOpts.profile && alias ? lock?.profiles[cmdOpts.profile]?.plugins[alias]?.source : undefined;
          const lockMoves = Boolean(cmdOpts.profile) && !(lockedSource?.type === 'git' && isSameCommit(lockedSource.commit, res.newCommit));
          const pending = res.newCommit !== res.previousCommit || lockMoves;
          if (opts.json) {
            writeOut(JSON.stringify({ status: 'preview', target: resolvedTarget, profile: cmdOpts.profile, alias, ...res, pending }, null, 2) + '\n');
          } else if (pending) {
            writeOut(`Would update ${resolvedTarget} from ${res.previousCommit} to ${res.newCommit}${lockMoves ? ', and lock that commit' : ''}\n`);
          } else {
            writeOut(`${resolvedTarget} is already at ${res.newCommit}${cmdOpts.profile ? ', which the lock pins' : ''}\n`);
          }
          reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending, action: 'sync' });
          return;
        }
        if (opts.json) {
          writeOut(JSON.stringify({
            status: 'pulled',
            target: resolvedTarget,
            profile: cmdOpts.profile,
            alias,
            ...res
          }, null, 2) + '\n');
        } else {
          writeOut(`Updated ${resolvedTarget} from ${res.previousCommit} to ${res.newCommit}\n`);
        }
      };
      if (cmdOpts.profile) await withEnvironmentLock(paths, sync);
      else await sync();
    });
}
