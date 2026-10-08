import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { loadLock, loadManifest, loadState } from '../manifest/files.js';
import { addProfileShadows, buildPlan, buildStatus, onlyProfile, planExitCode, planJson } from '../planner/plan.js';
import { renderPlan, renderStatus, renderDoctor, type DoctorReport } from '../output/render.js';
import { resolveDshCommand, probeDsh, isCompatibleDshVersion, capabilitiesFor, evaluateCapabilities, probeOfficialSurfaces, unsupportedDshVersionMessage, displayDshVersion, type RuntimeCapabilityEvidence } from '../dsh/index.js';
import { readLocalSourceDigests } from '../source/local.js';
import { ValidationError, CapabilityError, missingManifestError } from '../errors.js';
import { isValidProfileName } from '../manifest/schema.js';
import type { EnvironmentLock, EnvironmentManifest, EnvironmentState } from '../domain.js';
import { loadEffectiveManifest, overlaySwitchWarning, readOverlay } from '../overlay/effective.js';
import { mergeManifest } from '../overlay/merge.js';
import { resolveCliPaths, resolveCliOverlay, overlayBanner, filterProfile, type CommandContext } from './context.js';
import { readRemoteConfig } from '../remote/schema.js';
import { findLocalDrift, findRemoteLockDrift } from '../remote/ownership.js';
import { ENV_KEY_ADVICE, documentSecrets } from '../security/secrets.js';
import { readSkippedBundles } from '../dsh/dump-check.js';
import { readVersionExemptions } from '../inventory/compatibility.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';

// A dump creates a missing profile, so only the ones DSH already has are asked.
function existingProfiles(paths: EnvironmentPaths, inventory: EnvironmentInventory): string[] {
  return Object.keys(inventory.profiles).filter((profile) => fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))).sort();
}

// A warning only: the credential is already in a shared file, and refusing to read it would not take it out.
function warnPlaintextSecrets(writeErr: (chunk: string) => void, manifest: EnvironmentManifest | null | undefined): void {
  const found = manifest ? documentSecrets(manifest) : [];
  if (found.length > 0) {
    writeErr(`Warning: the manifest or overlay holds plaintext credentials (${found.map((secret) => secret.location).join(', ')}); ${ENV_KEY_ADVICE}\n`);
  }
}

