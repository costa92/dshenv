import { ValidationError } from '../errors.js';
import { pullProfilePatches, type PullResult } from '../import/pull.js';
import { reportPreview } from './confirm.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, PROFILE_FILTER_HELP, type CommandContext } from './context.js';

export function renderPullResult(result: PullResult): string {
  const warnings = (result.warnings ?? []).map((warning) => `! ${warning}`);
  if (result.changes.length === 0 && !result.skills && !result.plugins) {
    const head = warnings.length > 0 ? 'Nothing was pulled.' : 'Nothing to pull: every plugin, patch entry and skill in DSH matches the manifest.';
    return `${[head, ...warnings].join('\n')}\n`;
  }
  const lines = (result.plugins ?? []).map(
    (plugin) =>
      `[${plugin.profile}] from DSH: + plugin ${plugin.alias}${plugin.enabled ? '' : ' (disabled)'} ` +
      `(${plugin.layer === 'overlay' ? `overlay '${plugin.overlayName}'` : 'base'})`
  );
  lines.push(...result.changes.map((change) => {
    const entries = [
      ...change.added.map((id) => `+ ${id}`),
      ...change.changed.map((id) => `~ ${id}`),
      ...change.removed.map((id) => `- ${id}`)
    ];
    const layers = `base ${change.base}${change.overlayName ? `, overlay '${change.overlayName}' ${change.overlay}` : ''}`;
    const summary = entries.length > 0 ? entries.join(', ') : 'rewrites the block';
    return change.from === 'manifest'
      ? `[${change.profile}] keeps the manifest, dropping DSH's edits (${layers})`
      : `[${change.profile}] from DSH: ${summary} (${layers})`;
  }));
  if (result.skills) {
    const { added, changed, removed } = result.skills;
    lines.push(`[skills] from DSH: ${[...added.map((name) => `+ ${name}`), ...changed.map((name) => `~ ${name}`), ...removed.map((name) => `- ${name}`)].join(', ')}`);
  }
  lines.push(...warnings);
  if (result.overlayCreated) {
    lines.push(`Machine-local entries went into overlay '${result.overlayCreated}', now selected.`);
  }
  if (!result.dryRun) {
    lines.push('Next: dshenv plan');
  }
  return `${lines.join('\n')}\n`;
}

export function registerPullCommand(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  program
    .command('pull')
    .description('Take plugins, patch entries and loose skills changed in DSH into the manifest')
    .option('-p, --profile <name>', PROFILE_FILTER_HELP, profileOption)
    .option('--prefer <side>', 'when both DSH and the manifest changed since the last apply: dsh or manifest')
    .option('--dry-run', 'show what would be taken over without writing; exit code 2 when there is any')
    .option('-y, --yes', 'take it over; without it pull only previews, like --dry-run')
    .action(async (cmdOpts) => {
      if (cmdOpts.prefer !== undefined && cmdOpts.prefer !== 'dsh' && cmdOpts.prefer !== 'manifest') {
        throw new ValidationError(`Invalid --prefer '${cmdOpts.prefer}'; expected dsh or manifest`);
      }
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const result = await pullProfilePatches(paths, {
        profiles: cmdOpts.profile ? [cmdOpts.profile] : undefined,
        prefer: cmdOpts.prefer,
        dryRun: Boolean(cmdOpts.dryRun) || !cmdOpts.yes,
        selection: resolveCliOverlay(opts, paths),
        allowOverlayCreation: opts.overlay !== false
      });
      writeOut(opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderPullResult(result));
      const pending = result.changes.length > 0 || Boolean(result.skills) || Boolean(result.plugins);
      reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: result.dryRun && pending, action: 'pull' });
    });
}
