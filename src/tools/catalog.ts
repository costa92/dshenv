import type { ProfilePatch } from '../domain.js';
import { ValidationError } from '../errors.js';
import { getAtPath, setAtPath, unsetAtPath } from '../config/config.js';
import { overrideKey, parseEntryList } from '../profile-patches/entries.js';

export const TOOL_CATEGORIES = ['terminal', 'filesystem', 'network', 'code', 'orchestration', 'interaction', 'extend', 'other'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

// The model-facing tool packages, grouped as in the DSH architecture diagram.
const CATEGORY_BY_PACKAGE: Record<string, ToolCategory> = {
  'dsh-tool-bash': 'terminal',
  'dsh-tool-bash-persistent': 'terminal',
  'dsh-tool-pwsh': 'terminal',
  'dsh-tool-pwsh-persistent': 'terminal',
  'dsh-tool-terminal': 'terminal',
  'dsh-tool-fs': 'filesystem',
  'dsh-tool-fs-search': 'filesystem',
  'dsh-tool-str-replace-editor': 'filesystem',
  'dsh-tool-web': 'network',
  'dsh-tool-lsp': 'code',
  'dsh-tool-workflow': 'orchestration',
  'dsh-tool-ralph': 'orchestration',
  'dsh-tool-goal': 'orchestration',
  'dsh-tool-jobs': 'orchestration',
  'dsh-tool-todo': 'orchestration',
  'dsh-tool-subagent': 'orchestration',
  'dsh-tool-subagent-control': 'orchestration',
  'dsh-tool-subagent-control/list-agents': 'orchestration',
  'dsh-schedule': 'orchestration',
  'dsh-tool-ask-user': 'interaction',
  'dsh-plan-mode': 'interaction',
  'dsh-tool-present': 'interaction',
  'dsh-tool-session-query': 'extend',
  'dsh-tool-skill': 'extend',
  'dsh-tool-workspace-dependencies': 'extend',
  'dsh-tool-cordis': 'extend',
  'dsh-plugin-manager/tools': 'extend',
  'dsh-mcp-resources': 'extend'
};

// Unlisted tool packages still show up; policies such as dsh-tool-call-timeout-policy and subpaths are not tools.
const OTHER_TOOL = /^dsh-(experimental-)?tool-[a-z0-9-]+$/;
const NOT_TOOLS = new Set(['dsh-tool-call-timeout-policy']);

const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset';
const PRESET_REGISTRY_PACKAGE = '@deepseek-ai/dsh-agent-preset-registry';

export type ToolState = 'on' | 'off' | { offWhen: string };
export type ToolLocation = { kind: 'top' } | { kind: 'preset'; entry: string; preset: string; group?: string };

export interface ToolRow {
  id: string;
  name: string;
  category: ToolCategory;
  state: ToolState;
  location: ToolLocation;
}

export interface ToolTarget {
  location: ToolLocation;
  row: ProfilePatch;
}

export type ToolChange = { kind: 'enable' } | { kind: 'disable' } | { kind: 'set'; path: string; value: unknown } | { kind: 'unset'; path: string };

interface Preset {
  entry: ProfilePatch;
  id: string;
}

export function parseComposedProfile(dump: string): ProfilePatch[] {
  return parseEntryList(dump, 'dsh --dump-config output');
}

export function toolCategory(name: string): ToolCategory | null {
  if (!name.startsWith('@deepseek-ai/')) return null;
  const pkg = name.slice('@deepseek-ai/'.length);
  if (NOT_TOOLS.has(pkg)) return null;
  return CATEGORY_BY_PACKAGE[pkg] ?? (OTHER_TOOL.test(pkg) ? 'other' : null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stateOf(row: ProfilePatch): ToolState {
  const disabled = row.disabled;
  if (disabled === undefined || disabled === false) return 'on';
  if (isRecord(disabled) && typeof disabled.__jsExpr === 'string') return { offWhen: disabled.__jsExpr };
  return 'off';
}

function presetsOf(tree: ProfilePatch[]): Preset[] {
  return tree.flatMap((entry) =>
    entry.name === PRESET_PACKAGE && isRecord(entry.config) && typeof entry.config.id === 'string' && Array.isArray(entry.config.plugins)
      ? [{ entry, id: entry.config.id }]
      : []
  );
}

function defaultPresetId(tree: ProfilePatch[], presets: Preset[]): string | undefined {
  const registry = tree.find((entry) => entry.name === PRESET_REGISTRY_PACKAGE);
  const config = isRecord(registry?.config) ? registry.config : {};
  // As DSH's AgentPresetRegistry: the selected default wins while mode selection is on, which it is unless set false.
  const selected = config.modeSelectionEnabled !== false && typeof config.selectedDefault === 'string' ? config.selectedDefault : undefined;
  return selected ?? (typeof config.default === 'string' ? config.default : undefined) ?? presets[0]?.id;
}

// Rows in a list and in the cordis groups nested in it, with the group each sits in.
function walkRows(rows: unknown, visit: (row: ProfilePatch, group: string | undefined) => void, group?: string): void {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    visit(row, group);
    if (row.group === true && Array.isArray(row.config)) {
      walkRows(row.config, visit, typeof row.id === 'string' ? row.id : group);
    }
  }
}

function toolRows(rows: unknown, location: (group: string | undefined) => ToolLocation): ToolRow[] {
  const tools: ToolRow[] = [];
  walkRows(rows, (row, group) => {
    const category = typeof row.name === 'string' ? toolCategory(row.name) : null;
    if (category && typeof row.id === 'string') {
      tools.push({ id: row.id, name: row.name as string, category, state: stateOf(row), location: location(group) });
    }
  });
  return tools;
}

function findPreset(presets: Preset[], name: string): Preset {
  const preset = presets.find((candidate) => candidate.id === name || candidate.entry.id === name);
  if (!preset) {
    const known = presets.map((candidate) => candidate.id).join(', ');
    throw new ValidationError(`No agent preset '${name}' in this profile${known ? `; presets: ${known}` : ''}`);
  }
  return preset;
}

function presetLocation(preset: Preset): (group: string | undefined) => ToolLocation {
  return (group) => ({ kind: 'preset', entry: preset.entry.id as string, preset: preset.id, ...(group ? { group } : {}) });
}

// By default: the tools an agent of the default preset gets, plus the profile-wide ones it does not restate.
export function listTools(tree: ProfilePatch[], options: { preset?: string; all?: boolean } = {}): ToolRow[] {
  const presets = presetsOf(tree);
  const top = toolRows(tree, () => ({ kind: 'top' }));
  if (options.all) {
    return [...top, ...presets.flatMap((preset) => toolRows((preset.entry.config as Record<string, unknown>).plugins, presetLocation(preset)))];
  }
  const presetName = options.preset ?? defaultPresetId(tree, presets);
  if (presetName === undefined) {
    return top;
  }
  const preset = findPreset(presets, presetName);
  const inPreset = toolRows((preset.entry.config as Record<string, unknown>).plugins, presetLocation(preset));
  const restated = new Set(inPreset.map((tool) => tool.id));
  return [...top.filter((tool) => !restated.has(tool.id)), ...inPreset];
}

// The config keys DSH composes for a plugin package, from any row that loads it; empty when no row has a config map.
export function pluginConfigKeys(tree: ProfilePatch[], packageName: string): string[] {
  const keys = new Set<string>();
  walkRows(tree, (row) => {
    if (row.name === packageName && isRecord(row.config)) {
      for (const key of Object.keys(row.config)) keys.add(key);
    }
  });
  return [...keys].sort();
}

// The config DSH composes for a plugin package: the row with the patch's id, else the first row that loads it.
export function pluginRowConfig(tree: ProfilePatch[], packageName: string, id: string): Record<string, unknown> | undefined {
  let byId: ProfilePatch | undefined;
  let first: ProfilePatch | undefined;
  walkRows(tree, (row) => {
    if (row.name !== packageName) return;
    first ??= row;
    if (byId === undefined && row.id === id) byId = row;
  });
  const row = byId ?? first;
  if (row === undefined) return undefined;
  return isRecord(row.config) ? structuredClone(row.config) : {};
}

function findRow(rows: unknown, id: string): ProfilePatch | undefined {
  let found: ProfilePatch | undefined;
  walkRows(rows, (row) => {
    if (found === undefined && row.id === id) found = row;
  });
  return found;
}

// The row tools list shows: the chosen preset's (asked for, else the default) when it holds the tool, else the
// profile-wide one. A tool only another preset holds needs --preset, so a write never lands in an unexpected agent.
export function locateTool(tree: ProfilePatch[], id: string, presetName?: string): ToolTarget {
  const presets = presetsOf(tree);
  const chosen = presetName !== undefined ? findPreset(presets, presetName) : presets.find((preset) => preset.id === defaultPresetId(tree, presets));
  const holders = presets.filter((preset) => findRow((preset.entry.config as Record<string, unknown>).plugins, id));
  if (chosen && holders.includes(chosen)) {
    return presetTarget(chosen, id);
  }
  const row = findRow(tree, id);
  if (row) {
    return { location: { kind: 'top' }, row };
  }
  if (holders.length > 0) {
    const where = holders.map((holder) => holder.id).join(', ');
    throw new ValidationError(`Tool '${id}' is not in preset '${chosen?.id}'; it is in ${where}: pass --preset ${holders[0].id}`);
  }
  throw new ValidationError(`Tool '${id}' is not part of this profile; install its package first (dshenv install)`);
}

function presetTarget(preset: Preset, id: string): ToolTarget {
  let target: ToolTarget | undefined;
  walkRows((preset.entry.config as Record<string, unknown>).plugins, (row, group) => {
    if (target === undefined && row.id === id) target = { location: presetLocation(preset)(group), row };
  });
  return target!;
}

function applyChange(row: ProfilePatch, change: ToolChange, baseConfig: unknown): ProfilePatch {
  if (change.kind === 'enable' || change.kind === 'disable') {
    return { ...row, disabled: change.kind === 'disable' };
  }
  if (baseConfig !== undefined && !isRecord(baseConfig)) {
    throw new ValidationError(`The config of '${String(row.id)}' is not a map, so a key path cannot be set in it`);
  }
  // DSH replaces a row's whole config with the patched one, so the patch restates every key.
  const config = structuredClone(baseConfig ?? {});
  if (change.kind === 'unset') {
    if (getAtPath(config, change.path) === undefined || !unsetAtPath(config, change.path)) {
      throw new ValidationError(`The config of '${String(row.id)}' has no '${change.path}'`);
    }
    return { ...row, config };
  }
  return { ...row, config: setAtPath(config, change.path, change.value) };
}

// The manifest entry that makes the change: a small entry for a top-level row, the whole preset for a preset row.
export function toolPatch(tree: ProfilePatch[], declared: ProfilePatch[], target: ToolTarget, change: ToolChange): ProfilePatch {
  if (target.location.kind === 'top') {
    const id = target.row.id as string;
    const existing = declared.find((entry) => overrideKey(entry) === id);
    const base = existing ?? { id, name: target.row.name };
    return applyChange(base, change, existing?.config ?? target.row.config);
  }
  const location = target.location;
  const presetRow = tree.find((entry) => entry.id === location.entry)!;
  const existing = declared.find((entry) => overrideKey(entry) === location.entry);
  const config = structuredClone((existing?.config ?? presetRow.config) as Record<string, unknown>);
  let replaced = false;
  const replace = (rows: unknown): unknown =>
    Array.isArray(rows)
      ? rows.map((row) => {
          if (!isRecord(row)) return row;
          if (!replaced && row.id === target.row.id) {
            replaced = true;
            return applyChange(row, change, row.config);
          }
          return row.group === true && Array.isArray(row.config) ? { ...row, config: replace(row.config) } : row;
        })
      : rows;
  config.plugins = replace(config.plugins);
  if (!replaced) {
    throw new ValidationError(`Preset '${location.preset}' declared in the manifest no longer holds tool '${String(target.row.id)}'`);
  }
  return { ...(existing ?? { id: location.entry }), name: presetRow.name, config };
}

export function isPresetPatch(entry: ProfilePatch): boolean {
  return entry.name === PRESET_PACKAGE && entry.config !== undefined;
}

// The row as the manifest leaves it: its own patch assigned over it, or its copy inside a declared preset.
export function declaredToolRow(tree: ProfilePatch[], declared: ProfilePatch[], target: ToolTarget): ProfilePatch {
  const location = target.location;
  if (location.kind === 'top') {
    const existing = declared.find((entry) => overrideKey(entry) === target.row.id);
    return existing ? { ...target.row, ...existing } : target.row;
  }
  const preset = declared.find((entry) => overrideKey(entry) === location.entry);
  return (isRecord(preset?.config) && findRow(preset.config.plugins, target.row.id as string)) || target.row;
}
