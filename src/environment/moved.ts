import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationError } from '../errors.js';

// Left by migrate in the old envctl, holding the new location; without it a command that missed the move would start
// a fresh environment there.
export const MOVED_FILE = 'dshenv.moved';

export function assertEnvctlNotMoved(managerDir: string): void {
  const marker = path.join(managerDir, MOVED_FILE);
  let target: string;
  try {
    target = fs.readFileSync(marker, 'utf8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw new ValidationError(`Could not read ${marker}, which marks an envctl that dshenv migrate moved: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new ValidationError(
    `${managerDir} was moved to ${target || 'another location'} by dshenv migrate; set DSHENV_HOME=${target} or pass --envctl-dir ${target} ` +
      `(to start a new environment here instead, delete ${marker})`
  );
}
