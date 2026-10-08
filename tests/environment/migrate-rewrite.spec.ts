import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { rewritePath } from '../../src/environment/migrate.js';

describe('rewritePath', () => {
  const from = path.join(path.sep, 'Users', 'Me', 'envctl');
  const to = path.join(path.sep, 'data', 'envctl');

  it('moves a path under the old envctl and leaves others alone', () => {
    expect(rewritePath(path.join(from, 'sources', 'x'), [from], to, false)).toBe(path.join(to, 'sources', 'x'));
    expect(rewritePath(`${from}-other`, [from], to, false)).toBe(`${from}-other`);
  });

  it('ignores case where the file system does, as on Windows', () => {
    const spelled = path.join(path.sep, 'users', 'me', 'ENVCTL', 'sources', 'x');
    expect(rewritePath(spelled, [from], to, false)).toBe(spelled);
    expect(rewritePath(spelled, [from], to, true)).toBe(path.join(to, 'sources', 'x'));
  });
});
