import * as fs from 'node:fs';
import * as path from 'node:path';
import { Option } from 'commander';
import type { ProfilePatch } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { didYouMean } from './suggest.js';
import { getAtPath, parseConfigValue } from '../config/config.js';
import { resolveDshCommand } from '../dsh/command.js';
import { dumpProfileConfig } from '../dsh/hmr.js';
import { loadEffectiveManifest, readOverlay } from '../overlay/effective.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { readProfilePatchFile } from '../apply/patches.js';
import { containsLocalPath, mergeProfilePatches, overrideKey, readProfilePatchState } from '../profile-patches/entries.js';
import {
  TOOL_CATEGORIES,
  declaredToolRow,
  listTools,
  locateTool,
  parseComposedProfile,
  toolPatch,
  type ToolCategory,
  type ToolChange,
  type ToolRow,
  type ToolTarget
} from '../tools/catalog.js';
import { resolveWrite, writeBase, writeOverlay } from './manifest-write.js';
import { supportedDshCommand } from './web.js';
import { profileNotCreatedError, resolveCliOverlay, resolveCliPaths, targetProfile, writeLayer, type CommandContext } from './context.js';

const CATEGORY_TITLES: Record<ToolCategory, string> = {
  terminal: 'Terminal',
  filesystem: 'Filesystem',
  network: 'Network',
  code: 'Code / LSP',
  orchestration: 'Orchestration',
  interaction: 'Interaction',
  extend: 'Sessions, skills and introspection',
  other: 'Other'
};

interface CliOpts {
  dshHome?: string;
  harnessSource?: string;
  overlay?: string | false;
  json?: boolean;
}

function declaredPatches(paths: EnvironmentPaths, selection: OverlaySelection | null, profile: string): ProfilePatch[] {
  if (!fs.existsSync(paths.manifestFile)) {
    return [];
  }
  return loadEffectiveManifest(paths, selection).manifest.profiles[profile]?.patches ?? [];
}

async function composedProfile(paths: EnvironmentPaths, opts: CliOpts, profile: string): Promise<ProfilePatch[]> {
  // dsh --dump-config creates a missing profile, which only reading tools must not do.
  if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
    throw profileNotCreatedError(paths, opts, profile);
  }
  const command = await supportedDshCommand(paths, opts);
  const dump = await dumpProfileConfig(profile, { command, dshHome: paths.home });
  if (!dump.ok) {
    throw new ValidationError(`Could not read profile '${profile}' from dsh --dump-config: ${dump.reason}`);
  }
  return parseComposedProfile(dump.yaml);
}

function stateText(tool: ToolRow): { symbol: string; note: string } {
  if (tool.state === 'on') return { symbol: '+', note: '' };
  if (tool.state === 'off') return { symbol: '-', note: 'off' };
  return { symbol: '~', note: `off when ${tool.state.offWhen}` };
}

// `onePreset`: the view of a single preset, where rows outside it are profile-wide.
function renderTools(header: string, tools: ToolRow[], onePreset: boolean): string {
  const lines = [header];
  const idWidth = Math.max(...tools.map((tool) => tool.id.length), 0);
  const nameWidth = Math.max(...tools.map((tool) => tool.name.length), 0);
  for (const category of TOOL_CATEGORIES) {
    const inCategory = tools.filter((tool) => tool.category === category);
    if (inCategory.length === 0) continue;
    lines.push(CATEGORY_TITLES[category]);
    for (const tool of inCategory) {
      const { symbol, note } = stateText(tool);
      const where = tool.location.kind === 'top'
        ? onePreset ? 'profile-wide' : ''
        : [onePreset ? '' : `preset ${tool.location.preset}`, tool.location.group ? `group ${tool.location.group}` : ''].filter(Boolean).join(', ');
      const notes = [note, where].filter(Boolean).join('; ');
      lines.push(`  ${symbol} ${tool.id.padEnd(idWidth)}  ${tool.name.padEnd(nameWidth)}${notes ? `  ${notes}` : ''}`.trimEnd());
    }
  }
  if (tools.length === 0) lines.push('  (no tools)');
  return `${lines.join('\n')}\n`;
}

function describeTarget(profile: string, target: ToolTarget): string {
  return target.location.kind === 'preset'
    ? `in preset '${target.location.preset}' of profile '${profile}'`
    : `in profile '${profile}'`;
}

// Only the rows tools list shows are tools; any other id (a DSH layer such as 'web', say) must not be switched from here.
function assertListedTool(tree: ProfilePatch[], profile: string, toolId: string): void {
  const ids = listTools(tree, { all: true }).map((row) => row.id);
  if (!ids.includes(toolId)) {
    throw new ValidationError(
      `'${toolId}' is not a tool in profile '${profile}'${didYouMean(toolId, ids)}; see dshenv tools list --all -p ${profile}`
    );
  }
}

