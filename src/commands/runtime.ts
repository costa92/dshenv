import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import type { EnvironmentManifest } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { DshError, ValidationError } from '../errors.js';
import { loadState } from '../manifest/files.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { renderRuntimeReport } from '../output/render.js';
import { callDshWeb, DSH_URL_ENV, loginDshWeb, parseDshWebUrl, type DshWebTarget } from '../dsh/web-client.js';
import { startDshWeb } from '../dsh/web-server.js';
import { profilePatchFile } from '../apply/patches.js';
import { mountedByOtherEntry } from '../patch/mount.js';
import { dshWebCommand, runningWebRecord } from './web.js';
import {
  checkRuntime,
  parseRuntimeBundles,
  parseRuntimePlugins,
  runtimeExitCode,
  type DeclaredPlugin,
  type RuntimeCheckItem,
  type RuntimeBundle
} from '../runtime/compare.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, profileFromEnv, PROFILE_ENV, TARGET_PROFILE_HELP, type CommandContext } from './context.js';
import { didYouMean } from './suggest.js';

// -p, else DSHENV_PROFILE, else the only declared profile; only a declared profile can be checked.
function selectProfile(manifest: EnvironmentManifest, requested: string | undefined): string {
  const names = Object.keys(manifest.profiles).sort();
  const fromEnv = requested === undefined ? profileFromEnv() : undefined;
  const named = requested ?? fromEnv;
  if (named !== undefined) {
    if (!names.includes(named)) {
      const source = fromEnv !== undefined ? ` (from ${PROFILE_ENV})` : '';
      throw new ValidationError(
        `Profile '${named}'${source} is not declared in the manifest${didYouMean(named, names)}${names.length > 0 ? ` (declared: ${names.join(', ')})` : ''}`
      );
    }
    return named;
  }
  if (names.length === 1) {
    return names[0];
  }
  throw new ValidationError(
    names.length === 0 ? 'The manifest declares no profiles' : `Missing -p, --profile <name>: choose one of ${names.join(', ')}, or set ${PROFILE_ENV}`
  );
}

// DSH does not say which profile it runs; listBundles reads that profile's package.json, so the packages must agree.
function assertSameProfile(
  paths: EnvironmentPaths,
  profile: string,
  declaredPackages: string[],
  bundles: RuntimeBundle[],
  endpoint: string
): void {
  const file = path.join(paths.profilesDir, profile, 'package.json');
  if (!fs.existsSync(file)) {
    throw new DshError(`Profile ${profile} has no package.json at ${file}; cannot tell whether DSH at ${endpoint} runs it`);
  }
  let raw: { dependencies?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { dependencies?: unknown };
  } catch {
    throw new DshError(`Profile ${profile} package.json is not valid JSON: ${file}`);
  }
  const dependencies = new Set(
    raw.dependencies !== null && typeof raw.dependencies === 'object' ? Object.keys(raw.dependencies as object) : []
  );
  const running = new Set(bundles.map((bundle) => bundle.name));
  const foreign = bundles.some((bundle) => bundle.installed && !dependencies.has(bundle.name));
  const unseen = declaredPackages.some((name) => dependencies.has(name) && !running.has(name));
  if (foreign || unseen) {
    throw new DshError(
      `DSH at ${endpoint} does not look like profile ${profile}: its installed packages differ from ${file}; ${DSH_URL_ENV} may point at the dsh web of another profile or DSH home`
    );
  }
}

export function registerRuntimeCommand(ctx: CommandContext): void {
  const { program, writeOut, setExitCode } = ctx;

  program
    .command('verify')
    .alias('runtime')
    .description(`Ask a running dsh web (${DSH_URL_ENV}) whether the declared plugins are loaded`)
    .option('-p, --profile <name>', TARGET_PROFILE_HELP, profileOption)
    .option('--allow-remote', 'allow sending the dsh web token to a non-loopback https host')
    .option('--start', `start dsh web for the profile, check it and stop it again, instead of using ${DSH_URL_ENV}`)
    .option('--timeout <seconds>', 'keep asking while DSH is still hot-reloading a plugin, for up to this long, as apply --verify-timeout', '0')
    .action(async (cmdOpts: { profile?: string; allowRemote?: boolean; start?: boolean; timeout: string }) => {
      if (!/^\d+(\.\d+)?$/.test(cmdOpts.timeout)) {
        throw new ValidationError(`Invalid --timeout value: ${cmdOpts.timeout}`);
      }
      const timeoutMs = Number(cmdOpts.timeout) * 1000;
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
      const profile = selectProfile(manifest, cmdOpts.profile);
      if (!cmdOpts.start) {
        const url = await dshWebUrlFor(paths, profile);
        if (url === undefined) {
          throw new ValidationError(
            `${DSH_URL_ENV} is not set and no dsh web started by 'dshenv web start' is running for profile ${profile}; export the URL dsh web printed, run dshenv web start -p ${profile}, or pass --start`
          );
        }
        await checkProfile(paths, manifest, profile, parseDshWebUrl(url, { allowRemote: Boolean(cmdOpts.allowRemote) }), timeoutMs, opts.json);
        return;
      }
      if (cmdOpts.allowRemote) {
        throw new ValidationError('--start and --allow-remote cannot be combined: --start checks the dsh web it starts on this machine');
      }
      const web = await startDshWeb(profile, { command: await dshWebCommand(paths, opts, profile), dshHome: paths.home });
      try {
        await checkProfile(paths, manifest, profile, parseDshWebUrl(web.url), timeoutMs, opts.json);
      } finally {
        await web.stop();
      }
    });

  async function checkProfile(
    paths: EnvironmentPaths,
    manifest: EnvironmentManifest,
    profile: string,
    target: DshWebTarget,
    timeoutMs: number,
    json: boolean | undefined
  ): Promise<void> {
    const results = await pollProfileRuntime(paths, manifest, profile, target, timeoutMs);
    if (json) {
      writeOut(JSON.stringify({ profile, endpoint: target.endpoint, results }, null, 2) + '\n');
    } else {
      writeOut(renderRuntimeReport(profile, target.endpoint, results));
    }
    setExitCode(runtimeExitCode(results));
  }
}

