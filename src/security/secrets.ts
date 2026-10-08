import * as crypto from 'node:crypto';
import type { ProfilePatch } from '../domain.js';
import { hasEmbeddedCredentials } from '../manifest/schema.js';
import { describeProfilePatch } from '../profile-patches/entries.js';

// DSH's MCP client sends every header to the server verbatim; authorization ones are named many ways.
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

// What a credential key ends with once separators are dropped and case ignored: OPENAI_API_KEY, clientSecret, GH_PAT.
const CREDENTIAL_SUFFIX = /(?:apikey|secret|secretkey|privatekey|accesskey|password|passwd|token|authorization|credentials?)$/;
// A count or a limit of tokens, not one: maxToken, min_token.
const LIMIT_PREFIX = /^(?:max|min)/;

function keyWords(key: string): string[] {
  return key.split(/[_\-\s.]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter((word) => word !== '');
}

// apiKey, clientSecret, OPENAI_API_KEY; a key ending in Env (apiKeyEnv) names an environment variable instead.
export function isCredentialKey(key: string): boolean {
  const words = keyWords(key).map((word) => word.toLowerCase());
  if (words.length === 0 || words.at(-1) === 'env') return false;
  if (words.at(-1) === 'pat') return true;
  const joined = words.join('');
  return CREDENTIAL_SUFFIX.test(joined) && !LIMIT_PREFIX.test(joined);
}

// A password may be written as a YAML number; a token count may not, so only these keys take numbers.
function isPasswordKey(key: string): boolean {
  return /pass(?:word|wd)$/.test(keyWords(key).join('').toLowerCase());
}

export interface PlaintextSecret {
  path: string;
  // A hash of the value, to tell a credential already shared from a new one without keeping the value.
  digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent === '' ? key : `${parent}.${key}`;
}

type Sensitivity = 'none' | 'strings' | 'values';

function sensitivityOf(key: string): Sensitivity {
  return isPasswordKey(key) ? 'values' : isCredentialKey(key) ? 'strings' : 'none';
}

// Paths of the credentials in a value: non-empty strings under credential keys, URLs carrying a password or token,
// and every header of an MCP client row. Never the values, which must not reach output.
export function findPlaintextSecrets(value: unknown, path = ''): PlaintextSecret[] {
  const found: PlaintextSecret[] = [];
  const add = (at: string, literal: string) => found.push({ path: at, digest: crypto.createHash('sha256').update(literal).digest('hex') });
  const visit = (node: unknown, at: string, sensitive: Sensitivity): void => {
    if (typeof node === 'string') {
      if (node !== '' && (sensitive !== 'none' || hasEmbeddedCredentials(node))) add(at, node);
      return;
    }
    if (typeof node === 'number' || typeof node === 'bigint') {
      if (sensitive === 'values') add(at, String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, childPath(at, index), sensitive));
      return;
    }
    if (!isRecord(node)) return;
    // A credential key covers its own value or list of values; the keys of an object below it speak for themselves.
    const mcpConfig = node.name === MCP_CLIENT_PACKAGE ? node.config : undefined;
    for (const [key, child] of Object.entries(node)) {
      const childAt = childPath(at, key);
      if (child === mcpConfig && isRecord(child) && isRecord(child.headers)) {
        for (const [configKey, configValue] of Object.entries(child)) {
          if (configKey === 'headers') {
            for (const [name, header] of Object.entries(configValue as Record<string, unknown>)) visit(header, childPath(childPath(childAt, configKey), name), 'strings');
          } else {
            visit(configValue, childPath(childAt, configKey), sensitivityOf(configKey));
          }
        }
      } else {
        visit(child, childAt, sensitivityOf(key));
      }
    }
  };
  visit(value, path, 'none');
  return found;
}

interface PatchedDocument {
  profiles?: Record<string, { plugins?: Record<string, { patches?: unknown[] }>; patches?: ProfilePatch[] }>;
  patches?: ProfilePatch[];
}

export interface DocumentSecret {
  // "target / entry / path"; the value stays out.
  location: string;
  digest: string;
}

// Where a manifest or overlay holds plaintext credentials.
export function documentSecrets(doc: PatchedDocument): DocumentSecret[] {
  const found: DocumentSecret[] = [];
  const add = (where: string, entry: unknown) => {
    for (const { path, digest } of findPlaintextSecrets(entry)) found.push({ location: `${where} / ${path}`, digest });
  };
  for (const entry of doc.patches ?? []) add(`the global patches / ${describeProfilePatch(entry)}`, entry);
  for (const [profile, declared] of Object.entries(doc.profiles ?? {})) {
    for (const entry of declared.patches ?? []) add(`profile '${profile}' / ${describeProfilePatch(entry)}`, entry);
    for (const [alias, plugin] of Object.entries(declared.plugins ?? {})) {
      for (const patch of plugin.patches ?? []) add(`profile '${profile}' / plugin ${alias}`, patch);
    }
  }
  return found;
}

export const ENV_KEY_ADVICE = 'use an *Env key naming an environment variable instead, such as apiKeyEnv';
