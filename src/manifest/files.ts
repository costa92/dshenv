import * as YAML from 'yaml';
import type { z } from 'zod';
import { ValidationError } from '../errors.js';
import {
  ManifestSchema,
  LockSchema,
  StateSchema
} from './schema.js';
import { OverlaySchema } from '../overlay/schema.js';
import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState,
  CaptureDocument,
  EnvironmentOverlay,
  OwnedResources
} from '../domain.js';

export function hasInterpolation(content: string): boolean {
  return /\$\{[^}]+\}/.test(content);
}

export function parseYamlStrict(content: string): unknown {
  if (typeof content !== 'string') {
    throw new ValidationError('Expected string content for YAML parsing');
  }

  // Check for prohibited dynamic interpolations
  if (hasInterpolation(content)) {
    throw new ValidationError('Dynamic variable interpolations ${...} are not allowed in manifest');
  }

  const doc = YAML.parseDocument(content, {
    uniqueKeys: true,
    customTags: []
  });

  if (doc.errors && doc.errors.length > 0) {
    const errorMsg = doc.errors.map((e) => e.message).join('; ');
    throw new ValidationError(`YAML parsing error: ${errorMsg}`);
  }

  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 20 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`YAML parsing error: ${message}`);
  }

  try {
    JSON.stringify(raw);
  } catch {
    throw new ValidationError('YAML parsing error: cyclic aliases are not allowed');
  }

  return raw;
}

// Record key failures only say "Invalid key in record"; the reason lives in the nested issues.
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.')}: ${i.code === 'invalid_key' ? i.issues.map((nested) => nested.message).join(', ') : i.message}`)
    .join(', ');
}

export function loadManifest(content: string): EnvironmentManifest {
  const raw = parseYamlStrict(content);
  const res = ManifestSchema.safeParse(raw);
  if (!res.success) {
    const issues = describeIssues(res.error);
    throw new ValidationError(`Invalid manifest schema: ${issues}`);
  }
  return res.data as EnvironmentManifest;
}

export function loadLock(content: string): EnvironmentLock {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ValidationError(`Invalid JSON in lock file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = LockSchema.safeParse(raw);
  if (!res.success) {
    const issues = describeIssues(res.error);
    throw new ValidationError(`Invalid lock schema: ${issues}`);
  }
  return res.data as EnvironmentLock;
}

export function loadState(content: string): EnvironmentState {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ValidationError(`Invalid JSON in state file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = StateSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ValidationError(`Invalid state schema: ${issues}`);
  }
  return res.data as EnvironmentState;
}

// Replaces the given kinds of owned resources; a kind that owns nothing is left out, and so are empty resources.
export function withResources(state: EnvironmentState, owned: OwnedResources): EnvironmentState {
  const { resources: previous, ...rest } = state;
  const merged: OwnedResources = { ...previous, ...owned };
  const resources = Object.fromEntries(
    Object.entries(merged).filter(([, entries]) => entries !== undefined && Object.keys(entries).length > 0)
  ) as OwnedResources;
  return Object.keys(resources).length > 0 ? { ...rest, resources } : rest;
}

export function parseOverlay(content: string, file: string): EnvironmentOverlay {
  const raw = parseYamlStrict(content);
  const res = OverlaySchema.safeParse(raw);
  if (!res.success) {
    const issues = describeIssues(res.error);
    throw new ValidationError(`Invalid overlay schema in ${file}: ${issues}`);
  }
  return res.data as EnvironmentOverlay;
}

function sortKeys(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(sortKeys);
  }
  if (val !== null && typeof val === 'object') {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const k of keys) {
      sortedObj[k] = sortKeys((val as Record<string, unknown>)[k]);
    }
    return sortedObj;
  }
  return val;
}

export function serializeManifest(manifest: EnvironmentManifest): string {
  const sorted = sortKeys(manifest);
  const yamlString = YAML.stringify(sorted, { indent: 2, lineWidth: 0 });
  return yamlString.trimEnd() + '\n';
}

export function serializeOverlay(overlay: EnvironmentOverlay): string {
  const sorted = sortKeys(overlay);
  const yamlString = YAML.stringify(sorted, { indent: 2, lineWidth: 0 });
  return yamlString.trimEnd() + '\n';
}

export function serializeLock(lock: EnvironmentLock): string {
  const sorted = sortKeys(lock);
  return JSON.stringify(sorted, null, 2) + '\n';
}

export function serializeState(state: EnvironmentState): string {
  const sorted = sortKeys(state);
  return JSON.stringify(sorted, null, 2) + '\n';
}

export function serializeCaptureDocument(doc: CaptureDocument): string {
  const sorted = sortKeys(doc);
  const yamlString = YAML.stringify(sorted, { indent: 2, lineWidth: 0 });
  return yamlString.trimEnd() + '\n';
}
