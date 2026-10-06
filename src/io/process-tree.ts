import * as fs from 'node:fs';
import { execa, execaSync } from 'execa';

const FORCE_KILL_AFTER_MS = 5000;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Signalling only the direct child would leave the package manager it started still writing the profile.
// Returns the pids it stopped once the whole tree is gone, so dshenv cannot exit before its SIGKILL is sent.
export async function killProcessTree(pid: number): Promise<number[]> {
  if (process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false });
    return [pid];
  }
  // Collected before any signal: once a parent exits, its children are reparented and no longer traceable.
  const tree = [pid, ...descendantsOf(pid)];
  let pids = tree;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    signalAll(pids, signal);
    const deadline = Date.now() + FORCE_KILL_AFTER_MS;
    // Dropping each pid as soon as it is gone keeps SIGKILL from reaching a process that later reuses it.
    while ((pids = pids.filter(processAlive)).length > 0 && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (pids.length === 0) break;
  }
  return tree;
}

// execa's own timeout signals only the direct child; a grandchild (dsh under `pnpm --dir <source> dsh`) keeps the
// output pipes open, and execa waits for them. An abort stops the tree the same way.
export async function awaitWithTreeTimeout<T>(
  subprocess: Promise<T> & { pid?: number },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ result: T; timedOut: boolean; killed: number[] }> {
  let timedOut = false;
  let killing: Promise<number[]> | undefined;
  const kill = () => {
    if (subprocess.pid !== undefined && !killing) {
      killing = killProcessTree(subprocess.pid);
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted) kill();
  try {
    const result = await subprocess;
    return { result, timedOut, killed: (await killing) ?? [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
}

// [pid, ppid] of every process: from ps, else (a slim container image has no ps) from /proc on Linux.
function processTable(): Array<[number, number]> {
  const res = execaSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { reject: false });
  if (res.exitCode === 0) {
    return String(res.stdout ?? '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]);
  }
  const table: Array<[number, number]> = [];
  for (const entry of fs.existsSync('/proc') ? fs.readdirSync('/proc') : []) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      // The command name may hold spaces and parentheses; the state and ppid follow its last ')'.
      table.push([Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])]);
    } catch {
      // exited meanwhile
    }
  }
  return table;
}

function descendantsOf(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of processTable()) {
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

// A killed process its parent never reaps (dshenv as PID 1 in a container) stays a zombie, which signal 0 still reaches.
export function isZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.charAt(stat.lastIndexOf(')') + 2) === 'Z';
  } catch {
    return false;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  }
}
