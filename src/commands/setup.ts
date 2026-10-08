import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { captureEnvironment, initEnvironment } from '../import/capture.js';
import { adoptEnvironment, type AdoptDetail } from '../import/adopt.js';
import { parseYamlStrict, serializeCaptureDocument } from '../manifest/files.js';
import { CaptureDocumentSchema } from '../manifest/schema.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withEnvironmentLock } from '../io/lock.js';
import { ValidationError } from '../errors.js';
import type { CaptureDocument } from '../domain.js';
import { assertNotRemoteOwned } from '../remote/ownership.js';
import { assertBaseMergesWithOverlay, resolveWriteLayer } from '../overlay/write.js';
import { readOverlay } from '../overlay/effective.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, PROFILE_FILTER_HELP, type CommandContext } from './context.js';
import { Option } from 'commander';
import { pullProfilePatches } from '../import/pull.js';
import { renderPullResult } from './pull.js';
import { reportPreview } from './confirm.js';

function machineLocalPackages(details: AdoptDetail[]): Record<string, string[]> {
  const packages: Record<string, string[]> = {};
  for (const detail of details) {
    (packages[detail.profile] ??= []).push(detail.package);
  }
  return packages;
}

export function registerSetupCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  program
    .command('init')
    .description('Create an empty manifest to start managing DSH')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      await withEnvironmentLock(paths, async () => {
        if (fs.existsSync(paths.manifestFile)) {
          throw new ValidationError(`dshenv is already initialized at ${paths.managerDir}; see dshenv status or dshenv plan`);
        }
        await initEnvironment(paths);
      });
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'initialized', paths }, null, 2) + '\n');
      } else {
        writeOut(`Initialized dshenv environment at ${paths.managerDir}\n`);
        writeOut('Next: declare a plugin with dshenv install <package>@<version> -p <profile>, then dshenv plan and dshenv apply --yes\n');
      }
    });

  program
    .command('capture')
    .description('Write what DSH already has installed into a candidate manifest for adopt to review')
    .option('-o, --output <file>', 'output candidate manifest file')
    .option('-p, --profile <name>', PROFILE_FILTER_HELP, profileOption)
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const inventory = await readEnvironmentInventory(paths);
      const captureDoc = captureEnvironment(inventory, {
        profile: cmdOpts.profile
      });

      if (cmdOpts.output) {
        const targetOutput = path.isAbsolute(cmdOpts.output)
          ? cmdOpts.output
          : path.resolve(process.cwd(), cmdOpts.output);
        const yamlOutput = serializeCaptureDocument(captureDoc);
        await writeAtomic(targetOutput, yamlOutput, 'create');
        if (opts.json) {
          writeOut(JSON.stringify({ status: 'captured', file: targetOutput, warnings: captureDoc.warnings }, null, 2) + '\n');
        } else {
          writeOut(`Environment captured successfully to ${targetOutput}\n`);
        }
      } else {
        if (opts.json) {
          writeOut(JSON.stringify(captureDoc, null, 2) + '\n');
        } else {
          writeOut(serializeCaptureDocument(captureDoc));
        }
      }
    });

  program
    .command('adopt')
    .description('Take a captured manifest into management: write it to the manifest and lock')
    .argument('[file]', 'candidate manifest written by capture')
    .usage('[options] <file>')
    // The file used to be given only as -f; kept out of help for old scripts.
    .addOption(new Option('-f, --from <file>').hideHelp())
    .option('--dry-run', 'show what adopt would take over without writing; exit code 2 when there is any')
    .option('-y, --yes', 'adopt; without it adopt only previews what it would take over')
    // Only base is valid, so the option is accepted for scripts that pass it but not shown.
    .addOption(new Option('--layer <layer>').hideHelp())
    .action(async (file: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (file !== undefined && cmdOpts.from !== undefined) {
        throw new ValidationError('Give the capture file once: as the argument or with -f, not both');
      }
      const from: string | undefined = file ?? cmdOpts.from;
      if (from === undefined) {
        throw new ValidationError("missing required argument 'file'");
      }

      const selection = resolveCliOverlay(opts, paths);
      // adopt picks the layer per plugin (machine-local ones go to an overlay), so an active overlay does not make it ask for --layer.
      if (resolveWriteLayer(selection, cmdOpts.layer ?? 'base') === 'overlay') {
        throw new ValidationError('adopt picks the layer itself: the base, and an overlay for machine-local plugins; drop --layer overlay');
      }
      // Adopt rewrites the base and the whole lock; a subscription always owns the base, so team lock entries stay intact too.
      assertNotRemoteOwned(paths, paths.manifestFile);

      const candidatePath = path.isAbsolute(from)
        ? from
        : path.resolve(process.cwd(), from);

      if (!fs.existsSync(candidatePath)) {
        throw new ValidationError(`Candidate file not found: ${candidatePath}`);
      }

      const content = fs.readFileSync(candidatePath, 'utf8');
      const raw = parseYamlStrict(content);
      const parsed = CaptureDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        throw new ValidationError(`Invalid candidate schema: ${issues}`);
      }

      const preview = Boolean(cmdOpts.dryRun) || !cmdOpts.yes;
      const summary = await adoptEnvironment(paths, parsed.data as CaptureDocument, {
        validateManifest: (manifest) => assertBaseMergesWithOverlay(paths, selection, manifest),
        dryRun: preview,
        overlay: selection ? readOverlay(paths, selection.name) : undefined,
        allowOverlay: selection !== null || opts.overlay !== false
      });
      const machineLocal = summary.details.filter((d) => d.layer === 'overlay');
      if (preview) {
        const pending = summary.details.filter((d) => !d.alreadyAdopted);
        if (opts.json) {
          writeOut(JSON.stringify({ ...summary, dryRun: true }, null, 2) + '\n');
        } else if (summary.details.length === 0) {
          writeOut('Nothing to adopt: the candidate declares no plugins.\n');
        } else if (pending.length === 0) {
          writeOut('Nothing to adopt: every plugin in the candidate is already adopted.\n');
        } else {
          const profiles = [...new Set(pending.map((d) => d.profile))];
          writeOut(`Would adopt ${pending.length} plugin(s) across profile(s): ${profiles.join(', ')}\n`);
          for (const d of pending) {
            writeOut(`  + [${d.profile}] ${d.package} (${d.alias}) [${d.sourceType}]${d.layer ? ' into an overlay' : ''}\n`);
          }
        }
        reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: pending.length > 0, action: 'adopt' });
        return;
      }
      // Taking over a profile includes the settings DSH wrote into its patch file.
      let patches: Awaited<ReturnType<typeof pullProfilePatches>> | null = null;
      try {
        patches = summary.profiles.length > 0
          ? await pullProfilePatches(paths, {
            profiles: summary.profiles,
            selection,
            allowOverlayCreation: opts.overlay !== false,
            plugins: machineLocal.length > 0 ? machineLocalPackages(machineLocal) : false,
            overlaySources: summary.overlaySources
          })
          : null;
      } catch (err) {
        // The adoption is already written; only the pull remains, so say so rather than suggest adopt failed.
        if (err instanceof Error) {
          err.message =
            `Adopted ${summary.adoptedCount} plugin(s) across profile(s): ${summary.profiles.join(', ')}, ` +
            `but taking over their patch entries${machineLocal.length > 0 ? ' and machine-local plugins' : ''} failed: ${err.message}; fix that and run dshenv pull --yes`;
        }
        throw err;
      }

      if (opts.json) {
        writeOut(JSON.stringify(patches ? { ...summary, patches } : summary, null, 2) + '\n');
      } else {
        // Plugins already adopted as the candidate has them changed nothing, so they are not reported as adopted.
        const adopted = summary.details.filter((detail) => !detail.alreadyAdopted);
        writeOut(
          summary.adoptedCount === 0
            ? 'Nothing to adopt: the candidate declares no plugins.\n'
            : adopted.length === 0
              ? 'Nothing to adopt: every plugin in the candidate is already adopted.\n'
              : `Adopted ${adopted.length} plugin(s) across profile(s): ${[...new Set(adopted.map((d) => d.profile))].join(', ')}\n`
        );
        // The pull result lists the plugins it put into an overlay, and the overlay it created for them.
        for (const d of adopted.filter((detail) => !detail.layer)) {
          writeOut(`  + [${d.profile}] ${d.package} (${d.alias}) [${d.sourceType}]\n`);
        }
        if (patches && (patches.changes.length > 0 || patches.plugins || patches.skills || patches.warnings || patches.overlayCreated)) {
          writeOut(renderPullResult(patches));
        } else {
          writeOut('Next: dshenv plan\n');
        }
      }
    });
}
