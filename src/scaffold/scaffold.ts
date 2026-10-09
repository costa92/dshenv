import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationError } from '../errors.js';
import { PackageNameRegex } from '../manifest/schema.js';
import { renderTemplate, type RenderedFile } from './render.js';
import { COMPONENT_KINDS, ComponentNameRegex, PEER_RANGE, templateDir, type ComponentKind, type TemplateVariant } from './templates.js';

export interface ScaffoldOptions {
  kind: ComponentKind;
  name: string;
  dir?: string;
  packageName?: string;
  typescript?: boolean;
  loose?: boolean;
  dshHome: string;
  cwd: string;
}

export interface ScaffoldResult {
  dir: string;
  packageName?: string;
  files: string[];
  cleanup: () => void;
}

function validate(options: ScaffoldOptions): void {
  if (!COMPONENT_KINDS.includes(options.kind)) {
    throw new ValidationError(`Unknown component kind '${options.kind}'; expected skill, agent, tool or mcp`);
  }
  if (!ComponentNameRegex.test(options.name)) {
    throw new ValidationError(`Component name '${options.name}' must be kebab-case (lowercase letters, digits and single hyphens)`);
  }
  // path.resolve would read an empty --dir as the working directory, which nobody meant.
  if (options.dir !== undefined && options.dir.trim() === '') {
    throw new ValidationError('--dir must not be empty');
  }
  if (options.packageName !== undefined && !PackageNameRegex.test(options.packageName)) {
    throw new ValidationError(`Invalid package name '${options.packageName}'`);
  }
  if (options.typescript && options.kind !== 'tool') {
    throw new ValidationError('--typescript only applies to tool');
  }
  if (options.loose && options.kind !== 'skill') {
    throw new ValidationError('--loose only applies to skill');
  }
  if (options.loose && (options.dir !== undefined || options.packageName !== undefined)) {
    throw new ValidationError('--loose cannot be combined with --dir or --package');
  }
}

export function scaffoldComponent(options: ScaffoldOptions): ScaffoldResult {
  validate(options);
  const packageName = options.loose ? undefined : options.packageName ?? options.name;
  const vars = {
    name: options.name,
    package: packageName ?? options.name,
    toolName: options.name.replaceAll('-', '_'),
    peerRange: PEER_RANGE
  };

  let dir: string;
  let files: RenderedFile[];
  if (options.loose) {
    dir = path.join(options.dshHome, 'skills', options.name);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat) {
      throw new ValidationError(`Skill directory already exists: ${dir}`);
    }
    // A loose skill is the bundle's SKILL.md written straight into a default skill root.
    files = renderTemplate(templateDir('skill'), vars)
      .filter((file) => file.path === path.join('skills', options.name, 'SKILL.md'))
      .map((file) => ({ ...file, path: 'SKILL.md' }));
  } else {
    dir = path.resolve(options.cwd, options.dir ?? options.name);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new ValidationError(`Target is a symbolic link; pass the real directory path: ${dir}`);
    }
    if (stat && !stat.isDirectory()) {
      throw new ValidationError(`Target is not a directory: ${dir}`);
    }
    if (stat && fs.readdirSync(dir).length > 0) {
      throw new ValidationError(`Target directory is not empty: ${dir}`);
    }
    const variant: TemplateVariant = options.typescript ? 'tool-ts' : options.kind;
    files = renderTemplate(templateDir(variant), vars);
  }

  // Find the topmost ancestor of dir (including dir itself) that doesn't exist yet,
  // so cleanup can remove exactly what this run created, not just the leaf.
  let createdRoot: string | undefined;
  {
    let current = dir;
    for (;;) {
      if (fs.lstatSync(current, { throwIfNoEntry: false })) {
        break;
      }
      createdRoot = current;
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  const cleanup = (): void => {
    if (createdRoot) {
      fs.rmSync(createdRoot, { recursive: true, force: true });
      return;
    }
    for (const top of new Set(files.map((file) => file.path.split(path.sep)[0]))) {
      fs.rmSync(path.join(dir, top), { recursive: true, force: true });
    }
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, { flag: 'wx' });
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return { dir, packageName, files: files.map((file) => file.path), cleanup };
}
