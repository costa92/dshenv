import * as os from 'node:os';
import { migrateEnvctl } from '../environment/migrate.js';
import { resolveHomePath } from '../environment/paths.js';
import { ENVCTL_ENV, resolveUncheckedCliPaths, type CommandContext } from './context.js';
import { reportPreview } from './confirm.js';

export function registerMigrateCommand(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  program
    .command('migrate')
    .description('Move envctl to a directory outside the DSH home, copying a symlinked envctl by content')
    .requiredOption('--to <dir>', 'directory to move envctl to; it must not exist or be empty')
    .option('--dry-run', 'show what would move; exit code 2 when there is something to move')
    .option('-y, --yes', 'move it; without it migrate only previews, like --dry-run')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveUncheckedCliPaths(opts);
      const to = resolveHomePath(cmdOpts.to, '--to', process.cwd(), os.homedir());
      const result = await migrateEnvctl(paths, to, { dryRun: Boolean(cmdOpts.dryRun) || !cmdOpts.yes });
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`${result.dryRun ? 'Would move' : 'Moved'} envctl from ${result.from} to ${result.to}\n`);
        for (const link of result.linked) {
          writeOut(`  ${link} is a symlink: its content is copied, its target is left in place${link === result.from ? ' and marked as moved' : ''}\n`);
        }
        for (const change of result.rewritten) {
          writeOut(`  ${result.dryRun ? 'would rewrite' : 'rewrote'} ${change}\n`);
        }
        for (const file of result.skipped) {
          writeOut(`  ${file} could not be read: any old paths in this snapshot are left as they are\n`);
        }
        if (!result.dryRun) {
          writeOut(`Next: set ${ENVCTL_ENV}=${result.to} (or pass --envctl-dir ${result.to}) for every later dshenv command\n`);
          if (result.rewritten.length > 0) {
            writeOut('Local plugins DSH installed from the old paths still point at them: run dshenv plan, then dshenv apply --yes to reinstall them\n');
          }
        }
      }
      reportPreview(ctx, { json: opts.json, dryRun: cmdOpts.dryRun, pending: result.dryRun, action: 'move it' });
    });
}
