import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { CapabilityError, DshError, ValidationError } from '../errors.js';
import { probeDsh, resolveDshCommand } from '../dsh/command.js';
import { capabilitiesFor } from '../dsh/capabilities.js';
import { unsupportedDshVersionMessage } from '../dsh/version.js';
import { DSH_WEB_START_TIMEOUT_MS, dshWebState, launchDshWeb, stopProcessGroup, type DshWebState } from '../dsh/web-server.js';
import { acquireFileLock } from '../io/lock.js';
import { listWebRecords, readWebRecord, removeWebRecord, webLogFile, writeWebRecord, type DshWebRecord } from '../dsh/web-record.js';
import { parseDshWebUrl } from '../dsh/web-client.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { assertProfileName } from '../manifest/schema.js';
import { filterProfile, profileNotCreatedError, resolveCliOverlay, resolveCliPaths, targetProfile, type CommandContext } from './context.js';

interface CliOpts {
  dshHome?: string;
  harnessSource?: string;
  allowUntestedDsh?: boolean;
  overlay?: string | false;
  json?: boolean;
}

// dsh creates a profile it is started with, which starting or checking dsh web must not do.
export function assertProfileExists(paths: EnvironmentPaths, opts: { overlay?: string | false }, profile: string): void {
  assertProfileName(profile);
  if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
    throw profileNotCreatedError(paths, opts, profile);
  }
}

export function resolveCliDshCommand(paths: EnvironmentPaths, opts: CliOpts) {
  const manifestSource = fs.existsSync(paths.manifestFile)
    ? loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest.environment?.harness?.sourceDir
    : undefined;
  return resolveDshCommand({ cliHarnessSource: opts.harnessSource, manifestHarnessSource: manifestSource });
}

const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app';
const OTHER_APP_BUNDLES = ['@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-sdk-app'];

// Only the web app takes --no-open; without this check DSH's "unknown option" would be all the user sees.
function assertServesWeb(paths: EnvironmentPaths, profile: string): void {
  let bundles: unknown;
  try {
    bundles = JSON.parse(fs.readFileSync(path.join(paths.profilesDir, profile, 'package.json'), 'utf8'))?.dsh?.profile?.bundles;
  } catch {
    return;
  }
  if (!Array.isArray(bundles) || bundles.includes(WEB_APP_BUNDLE)) return;
  const app = OTHER_APP_BUNDLES.find((name) => bundles.includes(name));
  if (app) {
    throw new ValidationError(`Profile ${profile} runs ${app}, not dsh web; start dsh web for a profile whose bundles include ${WEB_APP_BUNDLE}`);
  }
}

// The DSH command to start dsh web with, refusing a profile or a DSH version it would not run on, as apply does.
export async function dshWebCommand(paths: EnvironmentPaths, opts: CliOpts, profile: string) {
  assertProfileExists(paths, opts, profile);
  assertServesWeb(paths, profile);
  const command = resolveCliDshCommand(paths, opts);
  if (command) {
    const allowUntested = Boolean(opts.allowUntestedDsh) || Boolean(
      fs.existsSync(paths.manifestFile) &&
        loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest.environment?.harness?.allowUntestedVersion
    );
    const { version } = await probeDsh(command);
    if (capabilitiesFor(version, { allowUntested }).discovery.status !== 'available') {
      throw new CapabilityError(unsupportedDshVersionMessage(version));
    }
  }
  return command;
}

// The dsh web `dshenv web start` left running for the profile, or null when there is none or it has stopped.
export async function runningWebRecord(paths: EnvironmentPaths, profile: string): Promise<DshWebRecord | null> {
  const record = readWebRecord(paths, profile);
  return record && (await dshWebState(record.pid, record.leaderStart)) === 'running' ? record : null;
}

// Stops what the record names, keeping the record when that is not certain to be this dsh web or it does not stop.
async function stopRecorded(paths: EnvironmentPaths, record: DshWebRecord, state: DshWebState): Promise<void> {
  if (state === 'unknown') {
    throw new DshError(
      `Cannot tell whether pid ${record.pid} is still the dsh web dshenv started for profile ${record.profile}, so it was left alone; stop it yourself if it is, then delete ${path.join(paths.runDir, `${record.profile}.json`)}`
    );
  }
  if ((state === 'running' || state === 'leftover') && !(await stopProcessGroup(record.pid))) {
    throw new DshError(`dsh web for profile ${record.profile} (pid ${record.pid}) is still running after SIGKILL`);
  }
  removeWebRecord(paths, record.profile);
}

const stateText: Record<DshWebState, string> = {
  running: 'running',
  leftover: 'not running (leftover processes)',
  stopped: 'not running',
  unknown: 'unknown (cannot tell whether the pid is still this dsh web)'
};

function portOption(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new ValidationError('--port must be an integer from 0 to 65535 (0 picks a free port)');
  }
  return port;
}

const endpointOf = (record: DshWebRecord): string => parseDshWebUrl(record.url).endpoint;

