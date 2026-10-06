import * as fs from 'node:fs';
import { applyEnvironment } from '../apply/apply.js';
import { rollbackEnvironment } from '../rollback/rollback.js';
import { gcEnvironment } from '../gc/gc.js';
import { purgePlugin } from '../purge/purge.js';
import { markRestarted } from '../restart/restart.js';
import { renderPlan, renderRestartSummary, renderRuntimeReport } from '../output/render.js';
import { ValidationError } from '../errors.js';
import { isProfileOperation, planExitCode, planJson } from '../planner/plan.js';
import { loadEffectiveManifest, overlaySwitchWarning } from '../overlay/effective.js';
import { loadState } from '../manifest/files.js';
import { resolveCliPaths, resolveCliOverlay, overlayBanner, filterProfile, targetProfile, type CommandContext } from './context.js';
import { reportPreview } from './confirm.js';
import { verificationExitCode, verifyProfileRuntime, type ProfileVerification } from './runtime.js';

export function registerLifecycleCommands(ctx: CommandContext): void {
  const { program, writeOut, writeErr, setExitCode } = ctx;

  program
    .command('apply')
    .description('Make DSH match the manifest: its plugins, profile patches and skills')
    .addOption(filterProfile())
    .option('--dry-run', 'show the plan without changing anything; exit code 2 when it has changes')
    .option('-y, --yes', 'apply; without it apply only previews, like --dry-run')
    .option('--verify', 'then ask the running dsh web of each changed profile whether its plugins are loaded; exit code as verify')
    .option('--verify-timeout <seconds>', 'how long --verify waits for DSH to hot-reload a plugin', '30')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const allowUntested = Boolean(opts.allowUntestedDsh);
      const preview = Boolean(cmdOpts.dryRun) || !cmdOpts.yes;
      if (cmdOpts.verify && preview) {
        throw new ValidationError('--verify checks what apply --yes changed; add --yes, or run dshenv verify to check without applying');
      }
      if (!/^\d+(\.\d+)?$/.test(cmdOpts.verifyTimeout)) {
        throw new ValidationError(`Invalid --verify-timeout value: ${cmdOpts.verifyTimeout}`);
      }

      const selection = resolveCliOverlay(opts, paths);
      const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
      const warning = overlaySwitchWarning(state, selection);
      if (warning) {
        writeErr(`${warning}\n`);
      }

      const res = await applyEnvironment(paths, {
        dryRun: preview,
        allowUntested,
        harnessSource: opts.harnessSource,
        overlay: selection,
        profile: cmdOpts.profile
      });

      const verify: ProfileVerification[] = [];
      if (cmdOpts.verify && res.applied) {
        const { manifest } = loadEffectiveManifest(paths, selection);
        const profiles = [...new Set(res.plan.operations.filter(isProfileOperation).map((operation) => operation.profile))];
        for (const profile of profiles) {
          verify.push(
            await verifyProfileRuntime(paths, manifest, profile, Number(cmdOpts.verifyTimeout) * 1000, { severalProfiles: profiles.length > 1 })
          );
        }
      }

      if (opts.json) {
        const json = { ...res, plan: planJson(res.plan), ...(cmdOpts.verify && res.applied ? { verify } : {}) };
        writeOut(JSON.stringify(selection ? { ...json, overlay: selection } : json, null, 2) + '\n');
      } else {
        if (selection) {
          writeErr(overlayBanner(selection));
        }
        if (res.dryRun) {
          writeOut(renderPlan(res.plan, res.restart, '[DRY-RUN] Planned operations:'));
        } else if (res.applied) {
          writeOut(`Successfully applied changes (Operation ID: ${res.operationId})\n`);
          writeOut(renderPlan(res.plan, undefined, 'Applied operations:'));
          if (res.restart) {
            writeOut(renderRestartSummary(res.restart));
          }
          for (const item of verify) {
            if ('results' in item) {
              writeOut(renderRuntimeReport(item.profile, item.endpoint, item.results));
            } else {
              writeErr(`Not verified: ${'skipped' in item ? item.skipped : `profile ${item.profile}: ${item.error}`}\n`);
            }
          }
        } else {
          writeOut(`${res.message ?? 'No changes applied.'}\n`);
        }
      }
      if (verify.length > 0) {
        setExitCode(verificationExitCode(verify));
      }
      if (res.dryRun) {
        const code = planExitCode(res.plan);
        setExitCode(code);
        reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: code === 2, action: 'apply' });
      }
    });

  program
    .command('rollback [operationId]')
    .description('Restore the envctl files (manifest, lock, state, overlays, skills, remote.json) from a snapshot an apply, pull, remote add/sync or rollback took; apply then brings DSH in line')
    .option('--dry-run', 'show which snapshot would be restored; exit code 2')
    .option('-y, --yes', 'restore; without it rollback only previews, like --dry-run')
    .action(async (operationId: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const result = await rollbackEnvironment(paths, {
        operationId,
        dryRun: Boolean(cmdOpts.dryRun) || !cmdOpts.yes
      });
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`${result.message}\n`);
        if (result.rolledBack && !result.dryRun) {
          writeOut('DSH itself is unchanged. Next: dshenv plan, then dshenv apply --yes.\n');
        }
      }
      reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: result.dryRun, action: 'restore it' });
    });

  program
    .command('purge')
    .argument('<alias>', 'plugin alias or package name')
    .description("Move a plugin's managed config patch and envctl/sources clone into trash (gc empties it)")
    .addOption(targetProfile())
    .option('--dry-run', 'list resources that would be moved; exit code 2 when there are any')
    .option('-y, --yes', 'move them; without it purge only previews, like --dry-run')
    .action(async (plugin: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const result = await purgePlugin(paths, cmdOpts.profile, plugin, {
        dryRun: Boolean(cmdOpts.dryRun) || !cmdOpts.yes,
        manifest: fs.existsSync(paths.manifestFile)
          ? loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest
          : null
      });
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`${result.message}\n`);
        for (const item of result.moved) {
          writeOut(`  -> ${item}\n`);
        }
      }
      reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: result.dryRun && result.moved.length > 0, action: 'purge' });
    });

  program
    .command('gc')
    .description('Delete expired entries under envctl/trash, and expired snapshots beyond the newest 10 under envctl/backups')
    .option('--older-than <days>', 'delete trash and snapshots older than this many days', '7')
    .option('--dry-run', 'list the trash and snapshots that would be deleted; exit code 2 when there are any')
    .option('-y, --yes', 'delete it; without it gc only previews, like --dry-run')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      // Number() reads '' as 0 and '-1' as a negative age, either of which would delete all trash.
      const olderThanDays = Number(cmdOpts.olderThan);
      if (!/^\d+(\.\d+)?$/.test(cmdOpts.olderThan)) {
        throw new ValidationError(`Invalid --older-than value: ${cmdOpts.olderThan}`);
      }
      const result = await gcEnvironment(paths, {
        olderThanDays,
        dryRun: Boolean(cmdOpts.dryRun) || !cmdOpts.yes
      });
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`${result.message}\n`);
        for (const item of result.deleted) {
          writeOut(`  - ${item}\n`);
        }
      }
      reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: result.dryRun && result.deleted.length > 0, action: 'delete it' });
    });

  program
    .command('mark-restarted')
    .alias('restarted')
    .description('Record that DSH was restarted, clearing restart-required')
    .addOption(filterProfile())
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const result = await markRestarted(resolveCliPaths(opts), cmdOpts.profile);
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'restarted', cleared: result.cleared }, null, 2) + '\n');
      } else {
        writeOut(`Cleared restart-required for ${result.cleared.length} plugin(s).\n`);
      }
    });
}
