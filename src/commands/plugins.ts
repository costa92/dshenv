import * as fs from 'node:fs';
import * as path from 'node:path';
import { Option, type Command } from 'commander';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { assertConfigPath, getAtPath, parseConfigValue, readPluginConfig, unsetAtPath, upsertPluginPatch } from '../config/config.js';
import { loadLock, loadManifest, loadState, serializeLock } from '../manifest/files.js';
import { buildPlan } from '../planner/plan.js';
import { writeAtomic } from '../io/atomic-file.js';
import { readLocalSourceDigests } from '../source/local.js';
import { ValidationError } from '../errors.js';
import { ExactVersionRegex, GitCommitRegex, PackageNameRegex } from '../manifest/schema.js';
import type { EnvironmentManifest, PluginManifestEntry, PluginSource } from '../domain.js';
import { loadEffectiveManifest, readOverlay } from '../overlay/effective.js';
import { removeOverlayPlugin, setOverlayPatchValue, setOverlayPluginFields } from '../overlay/write.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { assertLockEntryNotRemoteOwned } from '../remote/ownership.js';
import { readRemoteConfig } from '../remote/schema.js';
import {
  resolveCliPaths,
  resolveCliOverlay,
  overlayBanner,
  aliasOption,
  assertKnownProfile,
  targetProfile,
  writeLayer,
  filterProfile,
  type CommandContext
} from './context.js';
import { didYouMean } from './suggest.js';
import { checkNpmVersion } from '../source/npm-registry.js';
import { resolveDshCommand } from '../dsh/command.js';
import { dumpProfileConfig } from '../dsh/hmr.js';
import { parseComposedProfile, pluginConfigKeys } from '../tools/catalog.js';
import { withEnvironmentLock } from '../io/lock.js';
import { renderPluginTable } from '../output/render.js';
import { resolveWrite, writeBase, writeOverlay } from './manifest-write.js';
import { readPackageJsonName } from '../source/local.js';

export interface InstallPluginRequest {
  spec: string;
  profile: string;
  alias?: string;
  packageName?: string;
  layer?: string;
  // A profile that is neither declared nor created is refused as a likely typo unless this is set.
  newProfile?: boolean;
  // False skips asking npm whether the version exists (--no-npm-check).
  npmCheck?: boolean;
}

// verified: npm has the version; unverified: npm answered but could not tell (a private package, say);
// unreachable: npm never answered; skipped: not an npm source, or the check was turned off.
export type NpmCheck = 'verified' | 'unverified' | 'unreachable' | 'skipped';

export interface InstallPluginResult {
  alias: string;
  packageName: string;
  source: PluginSource;
  overlay: OverlaySelection | null;
  // The source the alias had before, when the install only moved it (to another version, say).
  previousSource?: PluginSource;
  // The alias already declared this package from this source, so nothing changed.
  unchanged?: boolean;
  npmCheck: NpmCheck;
}

export interface PluginCommands {
  installPlugin: (opts: { dshHome?: string; overlay?: string | false }, request: InstallPluginRequest) => Promise<InstallPluginResult>;
}

export const NEXT_STEP = 'Next: dshenv plan, then dshenv apply --yes.';
const NPM_CHECK_SKIP_HINT = 'Skip this check with --no-npm-check or DSHENV_NPM_CHECK=off';

function describeSource(source: PluginSource): string {
  switch (source.type) {
    case 'npm':
      return source.version;
    case 'git':
      return source.commit ? `${source.url}#${source.commit}` : source.url;
    case 'local-link':
    case 'local-file':
      return source.path;
    default:
      return source.type;
  }
}

// Windows paths (C:\src, \\server\share, .\src) are local there; npm and git specs never parse as absolute paths.
export function isLocalPathSpec(spec: string, pathApi: path.PlatformPath = path): boolean {
  const relative = pathApi === path.win32 ? /^\.\.?[\\/]/ : /^\.\.?\//;
  return spec.startsWith('file:') || pathApi.isAbsolute(spec) || relative.test(spec);
}