function isTombstone(entry: object): boolean {
  return (entry as { remove?: unknown }).remove === true;
}

function upsertPatch(list: ProfilePatch[] | undefined, patch: ProfilePatch): ProfilePatch[] {
  const next = [...(list ?? [])];
  const index = next.findIndex((entry) => overrideKey(entry) === patch.id);
  if (index === -1) next.push(patch);
  else next[index] = patch;
  return next;
}

export function registerToolsCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;
  const tools = program.command('tools').description("List, switch and configure DSH's built-in tools in a profile");

  tools
    .command('list')
    .description("List a profile's tools by category, as an agent of the chosen preset gets them")
    .addOption(targetProfile())
    .option('--preset <name>', 'agent preset to show (default: the profile default)')
    .option('--all', 'every tool row: profile-wide and in each preset')
    .action(async (cmdOpts) => {
      if (cmdOpts.all && cmdOpts.preset !== undefined) {
        throw new ValidationError('--all lists every preset already; drop --preset, or drop --all to show one preset');
      }
      const opts: CliOpts = program.opts();
      const paths = resolveCliPaths(opts);
      const tree = await composedProfile(paths, opts, cmdOpts.profile);
      const rows = listTools(tree, { preset: cmdOpts.preset, all: Boolean(cmdOpts.all) });
      const shown = cmdOpts.all ? undefined : rows.find((row) => row.location.kind === 'preset')?.location;
      const presetName = shown?.kind === 'preset' ? shown.preset : undefined;
      if (opts.json) {
        const json = rows.map((row) => ({
          id: row.id,
          name: row.name,
          category: row.category,
          state: typeof row.state === 'string' ? row.state : 'conditional',
          ...(typeof row.state === 'string' ? {} : { offWhen: row.state.offWhen }),
          location: row.location
        }));
        writeOut(`${JSON.stringify({ profile: cmdOpts.profile, ...(presetName ? { preset: presetName } : {}), tools: json }, null, 2)}\n`);
        return;
      }
      const header = cmdOpts.all
        ? `Tools in profile '${cmdOpts.profile}', every location:`
        : presetName
          ? `Tools in profile '${cmdOpts.profile}', preset '${presetName}'${cmdOpts.preset ? '' : ' (default)'}:`
          : `Tools in profile '${cmdOpts.profile}':`;
      writeOut(renderTools(header, rows, presetName !== undefined));
    });

  async function change(
    toolId: string,
    cmdOpts: { profile: string; preset?: string; layer?: string },
    toolChange: ToolChange,
    verb: string,
    status: string
  ): Promise<void> {
    const opts: CliOpts = program.opts();
    const paths = resolveCliPaths(opts);
    const tree = await composedProfile(paths, opts, cmdOpts.profile);
    assertListedTool(tree, cmdOpts.profile, toolId);
    const target = locateTool(tree, toolId, cmdOpts.preset);
    const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
    const patchId = target.location.kind === 'preset' ? target.location.entry : String(target.row.id);
    // The overlay's entry replaces the base one with the same id, so a base write under it would change nothing.
    if (!overlay && selection && readOverlay(paths, selection.name).profiles?.[cmdOpts.profile]?.patches?.some((entry) => overrideKey(entry) === patchId)) {
      throw new ValidationError(`The active overlay '${selection.name}' declares '${patchId}', which overrides the base; use --layer overlay`);
    }
    const livePatched = overlay
      ? []
      : readProfilePatchState(await readProfilePatchFile(paths, cmdOpts.profile), cmdOpts.profile).block?.entries ?? [];
    // Built under the write lock from the layer written, so a concurrent edit of the same preset is kept and
    // a base write never takes in what the overlay declares. An overlay entry replaces the base one, so it starts from both.
    const patch = overlay
      ? await writeOverlay(paths, overlay, (doc, base) => {
          const profile = ((doc.profiles ??= {})[cmdOpts.profile] ??= {});
          const next = toolPatch(tree, mergeProfilePatches(base.profiles[cmdOpts.profile]?.patches ?? [], profile.patches ?? []), target, toolChange);
          profile.patches = upsertPatch(profile.patches, next);
          return next;
        })
      : await writeBase(paths, selection, (manifest) => {
          const profile = (manifest.profiles[cmdOpts.profile] ??= { plugins: {} });
          // A base entry starts from what DSH composes, which must hold nothing but DSH's own config: a new entry, or one
          // with no config of its own (a disable) getting its first key, takes it from there.
          const existing = profile.patches?.find((entry) => overrideKey(entry) === patchId);
          const seeded = !existing || (existing.config === undefined && (toolChange.kind === 'set' || toolChange.kind === 'unset'));
          const live = livePatched.find((entry) => overrideKey(entry) === patchId);
          if (seeded && live && (!existing || live.config !== undefined)) {
            throw new ValidationError(
              `What DSH composes in profile '${cmdOpts.profile}' holds a dshenv patch for '${patchId}' whose config the base manifest does not declare (an overlay applied, or an entry apply has not removed yet), so a base write would copy its values; use --layer overlay, or apply without it first`
            );
          }
          const next = toolPatch(tree, profile.patches ?? [], target, toolChange);
          if (seeded && containsLocalPath(next)) {
            throw new ValidationError(
              `The config DSH composes for '${patchId}' in profile '${cmdOpts.profile}' has machine-local paths, which do not belong in the shared base manifest; set it in an overlay with --layer overlay`
            );
          }
          profile.patches = upsertPatch(profile.patches, next);
          return next;
        });
    const location = target.location;
    const pinned = location.kind === 'preset'
      ? `\nPreset '${location.preset}' is now pinned in the manifest as patch '${location.entry}': DSH upgrades to this preset no longer apply until that patch is removed.`
      : '';
    if (opts.json) {
      writeOut(`${JSON.stringify({ status, profile: cmdOpts.profile, tool: toolId, location, patch, ...(overlay ? { layer: 'overlay', overlay: overlay.name } : {}) }, null, 2)}\n`);
    } else {
      writeOut(`${verb} tool '${toolId}' ${describeTarget(cmdOpts.profile, target)}${overlay ? ` (overlay '${overlay.name}')` : ''} in the manifest. Next: dshenv plan, then dshenv apply --yes.${pinned}\n`);
    }
  }

  for (const toggle of [
    { name: 'enable', verb: 'Enabled', kind: 'enable' as const, status: 'enabled' },
    { name: 'disable', verb: 'Disabled', kind: 'disable' as const, status: 'disabled' }
  ]) {
    tools
      .command(`${toggle.name} <tool>`)
      .description(`${toggle.verb.replace(/d$/, '')} a tool row by its id (see tools list)`)
      .addOption(targetProfile())
      .option('--preset <name>', 'agent preset holding the tool (default: the profile default)')
      .addOption(writeLayer())
      .action((tool: string, cmdOpts) => change(tool, cmdOpts, { kind: toggle.kind }, toggle.verb, toggle.status));
  }

  const showConfig = async (tool: string, dottedPath: string | undefined, cmdOpts: { profile: string; preset?: string }): Promise<void> => {
    const opts: CliOpts = program.opts();
    const paths = resolveCliPaths(opts);
    const tree = await composedProfile(paths, opts, cmdOpts.profile);
    assertListedTool(tree, cmdOpts.profile, tool);
    const target = locateTool(tree, tool, cmdOpts.preset);
    const config = declaredToolRow(tree, declaredPatches(paths, resolveCliOverlay(opts, paths), cmdOpts.profile), target).config ?? {};
    const shown = dottedPath === undefined ? config : getAtPath(config as Record<string, unknown>, dottedPath);
    if (dottedPath !== undefined && shown === undefined) {
      throw new ValidationError(
        `The config of tool '${tool}' in profile '${cmdOpts.profile}' has no '${dottedPath}'${didYouMean(dottedPath.split('.')[0], Object.keys(config))}`
      );
    }
    writeOut(`${JSON.stringify(shown ?? null, null, 2)}\n`);
  };
  const setConfig = (tool: string, dottedPath: string, value: string, cmdOpts: { profile: string; preset?: string; layer?: string }) =>
    change(tool, cmdOpts, { kind: 'set', path: dottedPath, value: parseConfigValue(value) }, `Set ${dottedPath} of`, 'set');
  const presetOption = () => new Option('--preset <name>', 'agent preset holding the tool (default: the profile default)');

  const configCmd = tools
    .command('config')
    .description("Show or change a tool's config (the patch restates the whole config)")
    .usage('[command]');
  // `tools config <tool> [dottedPath] [value]`, the form before get/set/unset, still works for old scripts.
  configCmd
    .command('by-position <tool> [dottedPath] [value]', { isDefault: true, hidden: true })
    .addOption(targetProfile())
    .addOption(presetOption())
    .addOption(writeLayer())
    .action((tool: string, dottedPath: string | undefined, value: string | undefined, cmdOpts) =>
      dottedPath !== undefined && value !== undefined ? setConfig(tool, dottedPath, value, cmdOpts) : showConfig(tool, dottedPath, cmdOpts)
    );
  configCmd
    .command('get <tool> [dottedPath]')
    .description("Show a tool's config, or one key of it")
    .addOption(targetProfile())
    .addOption(presetOption())
    .action((tool: string, dottedPath: string | undefined, cmdOpts) => showConfig(tool, dottedPath, cmdOpts));
  configCmd
    .command('set <tool> <dottedPath> <value>')
    .description('Set one key of a tool config in the manifest (the value is parsed as JSON, else taken as a string)')
    .addOption(targetProfile())
    .addOption(presetOption())
    .addOption(writeLayer())
    .action((tool: string, dottedPath: string, value: string, cmdOpts) => setConfig(tool, dottedPath, value, cmdOpts));
  configCmd
    .command('unset <tool> <dottedPath>')
    .description('Remove one key from a tool config in the manifest')
    .addOption(targetProfile())
    .addOption(presetOption())
    .addOption(writeLayer())
    .action((tool: string, dottedPath: string, cmdOpts) => change(tool, cmdOpts, { kind: 'unset', path: dottedPath }, `Removed ${dottedPath} of`, 'unset'));

  tools
    .command('reset <tool>')
    .description("Drop the manifest patch that changes a tool, so DSH's default applies again (a preset tool resets its whole preset)")
    .addOption(targetProfile())
    .option('--preset <name>', 'agent preset holding the tool (default: the profile default)')
    .addOption(writeLayer())
    .action(async (toolId: string, cmdOpts: { profile: string; preset?: string; layer?: string }) => {
      const opts: CliOpts = program.opts();
      const paths = resolveCliPaths(opts);
      const tree = await composedProfile(paths, opts, cmdOpts.profile);
      assertListedTool(tree, cmdOpts.profile, toolId);
      const target = locateTool(tree, toolId, cmdOpts.preset);
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
      const patchId = target.location.kind === 'preset' ? target.location.entry : String(target.row.id);
      // A tombstone only hides the base entry, so a base write under it is not lost.
      const overlayDeclares = (name: string) =>
        readOverlay(paths, name).profiles?.[cmdOpts.profile]?.patches?.some((entry) => overrideKey(entry) === patchId && !isTombstone(entry)) ?? false;
      if (!overlay && selection && overlayDeclares(selection.name)) {
        throw new ValidationError(`The active overlay '${selection.name}' declares '${patchId}', which overrides the base; use --layer overlay`);
      }
      const outcome = overlay
        ? await writeOverlay(paths, overlay, (doc, base) => {
            const entries = doc.profiles?.[cmdOpts.profile]?.patches ?? [];
            const mine = entries.find((entry) => overrideKey(entry) === patchId);
            // Already dropped from the effective manifest; removing the tombstone would bring the base patch back.
            if (mine && isTombstone(mine)) {
              return 'unchanged' as const;
            }
            // While the base declares it, the overlay can only drop it from the effective manifest.
            const baseDeclares = base.profiles[cmdOpts.profile]?.patches?.some((entry) => overrideKey(entry) === patchId) ?? false;
            if (!mine && !baseDeclares) {
              return 'unchanged' as const;
            }
            const profile = ((doc.profiles ??= {})[cmdOpts.profile] ??= {});
            profile.patches = [...entries.filter((entry) => overrideKey(entry) !== patchId), ...(baseDeclares ? [{ id: patchId, remove: true as const }] : [])];
            return 'removed' as const;
          })
        : await writeBase(paths, selection, (manifest) => {
            const profile = manifest.profiles[cmdOpts.profile];
            const kept = profile?.patches?.filter((entry) => overrideKey(entry) !== patchId);
            if (!profile || !kept || kept.length === profile.patches!.length) {
              return 'unchanged' as const;
            }
            profile.patches = kept.length > 0 ? kept : undefined;
            if (profile.patches === undefined) delete profile.patches;
            return 'removed' as const;
          });
      const location = target.location;
      if (opts.json) {
        writeOut(`${JSON.stringify({ status: outcome === 'removed' ? 'reset' : 'unchanged', profile: cmdOpts.profile, tool: toolId, patch: patchId, location, ...(overlay ? { layer: 'overlay', overlay: overlay.name } : {}) }, null, 2)}\n`);
        return;
      }
      if (outcome === 'unchanged') {
        writeOut(`Tool '${toolId}' ${describeTarget(cmdOpts.profile, target)} has no patch in the ${overlay ? `overlay '${overlay.name}'` : 'manifest'}; nothing to reset.\n`);
        return;
      }
      const scope = location.kind === 'preset'
        ? `Removed patch '${patchId}', which pinned preset '${location.preset}': every tool change in that preset is reset`
        : `Removed patch '${patchId}' for tool '${toolId}' in profile '${cmdOpts.profile}'`;
      writeOut(`${scope}${overlay ? ` (overlay '${overlay.name}')` : ''}. Next: dshenv plan, then dshenv apply --yes.\n`);
    });
}
