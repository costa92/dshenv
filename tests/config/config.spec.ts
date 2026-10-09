import { describe, it, expect } from 'vitest';
import { parseConfigValue, setAtPath, getAtPath } from '../../src/config/config.js';
import { ValidationError } from '../../src/errors.js';

describe('config helpers', () => {
  it('should parse JSON values and leave plain text as string', () => {
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('12')).toBe(12);
    expect(parseConfigValue('"captain"')).toBe('captain');
    expect(parseConfigValue('captain')).toBe('captain');
  });

  it('should set and get nested config paths', () => {
    const next = setAtPath({ taskPlanning: 'off' }, 'nested.key', 'on');
    expect(next.taskPlanning).toBe('off');
    expect(getAtPath(next, 'nested.key')).toBe('on');
  });

  it('refuses a value JSON parsing would change or drop instead of taking it silently', () => {
    for (const raw of ['1e999', '-1e999', '12345678901234567890', '{"a":1e999}', '{"a":', '[1,', '{"__proto__":{"x":1}}', '{"a":{"constructor":1}}', '[{"prototype":1}]']) {
      expect(() => parseConfigValue(raw), raw).toThrow(ValidationError);
    }
    expect(parseConfigValue('1.5')).toBe(1.5);
    expect(parseConfigValue('9007199254740991')).toBe(9007199254740991);
    expect(parseConfigValue('"12345678901234567890"')).toBe('12345678901234567890');
    expect(parseConfigValue('{"a":[1,{"b":null}]}')).toEqual({ a: [1, { b: null }] });
  });
});
