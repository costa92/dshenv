import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomic } from '../io/atomic-file.js';
import { assertNotRemoteOwned } from '../remote/ownership.js';
import { ValidationError } from '../errors.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { isValidOverlayName, overlayFilePath, validateOverlayName, writeSelectionFile } from '../overlay/selection.js';
import { overlayBanner, resolveCliOverlay, resolveCliPaths, profileOption, PROFILE_FILTER_HELP, type CommandContext } from './context.js';
import { withEnvironmentLock } from '../io/lock.js';

const OVERLAY_SKELETON = `apiVersion: dshenv-overlay/v1
# Merged over envctl/manifest.yaml on this machine. For example:
# profiles:
#   web:
#     plugins:
#       agent-teams:
#         enabled: false
profiles: {}
`;

export function registerOverlayCommands(ctx: CommandContext): void {
  const { program, writeOut, writeErr } = ctx;
  const overlayCmd = program.command('overlay').description('Select and inspect per-machine manifest overlays');

  // These name their overlay as an argument, so a global --overlay or --no-overlay would be silently ignored.
  const refuseGlobalOverlay = (command: string, opts: { overlay?: string | false }) => {
    if (opts.overlay !== undefined) {
      throw new ValidationError(`--overlay and --no-overlay do not apply to overlay ${command}; name the overlay as its argument`);
    }
  };

  overlayCmd
    .command('use [name]')
    .description('Persist the overlay that later commands on this machine use')
    .option('--none', 'clear the persisted overlay for every later command (--no-overlay skips it for one command)')
    .action(async (name: string | undefined, cmdOpts: { none?: boolean }) => {
      const opts = program.opts();
      refuseGlobalOverlay('use', opts);
      const paths = resolveCliPaths(opts);
      if (Boolean(name) === Boolean(cmdOpts.none)) {
        throw new ValidationError('overlay use requires exactly one of <name> or --none');
      }
      // Under the lock, so an apply or sync in progress never sees the selection change halfway.
      await withEnvironmentLock(paths, async () => {
        if (name) {
          loadEffectiveManifest(paths, { name: validateOverlayName(name), via: 'file' });
        }
        await writeSelectionFile(paths, name ?? null);
      });
      if (process.env.DSHENV_OVERLAY && process.env.DSHENV_OVERLAY !== name) {
        writeErr(`DSHENV_OVERLAY=${process.env.DSHENV_OVERLAY} takes precedence over the saved overlay in this shell\n`);
      }
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'selected', overlay: name ? { name, via: 'file' } : null }, null, 2) + '\n');
      } else {
        writeOut(name ? `Using overlay '${name}'. Run dshenv plan to review its effect.\n` : 'Cleared the persisted overlay.\n');
      }
    });

  overlayCmd
    .command('list')
    .description('List overlays under envctl/overlays and mark the active one')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const names = fs.existsSync(paths.overlaysDir)
        ? fs.readdirSync(paths.overlaysDir).filter((file) => file.endsWith('.yaml')).map((file) => file.slice(0, -'.yaml'.length)).sort()
        : [];
      const active = resolveCliOverlay(opts, paths);
      const overlays: Array<{ name: string; active: boolean; missing?: boolean; invalid?: boolean }> = names.map((name) => ({
        name,
        active: name === active?.name,
        ...(isValidOverlayName(name) ? {} : { invalid: true })
      }));
      if (active && !names.includes(active.name)) {
        overlays.push({ name: active.name, active: true, missing: true });
      }
      if (opts.json) {
        writeOut(JSON.stringify({ active, overlays }, null, 2) + '\n');
        return;
      }
      if (overlays.length === 0) {
        writeOut('No overlays. Create one with: dshenv overlay create <name>\n');
        return;
      }
      for (const entry of overlays) {
        const missing = entry.missing ? ' missing' : '';
        const invalid = entry.invalid ? ' (invalid name)' : '';
        writeOut(entry.active && active ? `* ${entry.name} (${active.via})${missing}\n` : `  ${entry.name}${invalid}\n`);
      }
    });

  overlayCmd
    .command('create <name>')
    .description('Create an empty overlay under envctl/overlays to hold this machine\'s changes')
    .action(async (name: string) => {
      const opts = program.opts();
      refuseGlobalOverlay('create', opts);
      const paths = resolveCliPaths(opts);
      const file = overlayFilePath(paths, name);
      await withEnvironmentLock(paths, async () => {
        if (fs.existsSync(file)) {
          throw new ValidationError(`Overlay '${name}' already exists: ${file}`);
        }
        // On a case-insensitive file system 'Work' and 'work' would be one file.
        const existing = fs.existsSync(paths.overlaysDir) ? fs.readdirSync(paths.overlaysDir) : [];
        const sameFolded = existing.find((entry) => entry.toLowerCase() === path.basename(file).toLowerCase());
        if (sameFolded !== undefined) {
          throw new ValidationError(`Overlay '${sameFolded.slice(0, -'.yaml'.length)}' already exists and differs from '${name}' only in case`);
        }
        assertNotRemoteOwned(paths, file);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await writeAtomic(file, OVERLAY_SKELETON, 'create');
      });
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'created', overlay: name, file }, null, 2) + '\n');
      } else {
        writeOut(`Created overlay '${name}' at ${file}\nNext: dshenv overlay use ${name}, then write to it with --layer overlay.\n`);
      }
    });

  overlayCmd
    .command('show')
    .description('Show the merged manifest and where each plugin comes from')
    .option('-p, --profile <name>', PROFILE_FILTER_HELP, profileOption)
    .action(async (cmdOpts: { profile?: string }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const effective = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths));
      const profileNames = cmdOpts.profile ? [cmdOpts.profile] : Object.keys(effective.manifest.profiles).sort();
      if (cmdOpts.profile && !Object.hasOwn(effective.manifest.profiles, cmdOpts.profile)) {
        throw new ValidationError(`Profile '${cmdOpts.profile}' not found in the effective manifest`);
      }
      if (opts.json) {
        const pick = <T>(record: Record<string, T>) => Object.fromEntries(profileNames.map((name) => [name, record[name]]));
        writeOut(JSON.stringify({
          overlay: effective.overlay,
          manifest: { ...effective.manifest, profiles: pick(effective.manifest.profiles) },
          provenance: pick(effective.provenance)
        }, null, 2) + '\n');
        return;
      }
      if (effective.overlay) {
        writeErr(overlayBanner(effective.overlay));
      }
      for (const profileName of profileNames) {
        const plugins = effective.manifest.profiles[profileName].plugins;
        for (const alias of Object.keys(plugins).sort()) {
          const provenance = effective.provenance[profileName]?.[alias];
          const overrides = provenance?.overridden.length ? ` overrides=${provenance.overridden.join(',')}` : '';
          writeOut(`${profileName} ${alias} ${plugins[alias].package} origin=${provenance?.origin ?? 'base'}${overrides}\n`);
        }
      }
    });
}
