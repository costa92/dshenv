import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ComponentKind = 'skill' | 'agent' | 'tool' | 'mcp';
export const COMPONENT_KINDS: readonly ComponentKind[] = ['skill', 'agent', 'tool', 'mcp'];
export type TemplateVariant = 'skill' | 'agent' | 'tool' | 'tool-ts' | 'mcp';

// DSH checks @deepseek-ai/dsh-* peers against its own version with prereleases included; templates need 0.1.7+ (agent presets, linked peer lookup).
// One range per minor: npm and pnpm match a prerelease such as 0.2.0-rc.2 only against a bound on its own version.
export const PEER_RANGE = '>=0.1.7-0 <0.2.0-0 || >=0.2.0-0 <0.3.0-0';
export const ComponentNameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Walks up from this module so both src/ (tsx) and the bundled lib/ find the package's templates.
export function templatesRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'templates');
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('dshenv templates directory not found');
    }
    dir = parent;
  }
}

export function templateDir(variant: TemplateVariant): string {
  return path.join(templatesRoot(), variant);
}
