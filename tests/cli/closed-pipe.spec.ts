import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { ignoreClosedPipe } from '../../src/cli.js';

describe('ignoreClosedPipe', () => {
  const failure = (code: string) => Object.assign(new Error(code), { code });

  it('swallows EPIPE, so `dshenv --help | head -1` ends without a stack trace and a running apply is not cut short', () => {
    const stream = new EventEmitter();
    ignoreClosedPipe(stream);
    expect(() => stream.emit('error', failure('EPIPE'))).not.toThrow();
  });

  it('still raises any other stream error', () => {
    const stream = new EventEmitter();
    ignoreClosedPipe(stream);
    expect(() => stream.emit('error', failure('EIO'))).toThrow('EIO');
  });
});