// One start or stop per profile at a time, so two starts cannot both launch dsh web; a start holds it until DSH is up.
async function withProfileLock<T>(paths: EnvironmentPaths, profile: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const lock = await acquireFileLock(path.join(paths.runDir, `${profile}.lock`), `dsh web lock for profile ${profile}`, DSH_WEB_START_TIMEOUT_MS + 15_000);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function registerWebCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;
  const web = program.command('web').description('Start, stop and list dsh web servers that keep running in the background');

  web
    .command('start')
    .description('Start dsh web for a profile in the background and print its URL')
    .addOption(targetProfile({ singleDeclared: true }))
    .option('--port <port>', 'port to listen on; 0 picks a free one', '0')
    .action(async (cmdOpts: { profile: string; port: string }) => {
      const opts = program.opts<CliOpts>();
      const port = portOption(cmdOpts.port);
      const paths = resolveCliPaths(opts);
      const { profile } = cmdOpts;
      const command = await dshWebCommand(paths, opts, profile);

      await withProfileLock(paths, profile, async () => {
        const current = readWebRecord(paths, profile);
        const state = current ? await dshWebState(current.pid, current.leaderStart) : 'stopped';
        if (current && state === 'running') {
          const runningPort = new URL(current.url).port;
          if (port !== 0 && runningPort !== '' && Number(runningPort) !== port) {
            throw new ValidationError(
              `dsh web for profile ${profile} is already running on port ${runningPort}; stop it first (dshenv web stop -p ${profile}) to start it on port ${port}`
            );
          }
          if (opts.json) {
            writeOut(JSON.stringify({ status: 'running', ...current, endpoint: endpointOf(current) }, null, 2) + '\n');
          } else {
            writeOut(`dsh web for profile ${profile} is already running (pid ${current.pid})\n  URL: ${current.url}\n`);
          }
          return;
        }
        if (current) {
          await stopRecorded(paths, current, state);
        }
        removeWebRecord(paths, profile);
        const logFile = webLogFile(paths, profile);
        const launched = await launchDshWeb(profile, { command, dshHome: paths.home, logFile, port });
        const record: DshWebRecord = {
          profile,
          pid: launched.pid,
          url: launched.url,
          logFile,
          startedAt: new Date().toISOString(),
          leaderStart: launched.leaderStart
        };
        writeWebRecord(paths, record);
        if (opts.json) {
          writeOut(JSON.stringify({ status: 'started', ...record, endpoint: endpointOf(record) }, null, 2) + '\n');
        } else {
          writeOut(
            `Started dsh web for profile ${profile} (pid ${record.pid})\n  URL: ${record.url}\n  Log: ${logFile}\nStop it with: dshenv web stop -p ${profile}\n`
          );
        }
      });
    });

  web
    .command('stop')
    .description('Stop the dsh web that dshenv web start left running for a profile, with everything it started')
    .addOption(targetProfile({ singleDeclared: true }))
    .action(async (cmdOpts: { profile: string }) => {
      const opts = program.opts<CliOpts>();
      const paths = resolveCliPaths(opts);
      const { profile } = cmdOpts;
      const record = await withProfileLock(paths, profile, async () => {
        const current = readWebRecord(paths, profile);
        const state = current ? await dshWebState(current.pid, current.leaderStart) : 'stopped';
        if (current) {
          await stopRecorded(paths, current, state);
        }
        removeWebRecord(paths, profile);
        return current && (state === 'running' || state === 'leftover') ? current : null;
      });
      if (opts.json) {
        writeOut(JSON.stringify({ profile, status: record ? 'stopped' : 'not-running', ...(record ? { pid: record.pid } : {}) }, null, 2) + '\n');
      } else {
        writeOut(record ? `Stopped dsh web for profile ${profile} (pid ${record.pid})\n` : `No dsh web started by dshenv is running for profile ${profile}.\n`);
      }
    });

  web
    .command('list')
    .alias('status')
    .description('List the dsh web servers dshenv web start left running (never their token)')
    .addOption(filterProfile())
    .action(async (cmdOpts: { profile?: string }) => {
      const opts = program.opts<CliOpts>();
      const paths = resolveCliPaths(opts);
      const records = listWebRecords(paths).filter((record) => cmdOpts.profile === undefined || record.profile === cmdOpts.profile);
      const webs = await Promise.all(
        records.map(async (record) => {
          const state = await dshWebState(record.pid, record.leaderStart);
          return {
            profile: record.profile,
            pid: record.pid,
            running: state === 'running',
            state,
            endpoint: endpointOf(record),
            startedAt: record.startedAt,
            logFile: record.logFile
          };
        })
      );
      if (opts.json) {
        writeOut(JSON.stringify({ webs }, null, 2) + '\n');
        return;
      }
      if (webs.length === 0) {
        writeOut(cmdOpts.profile === undefined ? 'No dsh web started by dshenv.\n' : `No dsh web started by dshenv for profile ${cmdOpts.profile}.\n`);
        return;
      }
      for (const entry of webs) {
        writeOut(entry.running ? `${entry.profile}  running  pid ${entry.pid}  ${entry.endpoint}\n` : `${entry.profile}  ${stateText[entry.state]}  pid ${entry.pid}\n`);
      }
    });
}
