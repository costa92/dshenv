import { DegradedError } from '../errors.js';

// Ctrl-C ends dshenv without running async cleanup, so a detached dsh web would outlive it and an apply would stop
// halfway. One handler runs every registered cleanup to the end and then lets the signal end dshenv as it would have;
// a second Ctrl-C meanwhile ends dshenv at once.
const INTERRUPTS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const interruptCleanups = new Set<() => Promise<void>>();
const signalExitHooks = new Set<() => void>();
let interrupting = false;

// Ending by the signal skips process 'exit' listeners, so what must happen on any exit runs here first.
function exitBy(signal: NodeJS.Signals): void {
  for (const name of INTERRUPTS) process.off(name, onInterrupt);
  for (const hook of signalExitHooks) {
    try {
      hook();
    } catch {
      // ending anyway
    }
  }
  process.kill(process.pid, signal);
}

// Runs a synchronous hook when dshenv ends by an interrupt; the returned function unregisters it.
export function onSignalExit(hook: () => void): () => void {
  signalExitHooks.add(hook);
  return () => signalExitHooks.delete(hook);
}

// The handler stays registered while the cleanups run: execa's exit hook re-raises the signal as soon as it is the
// last listener, which would end dshenv before any cleanup finished.
function onInterrupt(signal: NodeJS.Signals): void {
  if (interrupting) {
    exitBy(signal);
    return;
  }
  interrupting = true;
  const cleanups = [...interruptCleanups];
  interruptCleanups.clear();
  void Promise.allSettled(cleanups.map((cleanup) => cleanup())).then(() => exitBy(signal));
}

// Whether an interrupt is being handled; the signal, not the caller, ends dshenv then.
export function isInterrupting(): boolean {
  return interrupting;
}

// Registers a cleanup to run if dshenv is interrupted; the returned function unregisters it.
export function stopOnInterrupt(cleanup: () => Promise<void>): () => void {
  if (interruptCleanups.size === 0 && !interrupting) {
    for (const name of INTERRUPTS) process.on(name, onInterrupt);
  }
  interruptCleanups.add(cleanup);
  return () => {
    interruptCleanups.delete(cleanup);
    if (interruptCleanups.size === 0 && !interrupting) {
      for (const name of INTERRUPTS) process.off(name, onInterrupt);
    }
  };
}

// Stops apply between steps once dshenv is interrupted, so the failure path rolls back what it did so far.
export function assertNotInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DegradedError('Apply was interrupted');
  }
}
