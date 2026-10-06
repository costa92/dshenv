import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import { CapabilityError, DegradedError, ValidationError } from '../errors.js';
import { awaitWithTreeTimeout } from '../io/process-tree.js';
import { parseDshVersion } from './version.js';

export interface CommandSpec {
  file: string;
  args: string[];
  cwd?: string;
}

export interface ResolveDshCommandInput {
  cliHarnessSource?: string;
  manifestHarnessSource?: string;
  envDshCli?: string;
  which?: (cmd: string) => string | null;
  sourceDirExists?: (dir: string) => boolean;
}

export function resolveDshCommand(input?: ResolveDshCommandInput): CommandSpec | null {
  const checkExists = input?.sourceDirExists ?? ((dir: string) => {
    try {
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  const fromSource = (sourceDir: string): CommandSpec => ({
    file: 'pnpm',
    // --silent keeps pnpm's script banner out of stdout, which callers parse (--version, --dump-config YAML).
    args: ['--silent', '--dir', sourceDir, 'dsh'],
    cwd: sourceDir
  });

  // The command runs with the source as its cwd and also gets --dir, so a relative path would be resolved twice.
  const cliSource = input?.cliHarnessSource && !path.isAbsolute(input.cliHarnessSource)
    ? path.resolve(input.cliHarnessSource)
    : input?.cliHarnessSource;
  // A source asked for by name, on this command line, wins over DSH_CLI and must not quietly become another DSH.
  if (cliSource) {
    if (!checkExists(cliSource)) {
      throw new ValidationError(`Harness source not found: ${cliSource}`);
    }
    return fromSource(cliSource);
  }

  const envDshCli = input?.envDshCli ?? process.env.DSH_CLI;
  if (envDshCli && envDshCli.trim().length > 0) {
    const trimmed = envDshCli.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
          return {
            file: parsed[0],
            args: parsed.slice(1)
          };
        }
      } catch {
        // Fallback to literal execution if JSON parse fails
      }
    }
    // Literal single executable (NO shell expansion)
    return {
      file: trimmed,
      args: []
    };
  }

  // The manifest's source may live on another machine, so one missing here falls through to PATH.
  const sourceDir = input?.manifestHarnessSource;
  if (sourceDir && checkExists(sourceDir)) {
    return fromSource(sourceDir);
  }

  const checkWhich = input?.which ?? ((cmd: string) => findOnPath(cmd));

  const dshPath = checkWhich('dsh');
  if (dshPath) {
    return {
      file: dshPath,
      args: []
    };
  }

  return null;
}

// Windows separates PATH with ';' and finds commands through PATHEXT, e.g. the dsh.cmd npm installs.
export function findOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const windows = platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean);
  const extensions = windows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const fullPath = path.join(dir, `${cmd}${extension}`);
      try {
        if (fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // not here
      }
    }
  }
  return null;
}

export interface ProbeResult {
  version: string;
  raw: string;
}

class CommandNotFound extends Error {}

export async function probeDsh(
  cmd: CommandSpec,
  runner?: (file: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>,
  timeoutMs = 10000
): Promise<ProbeResult> {
  const run = runner ?? (async (file, args, opts) => {
    const { result, timedOut } = await awaitWithTreeTimeout(
      execa(file, args, { ...opts, shell: false, reject: false, maxBuffer: 1024 * 1024 }),
      timeoutMs
    );
    if (!timedOut && (result as { code?: string }).code === 'ENOENT') {
      throw new CommandNotFound();
    }
    if (timedOut || result.failed) {
      throw new Error('DSH probe failed');
    }
    return result;
  });

  // A path that is not there means no DSH, as when none is on PATH; the path itself stays out of the message.
  if (!runner && path.isAbsolute(cmd.file) && !fs.existsSync(cmd.file)) {
    throw new CapabilityError('The DSH CLI that DSH_CLI or --harness-source names does not exist');
  }

  let res: { stdout: string; stderr: string };
  try {
    res = await run(cmd.file, [...cmd.args, '--version'], {
      cwd: cmd.cwd
    });
  } catch (err) {
    // Not found is the same as no DSH at all (exit 4), not a DSH that failed to run.
    if (err instanceof CommandNotFound) {
      throw new CapabilityError(cmd.cwd ? 'pnpm, which runs DSH from --harness-source or harness.sourceDir, was not found' : 'The DSH CLI that DSH_CLI names was not found');
    }
    throw new DegradedError('DSH runtime probe execution failed');
  }

  const output = res.stdout || res.stderr || '';
  // Ignore command echoes; only a complete, strictly valid version line is evidence.
  const version = output.split(/\r?\n/).find(line => parseDshVersion(line) !== null);
  if (version === undefined) {
    throw new DegradedError('Unable to parse DSH runtime version');
  }

  return {
    version,
    raw: output.trim()
  };
}