export function registerPluginCommands(ctx: CommandContext): PluginCommands {
  const { program, writeOut } = ctx;

  function parsePluginSpec(spec: string, optsAlias?: string, optsPackage?: string): { alias: string; packageName: string; source: PluginSource } {
    if (spec.startsWith('git+') || spec.startsWith('http://') || spec.startsWith('https://') || spec.startsWith('git@') || spec.endsWith('.git')) {
      const cleanUrl = spec.startsWith('git+') ? spec.slice(4) : spec;
      const urlParts = cleanUrl.split('#');
      const repoUrl = urlParts[0];
      const commitOrRef = urlParts[1] || undefined;
      const baseName = path.basename(repoUrl, '.git');
      const alias = optsAlias || baseName.replace(/^(dsh-plugin-|dsh-)/, '');
      return {
        alias,
        packageName: optsPackage ?? baseName,
        source: {
          type: 'git',
          url: repoUrl,
          // #main or #v1.2.0 names a ref, not a commit; source clone --profile then locks the commit it resolves to.
          ...(commitOrRef === undefined ? {} : GitCommitRegex.test(commitOrRef) ? { commit: commitOrRef } : { ref: commitOrRef })
        }
      };
    }

    if (isLocalPathSpec(spec)) {
      const localPath = spec.startsWith('file:') ? spec.slice(5) : spec;
      const resolved = path.resolve(localPath);
      const baseName = path.basename(resolved);
      const alias = optsAlias || baseName.replace(/^(dsh-plugin-|dsh-)/, '');
      return {
        alias,
        packageName: optsPackage ?? readPackageJsonName(resolved) ?? baseName,
        source: {
          type: 'local-link',
          path: resolved
        }
      };
    }

    if (optsPackage !== undefined) {
      throw new ValidationError('--package only applies to git and local sources');
    }

    // A bundle that ships with DSH has no dependency: apply only selects it in the profile's bundle list.
    if (spec.startsWith('in-box:')) {
      const packageName = spec.slice('in-box:'.length);
      if (!PackageNameRegex.test(packageName)) {
        throw new ValidationError(`in-box takes a package name with no version: in-box:<package>, got '${packageName}'`);
      }
      const simpleName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
      return { alias: optsAlias || simpleName.replace(/^(dsh-plugin-|dsh-)/, ''), packageName, source: { type: 'in-box' } };
    }

    let packageName = spec;
    let version: string | undefined;

    if (spec.startsWith('@')) {
      const atIdx = spec.indexOf('@', 1);
      if (atIdx !== -1) {
        packageName = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      }
    } else {
      const atIdx = spec.indexOf('@');
      if (atIdx !== -1) {
        packageName = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      }
    }

    // npm reads a leading '-' as an option; the regex alone lets one through.
    if (!PackageNameRegex.test(packageName) || packageName.startsWith('-')) {
      throw new ValidationError(`Invalid npm package name: ${packageName}`);
    }
    if (!version || !ExactVersionRegex.test(version)) {
      throw new ValidationError(`npm plugin needs an exact version: ${packageName}@<x.y.z>`);
    }

    const simpleName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
    const alias = optsAlias || simpleName.replace(/^(dsh-plugin-|dsh-)/, '');

    return {
      alias,
      packageName,
      source: {
        type: 'npm',
        version
      }
    };
  }

  function requirePlugin(manifest: EnvironmentManifest, profile: string, alias: string): PluginManifestEntry {
    const plugin = manifest.profiles[profile]?.plugins[alias];
    if (!plugin) {
      throw new ValidationError(`Plugin '${alias}' not found in profile '${profile}'`);
    }
    return plugin;
  }

  function effectivePlugin(paths: EnvironmentPaths, overlay: OverlaySelection, profile: string, alias: string): PluginManifestEntry {
    return requirePlugin(loadEffectiveManifest(paths, overlay).manifest, profile, alias);
  }

  // The entry the write changes: a base write must not see what the overlay removes or overrides.
  function layerPlugin(
    paths: EnvironmentPaths,
    selection: OverlaySelection | null,
    overlay: OverlaySelection | null,
    profile: string,
    alias: string
  ): PluginManifestEntry {
    const manifest = overlay ? loadEffectiveManifest(paths, selection).manifest : loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
    return requirePlugin(manifest, profile, alias);
  }

  // The alias a command names, also by its package name. A base write (`write` without an overlay) also needs the
  // alias in the base manifest, not only in the active overlay.
  function resolveAlias(
    paths: EnvironmentPaths,
    selection: OverlaySelection | null,
    profile: string,
    name: string,
    write?: { overlay: OverlaySelection | null }
  ): string {
    const effective = loadEffectiveManifest(paths, selection).manifest;
    // A base write names a base entry, which the overlay may have removed from the effective manifest.
    const baseWrite = Boolean(write && !write.overlay && selection && fs.existsSync(paths.manifestFile));
    const base = baseWrite ? loadManifest(fs.readFileSync(paths.manifestFile, 'utf8')) : null;
    if (base && !base.profiles[profile]?.plugins[name] && effective.profiles[profile]?.plugins[name]) {
      throw new ValidationError(`Plugin '${name}' is declared in overlay '${selection!.name}', not in the base manifest; use --layer overlay`);
    }
    const manifest = base?.profiles[profile] ? base : effective;
    const declaredProfiles = Object.keys(manifest.profiles).sort();
    if (!manifest.profiles[profile]) {
      throw new ValidationError(
        `Profile '${profile}' is not declared in the manifest${didYouMean(profile, declaredProfiles)}${declaredProfiles.length > 0 ? ` (declared: ${declaredProfiles.join(', ')})` : ''}`
      );
    }
    const plugins = manifest.profiles[profile].plugins;
    const byPackage = Object.entries(plugins).filter(([, plugin]) => plugin.package === name).map(([alias]) => alias);
    const alias = name in plugins ? name : byPackage.length === 1 ? byPackage[0] : undefined;
    if (alias === undefined) {
      const aliases = Object.keys(plugins).sort();
      // A close alias is the better hint; package names only when no alias is close.
      const hint = didYouMean(name, aliases) || didYouMean(name, Object.values(plugins).map((plugin) => plugin.package));
      throw new ValidationError(`Plugin '${name}' not found in profile '${profile}'${hint}${aliases.length > 0 ? ` (aliases: ${aliases.join(', ')})` : ''}`);
    }
    if (base && !base.profiles[profile]?.plugins[alias]) {
      throw new ValidationError(`Plugin '${alias}' is declared in overlay '${selection!.name}', not in the base manifest; use --layer overlay`);
    }
    return alias;
  }

  // These commands only change the manifest; the text says so and names the step that changes DSH.
  function reportWrite(
    opts: { json?: boolean },
    overlay: OverlaySelection | null,
    status: string,
    fields: Record<string, unknown>,
    text: string,
    unchanged = false
  ): void {
    if (opts.json) {
      writeOut(JSON.stringify({ status, ...(overlay ? { layer: 'overlay', overlay: overlay.name } : {}), ...fields, ...(unchanged ? { unchanged: true } : {}) }, null, 2) + '\n');
    } else {
      const where = overlay ? `overlay '${overlay.name}'` : 'manifest';
      writeOut(unchanged ? `${text} in the ${where}; nothing changed.\n` : `${text} in the ${where}. ${NEXT_STEP}\n`);
    }
  }

  async function pinLockVersion(paths: EnvironmentPaths, profile: string, alias: string, version: string): Promise<void> {
    await withEnvironmentLock(paths, async () => {
      if (!fs.existsSync(paths.lockFile)) {
        return;
      }
      const lock = loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
      const lockPlugin = lock.profiles[profile]?.plugins[alias];
      if (lockPlugin?.source.type === 'npm') {
        assertLockEntryNotRemoteOwned(paths, profile, alias);
        lockPlugin.source = { ...lockPlugin.source, resolvedVersion: version };
        await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
      }
    });
  }

  // Replacing the entry would drop the other package's patches and enabled state without a word.
  function aliasTaken(alias: string, current: string, profile: string, next: string): ValidationError {
    return new ValidationError(
      `Alias '${alias}' is '${current}' in profile '${profile}'; add '${next}' under another alias with --as <alias>, or remove '${alias}' first`
    );
  }

  function lockPinsNpm(paths: EnvironmentPaths, profile: string, alias: string): boolean {
    if (!fs.existsSync(paths.lockFile)) {
      return false;
    }
    return loadLock(fs.readFileSync(paths.lockFile, 'utf8')).profiles[profile]?.plugins[alias]?.source.type === 'npm';
  }

  async function installPlugin(
    opts: { dshHome?: string; overlay?: string | false; json?: boolean },
    request: InstallPluginRequest
  ): Promise<InstallPluginResult> {
    const paths = resolveCliPaths(opts);
    const { profile } = request;
    const { selection, overlay } = resolveWrite(opts, paths, request.layer);
    assertKnownProfile(paths, opts, profile, request.newProfile);
    const npmCheck = await checkNpmSpec(opts, parsePluginSpec(request.spec, request.alias, request.packageName), request.npmCheck);

    let previousSource: PluginSource | undefined;
    const parsed = overlay
      ? await writeOverlay(paths, overlay, (doc, base) => {
          const next = parsePluginSpec(request.spec, request.alias, request.packageName);
          const baseEntry = base.profiles[profile]?.plugins[next.alias];
          if (baseEntry && baseEntry.package !== next.packageName) {
            throw new ValidationError(
              `Alias '${next.alias}' is '${baseEntry.package}' in the base manifest; an overlay cannot change its package`
            );
          }
          const overlayEntry = doc.profiles?.[profile]?.plugins?.[next.alias];
          if (overlayEntry && !overlayEntry.remove && overlayEntry.package !== undefined && overlayEntry.package !== next.packageName) {
            throw aliasTaken(next.alias, overlayEntry.package, profile, next.packageName);
          }
          // Reinstalling a plugin the effective manifest already has only moves its source, as in the base.
          // An overlay entry without a package only adjusts a base plugin, so with none in the base nothing is declared yet.
          const exists = baseEntry ? !overlayEntry?.remove : overlayEntry?.package !== undefined && !overlayEntry.remove;
          if (exists) {
            previousSource = overlayEntry?.source ?? baseEntry?.source;
          }
          setOverlayPluginFields(doc, profile, next.alias, exists
            ? { source: next.source }
            : baseEntry
              ? { enabled: true, source: next.source }
              : { package: next.packageName, enabled: true, source: next.source });
          return next;
        })
      : await writeBase(paths, selection, (manifest) => {
          if (!manifest.profiles[profile]) {
            manifest.profiles[profile] = { plugins: {} };
          }
          const next = parsePluginSpec(request.spec, request.alias, request.packageName);
          const current = manifest.profiles[profile].plugins[next.alias];
          if (current && current.package !== next.packageName) {
            throw aliasTaken(next.alias, current.package, profile, next.packageName);
          }
          // Reinstalling the same package only moves its source; patches and the enabled state are kept.
          if (current) {
            previousSource = current.source;
          }
          manifest.profiles[profile].plugins[next.alias] = current
            ? { ...current, source: next.source }
            : { package: next.packageName, enabled: true, source: next.source };
          return next;
        });
    const moved = previousSource !== undefined && JSON.stringify(previousSource) !== JSON.stringify(parsed.source);
    return { ...parsed, overlay, npmCheck, ...(moved ? { previousSource } : {}), ...(previousSource !== undefined && !moved ? { unchanged: true } : {}) };
  }

  // A version npm does not have fails only at apply, minutes later. Only a version missing from a package npm has is
  // refused: a package npm cannot see may be private, and offline nothing can be told, so those go ahead with a warning.
  async function checkNpmSpec(
    opts: { json?: boolean },
    parsed: { packageName: string; source: PluginSource },
    enabled = true
  ): Promise<NpmCheck> {
    if (parsed.source.type !== 'npm' || !enabled || process.env.DSHENV_NPM_CHECK === 'off') {
      return 'skipped';
    }
    const { packageName } = parsed;
    const { version } = parsed.source;
    const check = await checkNpmVersion(packageName, version);
    if (check.status === 'missing') {
      throw new ValidationError(`npm has no version ${version} of ${packageName}${check.latest ? `; the latest is ${check.latest}` : ''}`);
    }
    if (check.status === 'exists') {
      return 'verified';
    }
    if (!opts.json) {
      const what = check.reason === 'npm cannot see the package'
        ? `npm cannot see ${packageName} (a private package needs npm credentials)`
        : `Could not check ${packageName}@${version} on npm (${check.reason})`;
      ctx.writeErr(`${what}; apply fails if it does not exist. ${NPM_CHECK_SKIP_HINT}\n`);
    }
    return check.reachable ? 'unverified' : 'unreachable';
  }

  // Each plugin command is registered twice: at the top level (list and config hidden there) and under plugins.
  const pluginsCmd = program.command('plugins').description('Add, change, list and configure plugins in the manifest');
  for (const parent of [program, pluginsCmd]) {
    parent
      .command('install <spec>')
      .description('Add a plugin to the manifest for a profile (apply installs it)')
      .addOption(targetProfile())
      .option('--as <alias>', 'custom alias name for the plugin', aliasOption)
      .option('--package <name>', 'package name for a git or local source; defaults to its package.json name')
      .addOption(writeLayer())
      .option('--new-profile', 'allow a profile that is neither declared nor created yet (guards against typos)')
      .option('--no-npm-check', 'do not ask npm whether the package version exists (also: DSHENV_NPM_CHECK=off)')
      .action(async (spec: string, cmdOpts) => {
        const opts = program.opts();
        const result = await installPlugin(opts, {
          spec,
          profile: cmdOpts.profile,
          alias: cmdOpts.as,
          packageName: cmdOpts.package,
          layer: cmdOpts.layer,
          newProfile: cmdOpts.newProfile,
          npmCheck: cmdOpts.npmCheck
        });
        reportWrite(
          opts,
          result.overlay,
          'installed',
          { profile: cmdOpts.profile, alias: result.alias, package: result.packageName, source: result.source, npmCheck: result.npmCheck },
          result.unchanged
            ? `${result.packageName} (${result.alias}) is already declared at ${describeSource(result.source)} in profile '${cmdOpts.profile}'`
            : result.previousSource
              ? `Changed ${result.alias} in profile '${cmdOpts.profile}' from ${describeSource(result.previousSource)} to ${describeSource(result.source)}`
              : `Added ${result.packageName} (${result.alias}) to profile '${cmdOpts.profile}'`,
          result.unchanged
        );
      });
  }

  for (const parent of [program, pluginsCmd]) {
    parent
      .command('update <alias>')
      .description('Update the declared npm version for a plugin in the manifest')
      .addOption(targetProfile())
      .requiredOption('--to <version>', '(required) exact version to declare; does not float to latest')
      .addOption(writeLayer())
      .option('--no-npm-check', 'do not ask npm whether the version exists (also: DSHENV_NPM_CHECK=off)')
      .action(async (name: string, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        if (!ExactVersionRegex.test(cmdOpts.to)) {
          throw new ValidationError('--to must be an exact version such as 1.2.3');
        }
        const profile: string = cmdOpts.profile;
        const version: string = cmdOpts.to;
        const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
        const alias = resolveAlias(paths, selection, profile, name, { overlay });
        // The lock pin runs after the manifest write, so a team-pinned entry must be refused before anything is written.
        // Skip the lock read entirely when unsubscribed, so a corrupt lock.json still fails where it always did.
        if (readRemoteConfig(paths) && lockPinsNpm(paths, profile, alias)) {
          assertLockEntryNotRemoteOwned(paths, profile, alias);
        }
        const npmOnly = (type: string) => {
          const instead = type === 'git'
            ? `; move a Git plugin with dshenv source sync -p ${profile} --as ${alias} [--ref <ref>]`
            : type === 'local-link' || type === 'local-file'
              ? '; plan and apply pick up changes in a local source by themselves'
              : '';
          return new ValidationError(`update --to currently supports npm sources only (got ${type})${instead}`);
        };
        const declared = layerPlugin(paths, selection, overlay, profile, alias);
        if (declared.source.type !== 'npm') {
          throw npmOnly(declared.source.type);
        }
        const npmCheck = await checkNpmSpec(opts, { packageName: declared.package, source: { ...declared.source, version } }, cmdOpts.npmCheck);

        if (overlay) {
          await writeOverlay(paths, overlay, (doc) => {
            const plugin = effectivePlugin(paths, overlay, profile, alias);
            if (plugin.source.type !== 'npm') {
              throw npmOnly(plugin.source.type);
            }
            setOverlayPluginFields(doc, profile, alias, { source: { ...plugin.source, version } });
          });
        } else {
          await writeBase(paths, selection, (manifest) => {
            const plugin = requirePlugin(manifest, profile, alias);
            if (plugin.source.type !== 'npm') {
              throw npmOnly(plugin.source.type);
            }
            plugin.source = { ...plugin.source, version };
          });
        }
        await pinLockVersion(paths, profile, alias, version);
        reportWrite(opts, overlay, 'updated', { profile, alias, version, npmCheck }, `Set ${alias} in profile '${profile}' to ${version}`);
      });
  }

  for (const parent of [program, pluginsCmd]) {
    parent
      .command('list', { hidden: parent === program })
      .description('List declared and unmanaged plugins')
      .addOption(filterProfile())
      .action(async (cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        const selection = resolveCliOverlay(opts, paths);
        const { manifest, provenance } = loadEffectiveManifest(paths, selection);
        const lock = fs.existsSync(paths.lockFile) ? loadLock(fs.readFileSync(paths.lockFile, 'utf8')) : null;
        const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
        const inventory = await readEnvironmentInventory(paths);
        const plan = buildPlan(manifest, lock, inventory, state, await readLocalSourceDigests(manifest));
        const rows: Array<Record<string, unknown>> = [];
        const profiles = cmdOpts.profile ? [cmdOpts.profile] : Object.keys(manifest.profiles);
        for (const profileName of profiles) {
          const declared = manifest.profiles[profileName]?.plugins ?? {};
          for (const [alias, plugin] of Object.entries(declared)) {
            const installed = inventory.profiles[profileName]?.plugins[plugin.package];
            rows.push({
              profile: profileName,
              alias,
              package: plugin.package,
              enabled: plugin.enabled ?? true,
              source: plugin.source.type,
              version: plugin.source.type === 'npm' ? plugin.source.version : undefined,
              installed: Boolean(installed?.installed),
              actualVersion: installed?.version,
              origin: provenance[profileName]?.[alias]?.origin ?? null
            });
          }
        }
        for (const unmanaged of plan.unmanaged) {
          if (cmdOpts.profile && unmanaged.profile !== cmdOpts.profile) {
            continue;
          }
          rows.push({
            profile: unmanaged.profile,
            alias: null,
            package: unmanaged.package,
            enabled: inventory.profiles[unmanaged.profile]?.plugins[unmanaged.package]?.enabled,
            source: 'unmanaged',
            installed: true,
            origin: null
          });
        }
        if (opts.json) {
          writeOut(JSON.stringify(selection ? { plugins: rows, overlay: selection } : { plugins: rows }, null, 2) + '\n');
        } else {
          if (selection) {
            ctx.writeErr(overlayBanner(selection));
          }
          writeOut(renderPluginTable(rows, Boolean(selection)));
        }
      });
  }

  // DSH composes only the keys that have a default, so a key it does not show may still be real: warn, don't refuse.
  async function warnUnknownConfigKey(paths: EnvironmentPaths, opts: { harnessSource?: string; overlay?: string | false }, profile: string, packageName: string, dottedPath: string): Promise<void> {
    // dsh --dump-config creates a missing profile, which a manifest write must not do.
    if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
      return;
    }
    const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
    const command = resolveDshCommand({ cliHarnessSource: opts.harnessSource, manifestHarnessSource: manifest.environment?.harness?.sourceDir });
    if (!command) {
      return;
    }
    const dump = await dumpProfileConfig(profile, { command, dshHome: paths.home });
    if (!dump.ok) {
      return;
    }
    let keys: string[];
    try {
      keys = pluginConfigKeys(parseComposedProfile(dump.yaml), packageName);
    } catch {
      return;
    }
    const head = dottedPath.split('.')[0];
    if (keys.length > 0 && !keys.includes(head)) {
      const hint = didYouMean(head, keys);
      ctx.writeErr(`'${head}' is not among the keys DSH composes for ${packageName} (${keys.join(', ')})${hint ? `${hint} ` : '. '}Set it anyway; pass --force to skip this check\n`);
    }
  }

  // Takes the key out of whichever declared patch has it; a patch left with nothing to set goes too.
  function unsetFromPatches<T extends { id: string; config?: Record<string, unknown> }>(
    patches: T[] | undefined,
    dottedPath: string
  ): T[] | undefined | false {
    const index = (patches ?? []).findIndex((patch) => patch.config && unsetAtPath(patch.config, dottedPath));
    if (index === -1) {
      return false;
    }
    const setsSomething = (patch: T) =>
      Object.keys(patch.config ?? {}).length > 0 || Object.keys(patch).some((key) => key !== 'id' && key !== 'config');
    const rest = patches!.filter((patch, i) => i !== index || setsSomething(patch));
    return rest.length > 0 ? rest : undefined;
  }

  for (const parent of [program, pluginsCmd]) {
    const configCmd = parent.command('config', { hidden: parent === program }).description('Read or update declared plugin configuration');
    configCmd
      .command('get <alias> [dottedPath]')
      .description("Show a plugin's config (live if applied, else as declared), or one key of it")
      .addOption(targetProfile())
      // Superseded by the positional dottedPath, the spelling config set and tools config use.
      .addOption(new Option('--path <dottedPath>').hideHelp())
      .action(async (name: string, dottedPath: string | undefined, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        if (dottedPath !== undefined && cmdOpts.path !== undefined) {
          throw new ValidationError('Give the config path once: as the argument or with --path, not both');
        }
        const selection = resolveCliOverlay(opts, paths);
        const alias = resolveAlias(paths, selection, cmdOpts.profile, name);
        const manifest = loadEffectiveManifest(paths, selection).manifest;
        const config = await readPluginConfig(paths, manifest, cmdOpts.profile, alias);
        const field: string | undefined = dottedPath ?? cmdOpts.path;
        if (field !== undefined) {
          assertConfigPath(field);
        }
        const value = field !== undefined ? getAtPath(config.config, field) : config;
        if (value === undefined) {
          throw new ValidationError(
            `The config of '${alias}' in profile '${cmdOpts.profile}' has no '${field}'${didYouMean(field!.split('.')[0], Object.keys(config.config))}`
          );
        }
        writeOut(`${JSON.stringify(value, null, 2)}\n`);
      });
    configCmd
      .command('validate <alias>')
      .description("Check that a plugin's live config patch still matches what dshenv wrote")
      .addOption(targetProfile())
      .action(async (name: string, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        const selection = resolveCliOverlay(opts, paths);
        const alias = resolveAlias(paths, selection, cmdOpts.profile, name);
        const manifest = loadEffectiveManifest(paths, selection).manifest;
        const config = await readPluginConfig(paths, manifest, cmdOpts.profile, alias);
        const ok = config.source === 'manifest' || config.digestValid === true;
        if (opts.json) {
          writeOut(JSON.stringify({ alias, profile: cmdOpts.profile, valid: ok, source: config.source, digest: config.digest }, null, 2) + '\n');
        } else {
          writeOut(`${ok ? 'valid' : 'invalid'} (${config.source})\n`);
        }
        if (!ok) {
          throw new ValidationError(`Config digest mismatch for ${alias} in ${cmdOpts.profile}`);
        }
      });
    configCmd
      .command('set <alias> <dottedPath> <value>')
      .description('Set one key of a plugin config patch in the manifest (the value is parsed as JSON, else taken as a string)')
      .addOption(targetProfile())
      .addOption(writeLayer())
      .option('--force', "skip the warning about a key DSH does not compose for this plugin")
      .action(async (name: string, dottedPath: string, value: string, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        assertConfigPath(dottedPath);
        const profile: string = cmdOpts.profile;
        const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
        const alias = resolveAlias(paths, selection, profile, name, { overlay });
        if (!cmdOpts.force) {
          const plugin = layerPlugin(paths, selection, overlay, profile, alias);
          await warnUnknownConfigKey(paths, opts, profile, plugin.package, dottedPath);
        }

        const patch = overlay
          ? await writeOverlay(paths, overlay, (doc) => {
              const plugin = effectivePlugin(paths, overlay, profile, alias);
              return setOverlayPatchValue(doc, profile, alias, plugin.patches?.[0]?.id ?? alias, dottedPath, parseConfigValue(value));
            })
          : await writeBase(paths, selection, (manifest) =>
              upsertPluginPatch(manifest, profile, alias, dottedPath, parseConfigValue(value))
            );

        reportWrite(opts, overlay, 'set', { profile, alias, path: dottedPath, patch }, `Set ${alias} config ${dottedPath} in profile '${profile}'`);
      });
    configCmd
      .command('unset <alias> <dottedPath>')
      .description('Remove one key from a plugin config patch in the manifest')
      .addOption(targetProfile())
      .addOption(writeLayer())
      .action(async (name: string, dottedPath: string, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        assertConfigPath(dottedPath);
        const profile: string = cmdOpts.profile;
        const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
        const alias = resolveAlias(paths, selection, profile, name, { overlay });
        const missing = (where: string) => new ValidationError(`The config of '${alias}' in ${where} has no '${dottedPath}'`);

        if (overlay) {
          await writeOverlay(paths, overlay, (doc, base) => {
            const entry = doc.profiles?.[profile]?.plugins?.[alias];
            const remaining = entry && !entry.remove ? unsetFromPatches(entry.patches, dottedPath) : false;
            if (remaining !== false) {
              if (remaining) entry!.patches = remaining;
              else delete entry!.patches;
            } else {
              // Overlay patches merge into the base ones, so a key the base sets cannot be taken out from the overlay.
              if (base.profiles[profile]?.plugins[alias]?.patches?.some((patch) => getAtPath(patch.config, dottedPath) !== undefined)) {
                throw new ValidationError(`'${dottedPath}' of '${alias}' is set in the base manifest, which an overlay cannot remove; use --layer base`);
              }
              throw missing(`overlay '${overlay.name}'`);
            }
          });
        } else {
          await writeBase(paths, selection, (manifest) => {
            const plugin = requirePlugin(manifest, profile, alias);
            const remaining = unsetFromPatches(plugin.patches, dottedPath);
            if (remaining === false) {
              throw missing(`profile '${profile}'`);
            }
            if (remaining) plugin.patches = remaining;
            else delete plugin.patches;
          });
        }
        reportWrite(opts, overlay, 'unset', { profile, alias, path: dottedPath }, `Removed ${alias} config ${dottedPath} in profile '${profile}'`);
      });
  }

  for (const parent of [program, pluginsCmd]) {
    for (const toggle of [
      { name: 'enable', description: 'Enable a plugin in the manifest (apply enables it in DSH)', enabled: true, status: 'enabled', verb: 'Enabled' },
      { name: 'disable', description: 'Disable a plugin in the manifest (apply disables it in DSH)', enabled: false, status: 'disabled', verb: 'Disabled' }
    ]) {
      parent
        .command(`${toggle.name} <alias>`)
        .description(toggle.description)
        .addOption(targetProfile())
        .addOption(writeLayer())
        .action(async (name: string, cmdOpts) => {
          const opts = program.opts();
          const paths = resolveCliPaths(opts);
          const profile: string = cmdOpts.profile;
          const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
          const alias = resolveAlias(paths, selection, profile, name, { overlay });

          let unchanged = false;
          if (overlay) {
            await writeOverlay(paths, overlay, (doc) => {
              unchanged = (effectivePlugin(paths, overlay, profile, alias).enabled ?? true) === toggle.enabled;
              if (!unchanged) setOverlayPluginFields(doc, profile, alias, { enabled: toggle.enabled });
            });
          } else {
            await writeBase(paths, selection, (manifest) => {
              const plugin = requirePlugin(manifest, profile, alias);
              unchanged = (plugin.enabled ?? true) === toggle.enabled;
              if (!unchanged) plugin.enabled = toggle.enabled;
            });
          }
          reportWrite(
            opts,
            overlay,
            toggle.status,
            { profile, alias },
            unchanged ? `Plugin '${alias}' in profile '${profile}' is already ${toggle.status}` : `${toggle.verb} plugin '${alias}' in profile '${profile}'`,
            unchanged
          );
          // The overlay's value wins on this machine, so the base write alone changes nothing here.
          const overridden = !overlay && selection ? readOverlay(paths, selection.name).profiles?.[profile]?.plugins?.[alias]?.enabled : undefined;
          if (overridden !== undefined && overridden !== toggle.enabled && !opts.json) {
            ctx.writeErr(
              `Overlay '${selection!.name}' sets enabled: ${overridden} for ${alias} in profile '${profile}', so it stays ${overridden ? 'enabled' : 'disabled'} on this machine; use --layer overlay to change it here\n`
            );
          }
        });
    }
  }

  for (const parent of [program, pluginsCmd]) {
    parent
      .command('remove <alias>')
      .alias('uninstall')
      .description('Remove a plugin from the manifest (apply removes it from DSH; purge clears the config patch and clone it leaves)')
      .addOption(targetProfile())
      // Removing only edits the manifest (apply does the rest), so there is nothing to confirm; kept for old scripts.
      .addOption(new Option('-y, --yes').hideHelp())
      .addOption(writeLayer())
      .action(async (name: string, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        const profile: string = cmdOpts.profile;
        const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
        const alias = resolveAlias(paths, selection, profile, name, { overlay });

        if (overlay) {
          const outcome = await writeOverlay(paths, overlay, (doc, base) => removeOverlayPlugin(doc, base, profile, alias));
          reportWrite(opts, overlay, 'removed', { profile, alias, outcome }, `Removed plugin '${alias}' from profile '${profile}'`);
          return;
        }
        await writeBase(paths, selection, (manifest) => {
          requirePlugin(manifest, profile, alias);
          delete manifest.profiles[profile].plugins[alias];
        });
        reportWrite(opts, null, 'removed', { profile, alias }, `Removed plugin '${alias}' from profile '${profile}'`);
      });
  }

  const order = ['install', 'update', 'remove', 'enable', 'disable', 'list', 'config'];
  (pluginsCmd.commands as Command[]).sort((a, b) => order.indexOf(a.name()) - order.indexOf(b.name()));

  return { installPlugin };
}