export function registerInspectCommands(ctx: CommandContext): void {
  const { program, writeOut, writeErr, setExitCode } = ctx;

  program
    .command('plan')
    .description('Show what apply would change: the manifest against DSH on disk')
    .addOption(filterProfile())
    .action(async (cmdOpts: { profile?: string }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      const selection = resolveCliOverlay(opts, paths);
      const effective = loadEffectiveManifest(paths, selection).manifest;
      const manifest = onlyProfile(effective, cmdOpts.profile);
      let lock: EnvironmentLock | null = null;

      if (fs.existsSync(paths.lockFile)) {
        const content = fs.readFileSync(paths.lockFile, 'utf8');
        lock = loadLock(content);
      }

      let planState: EnvironmentState | null = null;
      if (fs.existsSync(paths.stateFile)) {
        planState = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
      }

      const fullInventory = await readEnvironmentInventory(paths);
      const inventory = onlyProfile(fullInventory, cmdOpts.profile);
      const plan = addProfileShadows(
        buildPlan(manifest, lock, inventory, planState, await readLocalSourceDigests(manifest)),
        effective,
        fullInventory,
        cmdOpts.profile
      );
      if (selection && plan.retiredBundles && fs.existsSync(paths.manifestFile)) {
        const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
        for (const item of plan.retiredBundles) {
          if (!base.profiles[item.profile]?.plugins[item.alias]) item.layer = 'overlay';
        }
      }

      const warning = overlaySwitchWarning(planState, selection);
      if (warning) {
        writeErr(`${warning}\n`);
      }
      warnPlaintextSecrets(writeErr, manifest);

      if (opts.json) {
        writeOut(JSON.stringify(selection ? { ...planJson(plan), overlay: selection } : planJson(plan), null, 2) + '\n');
      } else {
        if (selection) {
          writeErr(overlayBanner(selection));
        }
        writeOut(renderPlan(plan));
      }

      setExitCode(planExitCode(plan));
      if (planExitCode(plan) === 2 && !opts.json) {
        writeErr('Next: dshenv apply --yes\n');
      }
    });

  program
    .command('status')
    .argument('[alias]', 'show only this plugin (alias or package name)')
    .description('Show whether DSH matches the manifest: drift, pending operations and unmanaged plugins')
    .addOption(filterProfile())
    .action(async (plugin: string | undefined, cmdOpts: { profile?: string }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const selection = resolveCliOverlay(opts, paths);

      let lock: EnvironmentLock | null = null;
      let state: EnvironmentState | null = null;

      // Without a manifest nothing is managed yet: a missing input, as plan reports it, not a degraded runtime.
      if (!fs.existsSync(paths.manifestFile)) {
        throw missingManifestError(paths.manifestFile);
      }
      const effective = loadEffectiveManifest(paths, selection).manifest;
      const manifest = onlyProfile(effective, cmdOpts.profile);
      if (fs.existsSync(paths.lockFile)) {
        const content = fs.readFileSync(paths.lockFile, 'utf8');
        lock = loadLock(content);
      }
      if (fs.existsSync(paths.stateFile)) {
        const content = fs.readFileSync(paths.stateFile, 'utf8');
        state = loadState(content);
      }

      const fullInventory = await readEnvironmentInventory(paths);
      const inventory = onlyProfile(fullInventory, cmdOpts.profile);
      const plan = addProfileShadows(
        buildPlan(manifest, lock, inventory, state, await readLocalSourceDigests(manifest)),
        effective,
        fullInventory,
        cmdOpts.profile
      );
      const summary = buildStatus(manifest, state, inventory, plan);
      warnPlaintextSecrets(writeErr, manifest);
      if (plugin) {
        summary.plugins = summary.plugins.filter(
          (entry) =>
            entry.package === plugin ||
            entry.package.endsWith(`/${plugin}`) ||
            manifest?.profiles[entry.profile]?.plugins[plugin]?.package === entry.package
        );
        if (summary.plugins.length === 0) {
          throw new ValidationError(`Plugin not found in status: ${plugin}`);
        }
      }
      // With a plugin given, only what concerns it.
      const shown = (profile: string, pkg: string) => !plugin || summary.plugins.some((entry) => entry.profile === profile && entry.package === pkg);

      const command = resolveDshCommand({ cliHarnessSource: opts.harnessSource, manifestHarnessSource: manifest?.environment?.harness?.sourceDir });
      // Only a DSH the version gate takes is asked: another may word these lines differently, or not be DSH at all.
      const allowUntested = Boolean(opts.allowUntestedDsh || manifest?.environment?.harness?.allowUntestedVersion);
      const version = command ? (await probeDsh(command).catch(() => null))?.version : undefined;
      const { skippedBundles } = command && version && isCompatibleDshVersion(version, { allowUntested }).compatible
        ? await readSkippedBundles(existingProfiles(paths, inventory), { command, home: paths.home, profilesDir: paths.profilesDir })
        : { skippedBundles: [] };
      const skipped = skippedBundles.filter((item) => shown(item.profile, item.package));
      if (skipped.length > 0) {
        summary.skippedBundles = skipped;
        summary.status = 'degraded';
      }
      const { exemptions, warnings: exemptionWarnings } = readVersionExemptions(paths.profilesDir, existingProfiles(paths, inventory));
      const exempted = exemptions.filter((item) => shown(item.profile, item.package.slice(0, item.package.lastIndexOf('@'))));
      if (exempted.length > 0) {
        summary.versionExemptions = exempted;
      }
      for (const warning of exemptionWarnings) {
        writeErr(`Warning: ${warning}\n`);
      }
      const retired = (plan.retiredBundles ?? []).filter((item) => shown(item.profile, item.package));
      if (retired.length > 0) {
        summary.retiredBundles = retired;
      }

      if (opts.json) {
        writeOut(JSON.stringify(selection ? { ...summary, overlay: selection } : summary, null, 2) + '\n');
      } else {
        if (selection) {
          writeErr(overlayBanner(selection));
        }
        writeOut(renderStatus(summary));
      }

      if (summary.status === 'degraded' || summary.status === 'incompatible') {
        setExitCode(5);
      } else {
        setExitCode(planExitCode(plan));
      }
    });

  program
    .command('doctor')
    .description('Check that DSH runs and the dshenv files are readable (not whether plugins are loaded: verify)')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      const remote = readRemoteConfig(paths);

      const selection = resolveCliOverlay(opts, paths);
      let manifest: EnvironmentManifest | undefined;
      // A broken overlay selection is exactly what doctor must surface, an overlay that cannot merge included; only an
      // invalid base is tolerated, as without an overlay. A missing base is reported via manifestExists.
      const overlay = selection ? readOverlay(paths, selection.name) : null;
      if (fs.existsSync(paths.manifestFile)) {
        let base: EnvironmentManifest | undefined;
        try {
          base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
        } catch (err) {
          // doctor still probes DSH, but without the manifest's harness settings, which may pick another DSH.
          const reason = err instanceof Error ? err.message : String(err);
          writeErr(`Warning: the manifest ${paths.manifestFile} is invalid (${reason}); doctor ignores its harness settings\n`);
        }
        if (base) {
          manifest = overlay && selection ? mergeManifest(base, overlay, selection.name).manifest : base;
        }
      }
      // doctor reads no lock, but plan and apply refuse an invalid one, so the files are not readable as it reports.
      if (fs.existsSync(paths.lockFile)) {
        try {
          loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          writeErr(`Warning: the lock ${paths.lockFile} is invalid (${reason}); plan and apply refuse it\n`);
        }
      }
      warnPlaintextSecrets(writeErr, manifest);
      const manifestHarnessSource = manifest?.environment?.harness?.sourceDir;
      const manifestAllowUntested = manifest?.environment?.harness?.allowUntestedVersion;

      const allowUntested = Boolean(opts.allowUntestedDsh || manifestAllowUntested);
      const compatOpts = { allowUntested };

      const dshCmd = resolveDshCommand({
        cliHarnessSource: opts.harnessSource,
        manifestHarnessSource
      });

      if (!dshCmd) {
        throw new CapabilityError('DSH command could not be resolved from DSH_CLI, harness-source, or PATH');
      }

      const probeResult = await probeDsh(dshCmd);
      const caps = capabilitiesFor(probeResult.version, compatOpts);

      if (caps.discovery.status !== 'available') {
        throw new CapabilityError(unsupportedDshVersionMessage(probeResult.version));
      }

      const evidence: RuntimeCapabilityEvidence = dshCmd.cwd
        ? await probeOfficialSurfaces({ harnessSourceDir: dshCmd.cwd })
        : {
          operationsExport: {
            declared: false,
            targetExists: false,
            exportName: caps.operationsExport ?? ''
          },
          liveService: { configured: false, reachable: false },
          diagnostics: ['HARNESS_SOURCE_UNAVAILABLE']
        };
      const evaluatedCaps = evaluateCapabilities(probeResult.version, evidence, compatOpts);
      const profiles = (fs.existsSync(paths.profilesDir) ? fs.readdirSync(paths.profilesDir) : [])
        .filter((profile) => isValidProfileName(profile) && fs.existsSync(path.join(paths.profilesDir, profile, 'package.json')))
        .sort();
      const bundles = await readSkippedBundles(profiles, { command: dshCmd, home: paths.home, profilesDir: paths.profilesDir });

      const report: DoctorReport = {
        runtime: {
          command: dshCmd.file,
          version: displayDshVersion(probeResult.version),
          discoverySupported: evaluatedCaps.discovery.status === 'available',
          mutationsSupported: evaluatedCaps.mutations,
          capabilities: evaluatedCaps
        },
        paths: {
          home: paths.home,
          managerDir: paths.managerDir,
          manifestExists: fs.existsSync(paths.manifestFile),
          lockExists: fs.existsSync(paths.lockFile),
          stateExists: fs.existsSync(paths.stateFile)
        },
        ...(bundles.skippedBundles.length > 0 || bundles.unchecked.length > 0
          ? { bundles: { skipped: bundles.skippedBundles, unchecked: bundles.unchecked } }
          : {}),
        ...(remote
          ? {
              remote: {
                url: remote.url,
                branch: remote.branch,
                path: remote.path,
                commit: remote.commit,
                drift: findLocalDrift(paths, remote),
                lockDrift: findRemoteLockDrift(paths, remote)
              }
            }
          : {})
      };

      if (opts.json) {
        writeOut(JSON.stringify(selection ? { ...report, overlay: selection } : report, null, 2) + '\n');
      } else {
        if (selection) {
          writeErr(overlayBanner(selection));
        }
        writeOut(renderDoctor(report));
      }
    });
}
