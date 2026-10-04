import * as fs from 'node:fs';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { loadLock, loadState } from '../manifest/files.js';
import { buildPlan, buildStatus, onlyProfile, planExitCode, planJson } from '../planner/plan.js';
import { renderPlan, renderStatus, renderDoctor, type DoctorReport } from '../output/render.js';
import { resolveDshCommand, probeDsh, capabilitiesFor, evaluateCapabilities, probeOfficialSurfaces, unsupportedDshVersionMessage, type RuntimeCapabilityEvidence } from '../dsh/index.js';
import { readLocalSourceDigests } from '../source/local.js';
import { ValidationError, CapabilityError, START_HINT } from '../errors.js';
import type { EnvironmentLock, EnvironmentManifest, EnvironmentState } from '../domain.js';
import { loadEffectiveManifest, overlaySwitchWarning, readOverlay } from '../overlay/effective.js';
import { resolveCliPaths, resolveCliOverlay, overlayBanner, filterProfile, type CommandContext } from './context.js';
import { readRemoteConfig } from '../remote/schema.js';
import { findLocalDrift, findRemoteLockDrift } from '../remote/ownership.js';

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
      const manifest = onlyProfile(loadEffectiveManifest(paths, selection).manifest, cmdOpts.profile);
      let lock: EnvironmentLock | null = null;

      if (fs.existsSync(paths.lockFile)) {
        const content = fs.readFileSync(paths.lockFile, 'utf8');
        lock = loadLock(content);
      }

      let planState: EnvironmentState | null = null;
      if (fs.existsSync(paths.stateFile)) {
        planState = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
      }

      const inventory = onlyProfile(await readEnvironmentInventory(paths), cmdOpts.profile);
      const plan = buildPlan(manifest, lock, inventory, planState, await readLocalSourceDigests(manifest));

      const warning = overlaySwitchWarning(planState, selection);
      if (warning) {
        writeErr(`${warning}\n`);
      }

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

      let manifest: EnvironmentManifest | null = null;
      let lock: EnvironmentLock | null = null;
      let state: EnvironmentState | null = null;

      if (fs.existsSync(paths.manifestFile)) {
        manifest = onlyProfile(loadEffectiveManifest(paths, selection).manifest, cmdOpts.profile);
      } else {
        writeErr(`No manifest at ${paths.manifestFile}; ${START_HINT}\n`);
      }
      if (fs.existsSync(paths.lockFile)) {
        const content = fs.readFileSync(paths.lockFile, 'utf8');
        lock = loadLock(content);
      }
      if (fs.existsSync(paths.stateFile)) {
        const content = fs.readFileSync(paths.stateFile, 'utf8');
        state = loadState(content);
      }

      const inventory = onlyProfile(await readEnvironmentInventory(paths), cmdOpts.profile);
      const plan = buildPlan(manifest, lock, inventory, state, await readLocalSourceDigests(manifest));
      const summary = buildStatus(manifest, state, inventory, plan);
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

      if (opts.json) {
        writeOut(JSON.stringify(selection ? { ...summary, overlay: selection } : summary, null, 2) + '\n');
      } else {
        if (selection) {
          writeErr(overlayBanner(selection));
        }
        writeOut(renderStatus(summary));
      }

      // Without a manifest nothing is managed yet: a missing input, as plan reports it, not a degraded runtime.
      if (!manifest) {
        setExitCode(3);
      } else if (summary.status === 'degraded' || summary.status === 'incompatible') {
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
      if (selection && !fs.existsSync(paths.manifestFile)) {
        // A missing base is reported via manifestExists, as without an overlay; the overlay itself is still checked.
        readOverlay(paths, selection.name);
      } else if (selection) {
        // A broken overlay selection is exactly what doctor must surface.
        manifest = loadEffectiveManifest(paths, selection).manifest;
      } else if (fs.existsSync(paths.manifestFile)) {
        try {
          manifest = loadEffectiveManifest(paths, null).manifest;
        } catch (err) {
          // doctor still probes DSH, but without the manifest's harness settings, which may pick another DSH.
          const reason = err instanceof Error ? err.message : String(err);
          writeErr(`Warning: the manifest ${paths.manifestFile} is invalid (${reason}); doctor ignores its harness settings\n`);
        }
      }
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

      const report: DoctorReport = {
        runtime: {
          command: dshCmd.file,
          version: probeResult.version,
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
