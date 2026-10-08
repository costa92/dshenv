import { describe, it, expect } from 'vitest';
import { parseDumpDiagnostics } from '../../src/dsh/dump-check.js';

describe('parseDumpDiagnostics', () => {
  it('reads the patches DSH skipped, by layer, and the bundles it skipped', () => {
    const stderr = [
      'dsh: skipping profile bundle "@acme/broken": Error: Cannot find module \'@acme/broken\'',
      'dsh: [@deepseek-ai/dsh-base] patch: entry "time-context" not found',
      'dsh: [/home/me/.dsh/profiles/web/cordis.patch.yml] patch: entry "nosuch" not found',
      'dsh: [/home/me/.dsh/cordis.patch.yml] patch insert: entry "tools" not found',
      'dsh: [/home/me/.dsh/profiles/web/cordis.patch.yml] patch: name mismatch for "locale" (expected "a", got "b"), skipping',
      'something else'
    ].join('\n');
    expect(parseDumpDiagnostics(stderr, 'web', '/home/me/.dsh')).toEqual({
      unmatched: [
        { profile: 'web', layer: '@deepseek-ai/dsh-base', id: 'time-context' },
        { profile: 'web', layer: 'profile', id: 'nosuch' },
        { profile: 'web', layer: 'global', id: 'tools' },
        { profile: 'web', layer: 'profile', id: 'locale' }
      ],
      skippedBundles: [{ profile: 'web', package: '@acme/broken', reason: "Error: Cannot find module '@acme/broken'" }]
    });
  });

  it('tells the layers apart by the DSH_HOME the dump ran with, whatever its directories are called', () => {
    const home = '/srv/profiles/dsh';
    const stderr = `dsh: [${home}/cordis.patch.yml] patch: entry "a" not found\ndsh: [${home}/profiles/web/cordis.patch.yml] patch: entry "b" not found\n`;
    expect(parseDumpDiagnostics(stderr, 'web', home).unmatched.map((item) => item.layer)).toEqual(['global', 'profile']);
  });
});
