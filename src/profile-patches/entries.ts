import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import type { ProfilePatch } from '../domain.js';
import { ValidationError } from '../errors.js';
import { flowArrayAsBlock, jsTags as customTags, splicePluginBlocks, stringifyWithJs } from '../patch/patch.js';

// A profile's own entries share the plugin block markers under an alias no plugin may take.
export const PROFILE_PATCHES_ALIAS = '@profile';

// $DSH_HOME/cordis.patch.yml goes through the profile patch code as one more target; no profile name starts with @.
export const HOME_PATCH_TARGET = '@home';

export function describePatchTarget(target: string): string {
  return target === HOME_PATCH_TARGET ? 'the global cordis.patch.yml' : `profile '${target}'`;
}


const BLOCK = /# dshenv:begin profile=([^\s]+) plugin=([^\s]+)(?: digest=([^\s]+))?\n([\s\S]*?)# dshenv:end profile=\1 plugin=\2\n?/g;

export interface ProfilePatchState {
  // The profile block as it is now; isDigestValid is false once DSH edited it in place.
  block: { entries: ProfilePatch[]; digest?: string; isDigestValid: boolean } | null;
  // Entries outside every managed block, in file order: the ones DSH or the user wrote.
  unmanaged: ProfilePatch[];
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function digestProfilePatches(entries: ProfilePatch[]): string {
  const canonical = YAML.stringify(sortKeys(entries), { indent: 2, lineWidth: 0 }).trimEnd();
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function parseSequence(content: string, where: string): { doc: YAML.Document; items: YAML.Node[] } {
  const doc = YAML.parseDocument(content, { customTags });
  const root = doc.contents;
  if (doc.errors.length > 0 || (root !== null && !YAML.isSeq(root) && !(YAML.isScalar(root) && root.value === null))) {
    throw new ValidationError(`${where} must hold a single top-level YAML array of patch entries`);
  }
  return { doc, items: YAML.isSeq(root) ? (root.items as YAML.Node[]) : [] };
}

// A cordis entry list such as `dsh --dump-config` prints, with `!!js` values as { __jsExpr }.
export function parseEntryList(content: string, where: string): ProfilePatch[] {
  return (parseSequence(content, where).doc.toJS() as ProfilePatch[] | null) ?? [];
}

function blockRanges(content: string): Array<{ profile: string; plugin: string; digest?: string; payload: string; start: number; end: number }> {
  return [...content.matchAll(BLOCK)].map((match) => ({
    profile: match[1],
    plugin: match[2],
    digest: match[3],
    payload: match[4],
    start: match.index,
    end: match.index + match[0].length
  }));
}

function unmanagedItems(content: string): Array<{ node: YAML.Node; doc: YAML.Document }> {
  const { doc, items } = parseSequence(content, 'cordis.patch.yml');
  const blocks = blockRanges(content);
  return items
    .filter((node) => !blocks.some((block) => node.range![0] >= block.start && node.range![0] < block.end))
    .map((node) => ({ node, doc }));
}

export function readProfilePatchState(content: string, profileName: string): ProfilePatchState {
  const unmanaged = unmanagedItems(content).map(({ node, doc }) => node.toJS(doc) as ProfilePatch);
  const found = blockRanges(content).find((block) => block.profile === profileName && block.plugin === PROFILE_PATCHES_ALIAS);
  if (!found) {
    return { block: null, unmanaged };
  }
  const { doc, items } = parseSequence(found.payload, 'The dshenv profile block in cordis.patch.yml');
  const entries = items.map((node) => node.toJS(doc) as ProfilePatch);
  return {
    block: { entries, digest: found.digest, isDigestValid: found.digest === digestProfilePatches(entries) },
    unmanaged
  };
}

export function renderProfileBlock(profileName: string, entries: ProfilePatch[]): string {
  // The manifest sorts keys; in the file DSH users read, id and name lead as in DSH's own entries.
  const ordered = entries.map(({ id, name, ...rest }) => ({ ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}), ...rest }));
  return [
    `# dshenv:begin profile=${profileName} plugin=${PROFILE_PATCHES_ALIAS} digest=${digestProfilePatches(entries)}`,
    stringifyWithJs(ordered),
    `# dshenv:end profile=${profileName} plugin=${PROFILE_PATCHES_ALIAS}`
  ].join('\n');
}

export function replaceProfileBlock(content: string, profileName: string, entries: ProfilePatch[]): string {
  const block = entries.length > 0 ? `${renderProfileBlock(profileName, entries)}\n` : '';
  return splicePluginBlocks(content, profileName, PROFILE_PATCHES_ALIAS, block);
}