// DSHENV_DSH_URL, else the dsh web that dshenv web start left running for the profile.
export async function dshWebUrlFor(paths: EnvironmentPaths, profile: string): Promise<string | undefined> {
  return process.env[DSH_URL_ENV]?.trim() ? process.env[DSH_URL_ENV] : (await runningWebRecord(paths, profile))?.url;
}

// Asks the dsh web whether the plugins the manifest declares for the profile are loaded.
export async function checkProfileRuntime(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  profile: string,
  target: DshWebTarget
): Promise<RuntimeCheckItem[]> {
  const session = await loginDshWeb(target);
  const bundles = parseRuntimeBundles(await callDshWeb(session, 'pluginManager', 'listBundles'), target.endpoint);
  const plugins = parseRuntimePlugins(await callDshWeb(session, 'pluginManager', 'listPlugins'), target.endpoint);

  const entries = Object.entries(manifest.profiles[profile]?.plugins ?? {});
  const installed = (await readEnvironmentInventory(paths)).profiles[profile]?.plugins ?? {};
  // A mounted plugin is in no bundle, so listBundles cannot show it.
  const enabledPackages = entries
    .filter(([, plugin]) => plugin.enabled !== false && installed[plugin.package]?.bundle !== false)
    .map(([, plugin]) => plugin.package);
  assertSameProfile(paths, profile, enabledPackages, bundles, target.endpoint);

  const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
  const patchFile = fs.existsSync(profilePatchFile(paths, profile)) ? fs.readFileSync(profilePatchFile(paths, profile), 'utf8') : '';
  const declared: DeclaredPlugin[] = entries.map(([alias, plugin]) => {
    const mounted = installed[plugin.package]?.bundle === false;
    return {
      alias,
      package: plugin.package,
      enabled: plugin.enabled !== false,
      restartRequired: state?.profiles[profile]?.plugins[plugin.package]?.status === 'restart-required',
      ...(mounted ? { mounted: true } : {}),
      ...(mounted && plugin.enabled === false && mountedByOtherEntry(patchFile, profile, alias, plugin.package) ? { mountedByPatch: true } : {})
    };
  });
  return checkRuntime(declared, bundles, plugins);
}

export type ProfileVerification =
  | { profile: string; endpoint: string; results: RuntimeCheckItem[] }
  | { profile: string; skipped: string }
  | { profile: string; error: string };

// Results a hot reload that has not happened yet can still turn into loaded or unloaded; a plugin that owes
// a restart reads as not-loaded or still-loaded until then too.
const HOT_RELOAD_PENDING: ReadonlySet<RuntimeCheckItem['result']> = new Set(['loading', 'not-loaded', 'still-loaded']);

// Checks the profile after apply; DSH hot-reloads a moment later, so such results are asked about again until the timeout.
// With several profiles to check, DSHENV_DSH_URL cannot tell which one its dsh web runs, so only `web start` records count.
// Asks again while DSH may still hot-reload a plugin, until it settles or the time is up.
async function pollProfileRuntime(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  profile: string,
  target: DshWebTarget,
  timeoutMs: number
): Promise<RuntimeCheckItem[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const results = await checkProfileRuntime(paths, manifest, profile, target);
    if (!results.some((item) => HOT_RELOAD_PENDING.has(item.result)) || Date.now() >= deadline) {
      return results;
    }
    await delay(Math.min(1000, deadline - Date.now()));
  }
}

export async function verifyProfileRuntime(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  profile: string,
  timeoutMs: number,
  options: { severalProfiles?: boolean } = {}
): Promise<ProfileVerification> {
  const url = options.severalProfiles ? (await runningWebRecord(paths, profile))?.url : await dshWebUrlFor(paths, profile);
  if (url === undefined) {
    if (options.severalProfiles && process.env[DSH_URL_ENV]?.trim()) {
      return {
        profile,
        skipped: `${DSH_URL_ENV} names one dsh web but apply changed several profiles; run dshenv web start -p ${profile}, or dshenv verify -p ${profile}`
      };
    }
    return { profile, skipped: `no dsh web is running for profile ${profile}; run dshenv web start -p ${profile}, or set ${DSH_URL_ENV}` };
  }
  try {
    const target = parseDshWebUrl(url);
    return { profile, endpoint: target.endpoint, results: await pollProfileRuntime(paths, manifest, profile, target, timeoutMs) };
  } catch (err) {
    if (err instanceof DshError) {
      return { profile, error: err.message };
    }
    throw err;
  }
}

export function verificationExitCode(verifications: ProfileVerification[]): number {
  return Math.max(0, ...verifications.map((item) => ('results' in item ? runtimeExitCode(item.results) : 'error' in item ? 5 : 0)));
}
