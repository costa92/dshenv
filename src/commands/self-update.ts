import { selfUpdate, type Runner } from '../self-update/self-update.js';
import type { CommandContext } from './context.js';

export interface SelfUpdateCommandInput {
  version: string;
  packageRoot: string;
  run?: Runner;
}

export function registerSelfUpdateCommand(ctx: CommandContext, input: SelfUpdateCommandInput): void {
  const { program, writeOut, setExitCode } = ctx;

  program
    .command('self-update')
    .description('Update dshenv itself from the npm registry with the package manager that installed it')
    .addHelpText('after', '\nRuns right away: it changes no DSH or envctl file, only the dshenv install, so it\ntakes no --yes. Use --check (or --dry-run) to only report.')
    .option('--check', 'only report whether a newer version exists; exit code 2 when one does')
    .option('--dry-run', 'same as --check')
    .option('--to <version>', 'install this exact version instead of the latest, downgrading if it is older')
    .action(async (cmdOpts: { check?: boolean; dryRun?: boolean; to?: string }) => {
      const opts = program.opts();
      const result = await selfUpdate({
        currentVersion: input.version,
        packageRoot: input.packageRoot,
        to: cmdOpts.to,
        check: cmdOpts.check || cmdOpts.dryRun,
        run: input.run
      });
      if (result.status === 'available') {
        setExitCode(2);
      }
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      if (result.status === 'up-to-date') {
        writeOut(`dshenv ${result.current} is up to date\n`);
      } else if (result.status === 'newer-installed') {
        writeOut(`dshenv ${result.current} is newer than the latest release ${result.target}; nothing to do\n`);
      } else if (result.status === 'available') {
        const what = result.direction === 'downgrade' ? `A downgrade to dshenv ${result.target}` : `dshenv ${result.target}`;
        const next = result.method
          ? `run: dshenv self-update${cmdOpts.to ? ` --to ${result.target}` : ''}`
          : `update it the way it was installed, e.g. npm install -g @costa92/dshenv@${result.target}`;
        writeOut(`${what} is available (installed ${result.current}); ${next}\n`);
      } else {
        const verb = result.direction === 'downgrade' ? 'Downgraded' : 'Updated';
        writeOut(`${verb} dshenv ${result.current} -> ${result.target} with: ${result.command}\n`);
      }
    });
}