// Cuts every entry outside the managed blocks out of the text, so comments and blocks stay byte for byte.
export function removeUnmanagedEntries(content: string): string {
  const base = flowArrayAsBlock(content) ?? content;
  const items = unmanagedItems(base);
  if (items.length === 0) {
    return content;
  }
  let result = base;
  for (const { node } of [...items].reverse()) {
    const start = result.lastIndexOf('\n', node.range![0] - 1) + 1;
    const lineEnd = result.indexOf('\n', node.range![2] - 1);
    const end = lineEnd === -1 ? result.length : lineEnd + 1;
    result = result.slice(0, start) + result.slice(end);
  }
  if (result.replace(/^\s*#.*$/gm, '').trim() === '') {
    return `${result}${result === '' || result.endsWith('\n') ? '' : '\n'}[]\n`;
  }
  return result;
}

// The id an entry overrides; insert lists add rows instead and have none.
export function overrideKey(entry: ProfilePatch): string | undefined {
  return entry.insert === undefined && typeof entry.id === 'string' ? entry.id : undefined;
}

// Later entries assign their keys over an earlier entry with the same id, as DSH's loader applies them.
export function mergeDshPatches(block: ProfilePatch[], unmanaged: ProfilePatch[]): ProfilePatch[] {
  const result = block.map((entry) => ({ ...entry }));
  for (const entry of unmanaged) {
    const key = overrideKey(entry);
    const target = key === undefined ? undefined : result.find((candidate) => overrideKey(candidate) === key);
    if (target) {
      Object.assign(target, entry);
    } else {
      result.push({ ...entry });
    }
  }
  return result;
}

export function containsLocalPath(value: unknown): boolean {
  const insert = value !== null && typeof value === 'object' ? (value as { insert?: unknown }).insert : undefined;
  return (Array.isArray(insert) && insert.some(insertsRelativeModule)) || containsAbsolutePath(value);
}

function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') {
    return path.isAbsolute(value) || path.win32.isAbsolute(value) || /^~[\\/]/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}

// DSH resolves an inserted row's `./` or `../` name beside the patch file, so it names a module on this machine.
function insertsRelativeModule(row: unknown): boolean {
  if (row === null || typeof row !== 'object') return false;
  const { name, group, config } = row as { name?: unknown; group?: unknown; config?: unknown };
  if (typeof name === 'string' && (name.startsWith('./') || name.startsWith('../'))) return true;
  return Boolean(group) && Array.isArray(config) && config.some(insertsRelativeModule);
}

// Entries with machine-local paths, plus every later entry targeting an id one of them inserts: overlay entries merge
// after the base ones, so a dependent left in the base would run before the entry it targets exists.
export function localPatchEntries(entries: ProfilePatch[]): ProfilePatch[] {
  const inserted = new Set<string>();
  const collect = (value: unknown): void => {
    for (const child of Array.isArray(value) ? value : []) {
      if (child !== null && typeof child === 'object') {
        if (typeof child.id === 'string') inserted.add(child.id);
        if (child.group) collect(child.config);
      }
    }
  };
  return entries.filter((entry) => {
    if (!containsLocalPath(entry) && !(typeof entry.id === 'string' && inserted.has(entry.id))) {
      return false;
    }
    collect(entry.insert);
    return true;
  });
}

// Overlay entries replace a base entry with the same id in place, remove it, or are appended.
export function mergeProfilePatches(base: ProfilePatch[], overlay: ProfilePatch[]): ProfilePatch[] {
  const result = [...base];
  for (const entry of overlay) {
    const key = overrideKey(entry);
    const index = key === undefined ? -1 : result.findIndex((candidate) => overrideKey(candidate) === key);
    if (entry.remove === true) {
      // The base may have dropped it since, e.g. through a team sync.
      if (index !== -1) result.splice(index, 1);
    } else if (index !== -1) {
      result[index] = entry;
    } else {
      result.push(entry);
    }
  }
  return result;
}

// The overlay entries that turn `base` into `desired` under mergeProfilePatches.
export function diffProfilePatches(base: ProfilePatch[], desired: ProfilePatch[]): ProfilePatch[] {
  const unused = [...base];
  const overlay: ProfilePatch[] = [];
  for (const entry of desired) {
    const index = unused.findIndex((candidate) => isDeepStrictEqual(candidate, entry));
    if (index !== -1) {
      unused.splice(index, 1);
    } else {
      overlay.push(entry);
    }
  }
  for (const entry of unused) {
    const key = overrideKey(entry);
    if (key === undefined) {
      throw new ValidationError('An insert entry of the base manifest was dropped in DSH; an overlay cannot remove it, so edit the base manifest');
    }
    if (!overlay.some((candidate) => overrideKey(candidate) === key)) {
      overlay.push({ id: key, remove: true });
    }
  }
  return overlay;
}

export function describeProfilePatch(entry: ProfilePatch): string {
  const key = overrideKey(entry);
  if (key !== undefined) return key;
  return typeof entry.id === 'string' ? `insert into ${entry.id}` : 'insert';
}
