import { isProfileOperation, type EnvironmentPlan, type EnvironmentStatusSummary, type ProfileOperation } from '../planner/plan.js';
import type { DshCapabilities } from '../dsh/capabilities.js';
import type { LockEntryDrift } from '../remote/lock-entries.js';
import { describeRemoteDrift, type RemoteFileDrift } from '../remote/ownership.js';
import { describeRestartReason, restartPackage, type RestartItem, type RestartSummary } from '../apply/restart-plan.js';
import type { RuntimeCheckItem } from '../runtime/compare.js';
import type { PatchTargetReport } from '../apply/patch-targets.js';
import { describeUnmatched } from '../dsh/dump-check.js';
import { HOME_PATCH_TARGET, PROFILE_PATCHES_ALIAS } from '../profile-patches/entries.js';

function restartAnnotation(op: ProfileOperation, restart: RestartSummary): string {
  const matches = (item: RestartItem): boolean =>
    item.profile === op.profile && item.package === restartPackage(op) && item.kind === op.kind;
  if (restart.notRequired.some(matches)) {
    return ' (no restart)';
  }
  const required = restart.required.find(matches);
  return required ? ` (restart required: ${describeRestartReason(required)})` : '';
}

export function renderPlan(plan: EnvironmentPlan, restart?: RestartSummary, heading = 'Planned operations:'): string {
  const lines: string[] = [];

  const pinned = (plan.pinnedPresets ?? []).length > 0
    ? ['', 'Pinned agent presets (DSH upgrades to them no longer apply; remove the patch to follow DSH again):', ...plan.pinnedPresets!.map((p) => `  ! [${p.profile}] ${p.id}`)]
    : [];
  // A warning in sync too: the profile entry is applied, then the global one replaces its fields.
  if ((plan.shadowedPatches ?? []).length > 0) {
    pinned.push('', "Profile patches the global cordis.patch.yml overrides (DSH takes the global entry's fields for these ids; change them in the manifest's top-level patches, not in DSH's UI):");
    pinned.push(...plan.shadowedPatches!.map((item) =>
      `  ! [${item.profile}] ${item.ids.join(', ')}${item.disabled ? ` (the global file sets disabled for ${item.disabled.join(', ')}, so DSH's plugin page cannot toggle it in this profile)` : ''}`));
  }
  if ((plan.retiredBundles ?? []).length > 0) {
    pinned.push('', 'Retired bundles (DSH 0.2.1 drops them from the profile on every load, so they stay drift; remove them from the manifest):');
    pinned.push(...plan.retiredBundles!.map((item) => `  ! [${item.profile}] ${item.alias} (${item.package}): ${item.reason}. Run: dshenv remove ${item.alias} -p ${item.profile}${item.layer === 'overlay' ? ' --layer overlay' : ''}`));
  }

  if (
    !plan.hasChanges &&
    plan.unmanaged.length === 0 &&
    plan.unverified.length === 0 &&
    plan.unmanagedPatches.length === 0 &&
    (plan.unmanagedHomePatches ?? []).length === 0 &&
    plan.unmanagedSkills.length === 0
  ) {
    return ['Environment is in sync with manifest. No changes planned.', ...pinned].join('\n') + '\n';
  }

  const profileOperations = plan.operations.filter(isProfileOperation);
  const skillOperations = plan.operations.filter((op) => op.resource === 'skill');
  if (profileOperations.length > 0) {
    lines.push(heading);
    for (const op of profileOperations) {
      const symbol = getOpSymbol(op.kind);
      let details = '';
      // Non-npm installs and source switches carry no version; the reason line says what changes.
      if (op.kind === 'install') {
        details = op.targetVersion ? `-> ${op.targetVersion}` : '';
      } else if (op.kind === 'update') {
        details = op.currentVersion || op.targetVersion ? `${op.currentVersion ?? '?'} -> ${op.targetVersion ?? '?'}` : '';
      } else if (op.kind === 'enable' || op.kind === 'disable') {
        details = `enabled: ${op.targetEnabled}`;
      } else if (op.kind === 'remove') {
        details = 'uninstall';
      } else if (op.kind === 'blocked') {
        details = `[BLOCKED: ${op.blockedReason ?? op.reason}]`;
      }
      const annotation = restart ? restartAnnotation(op, restart) : '';
      const target = op.resource === 'profile-patch' ? 'profile patches' : `${op.package} (${op.alias})`;
      lines.push(`  ${symbol} [${op.profile}] ${target} ${details}`.trimEnd() + annotation);
      if (op.reason) {
        lines.push(`      Reason: ${op.reason}`);
      }
    }
  }

  const homeOperations = plan.operations.filter((op) => op.resource === 'home-patch');
  if (homeOperations.length > 0) {
    if (profileOperations.length > 0) lines.push('');
    lines.push('Planned global patch changes ($DSH_HOME/cordis.patch.yml, every profile):');
    for (const op of homeOperations) {
      const details = op.kind === 'blocked' ? ` [BLOCKED: ${op.blockedReason ?? op.reason}]` : '';
      lines.push(`  ${getOpSymbol(op.kind)} [global] patches${details}`);
      lines.push(`      Reason: ${op.reason}`);
    }
  }

  if (skillOperations.length > 0) {
    if (profileOperations.length > 0 || homeOperations.length > 0) lines.push('');
    lines.push('Planned skill changes:');
    for (const op of skillOperations) {
      lines.push(`  ${getOpSymbol(op.kind)} [skills] ${op.name}`);
      lines.push(`      Reason: ${op.reason}`);
    }
  }

  if (plan.unmanaged.length > 0) {
    lines.push('');
    lines.push("Unmanaged plugins (not in manifest; run 'dshenv pull --yes' to manage them):");
    for (const u of plan.unmanaged) {
      lines.push(`  ? [${u.profile}] ${u.package}`);
    }
  }

  if (plan.unmanagedPatches.length > 0) {
    lines.push('');
    lines.push("Patch entries not in the manifest (run 'dshenv pull --yes' to manage them):");
    for (const u of plan.unmanagedPatches) {
      lines.push(`  ? [${u.profile}] ${u.entries.join(', ')}`);
    }
  }
  if ((plan.unmanagedHomePatches ?? []).length > 0) {
    if (plan.unmanagedPatches.length === 0) {
      lines.push('');
      lines.push("Patch entries not in the manifest (run 'dshenv pull --yes' to manage them):");
    }
    lines.push(`  ? [global] ${plan.unmanagedHomePatches!.join(', ')}`);
  }

  if (plan.unmanagedSkills.length > 0) {
    lines.push('');
    lines.push("Skills not in the manifest (run 'dshenv pull --yes' to manage them):");
    for (const name of plan.unmanagedSkills) {
      lines.push(`  ? ${name}`);
    }
  }

  if (plan.unverified.length > 0) {
    lines.push('');
    lines.push('Unverified plugins (cannot be checked against the manifest):');
    for (const u of plan.unverified) {
      lines.push(`  ! [${u.profile}] ${u.package} (${u.alias}): ${u.reason}`);
    }
  }

  lines.push(...pinned);
  return lines.join('\n') + '\n';
}

function restartTarget(item: RestartItem): string {
  if (item.package === HOME_PATCH_TARGET) return 'global patches';
  return item.package === PROFILE_PATCHES_ALIAS ? 'profile patches' : item.package;
}

export function renderPatchTargets(report: PatchTargetReport): string {
  const lines: string[] = [];
  if (report.unmatched.length > 0) {
    lines.push('Patch entries DSH would skip, as no row has their id:');
    for (const item of report.unmatched) {
      const added = report.added.some((other) => other.profile === item.profile && other.layer === item.layer && other.id === item.id);
      lines.push(`  ! ${describeUnmatched(item)}${added ? ' (new: apply --yes stops on it)' : ''}`);
    }
  }
  if (report.unchecked.length > 0) {
    lines.push(`Patch ids not checked: ${report.unchecked.join('; ')}`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

export function renderRestartSummary(restart: RestartSummary): string {
  const lines: string[] = [];
  if (restart.notRequired.length > 0) {
    lines.push('No restart needed:');
    for (const item of restart.notRequired) {
      lines.push(`  [${item.profile}] ${item.kind} ${restartTarget(item)}`);
    }
  }
  if (restart.required.length > 0) {
    lines.push('Restart DSH to load:');
    for (const item of restart.required) {
      lines.push(`  [${item.profile}] ${item.kind} ${restartTarget(item)} (${describeRestartReason(item)})`);
    }
    lines.push('Then run: dshenv mark-restarted');
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function getOpSymbol(kind: string): string {
  switch (kind) {
    case 'install':
      return '+';
    case 'update':
      return '~';
    case 'enable':
      return '^';
    case 'disable':
      return 'v';
    case 'remove':
      return '-';
    case 'configure':
      return '*';
    case 'blocked':
      return '!';
    default:
      return ' ';
  }
}

export function renderStatus(status: EnvironmentStatusSummary): string {
  const lines: string[] = [];
  lines.push(`Environment Status: ${status.status}`);
  lines.push(`Profiles monitored: ${status.profilesCount}`);
  lines.push(`Pending operations: ${status.hasChanges ? 'Yes' : 'None'}`);

  if (status.hasChanges) {
    lines.push('Operation breakdown:');
    for (const [kind, count] of Object.entries(status.operationCounts)) {
      if (count > 0) {
        lines.push(`  - ${kind}: ${count}`);
      }
    }
  }

  if (status.unmanagedCount > 0) {
    lines.push(`Unmanaged plugins: ${status.unmanagedCount}`);
  }
  if ((status.skippedBundles ?? []).length > 0) {
    lines.push('Bundles DSH skips when it loads the profile:');
    lines.push(...status.skippedBundles!.map((item) => `  ! [${item.profile}] ${item.package}: ${item.reason}`));
  }
  if ((status.retiredBundles ?? []).length > 0) {
    lines.push('Retired bundles the manifest still enables (see dshenv plan):');
    lines.push(...status.retiredBundles!.map((item) => `  ! [${item.profile}] ${item.alias} (${item.package})`));
  }
  if ((status.versionExemptions ?? []).length > 0) {
    lines.push('Version exemptions (compatibility.json; they name exact DSH versions and are not in the manifest):');
    lines.push(...status.versionExemptions!.map((item) => `  [${item.profile}] ${item.package} -> ${item.dshVersions.join(', ') || 'no DSH version'}`));
  }

  const table = status.plugins.length > 0
    ? '\n' + renderTable(['PROFILE', 'PACKAGE', 'STATUS'], status.plugins.map((entry) => [entry.profile, entry.package, entry.status]))
    : '';
  return lines.join('\n') + '\n' + table;
}

// Columns padded to their widest cell, so the table lines up in a terminal and still splits on whitespace.
export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells: string[]) => cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]))).join('  ');
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}

export function renderPluginTable(rows: Array<Record<string, unknown>>, withOrigin: boolean): string {
  if (rows.length === 0) {
    return 'No plugins declared. Add one with: dshenv install <spec> -p <profile>\n';
  }
  const yesNo = (value: unknown) => (value === undefined ? '-' : value ? 'yes' : 'no');
  const header = ['PROFILE', 'ALIAS', 'PACKAGE', 'VERSION', 'ENABLED', 'INSTALLED', ...(withOrigin ? ['ORIGIN'] : [])];
  return renderTable(
    header,
    rows.map((row) => [
      String(row.profile),
      row.alias === null ? '(unmanaged)' : String(row.alias),
      String(row.package),
      // A non-npm source has no declared version; its type says where it comes from.
      String(row.version ?? (row.source === 'unmanaged' ? (row.actualVersion ?? '-') : row.source)),
      yesNo(row.enabled),
      yesNo(row.installed),
      ...(withOrigin ? [String(row.origin ?? '-')] : [])
    ])
  );
}

export function renderRuntimeReport(profile: string, endpoint: string, items: RuntimeCheckItem[]): string {
  if (items.length === 0) {
    return `No plugins declared for profile ${profile}.\n`;
  }
  const resultWidth = Math.max(...items.map((item) => item.result.length));
  const aliasWidth = Math.max(...items.map((item) => item.alias.length));
  const lines = [`Runtime check for profile ${profile} (${endpoint})`];
  for (const item of items) {
    const note = [item.detail, item.hint].filter((part): part is string => part !== undefined).join('; ');
    lines.push(`  ${item.result.padEnd(resultWidth)}  ${item.alias.padEnd(aliasWidth)}  ${item.package}${note === '' ? '' : ` (${note})`}`);
  }
  lines.push('Versions are not checked: DSH reports the version on disk, not the one loaded in memory.');
  return `${lines.join('\n')}\n`;
}

export interface DoctorReport {
  runtime: {
    command: string;
    version: string;
    discoverySupported: boolean;
    mutationsSupported: boolean;
    capabilities: DshCapabilities;
  };
  paths: {
    home: string;
    managerDir: string;
    managerDirSource?: 'flag' | 'env' | 'default';
    manifestExists: boolean;
    lockExists: boolean;
    stateExists: boolean;
  };
  // Bundles DSH skips in each profile it has, and the profiles it could not compose.
  bundles?: { skipped: Array<{ profile: string; package: string; reason: string }>; unchecked: string[] };
  remote?: {
    url: string;
    branch: string;
    path: string;
    commit: string;
    drift: RemoteFileDrift[];
    lockDrift: LockEntryDrift[];
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('=== DSH Environment Doctor ===');
  lines.push(`DSH Runtime Version: ${report.runtime.version}`);
  lines.push(`DSH Command: ${report.runtime.command}`);
  lines.push(`Discovery Capability: ${report.runtime.discoverySupported ? 'Supported (✓)' : 'Unsupported (✗)'}`);
  lines.push(`Mutation Capability: ${report.runtime.mutationsSupported ? 'Supported (✓)' : 'Planned apply steps only (no general environment mutation)'}`);
  lines.push('');
  lines.push('Capability details:');
  for (const name of [
    'discovery',
    'packageOperations',
    'bundleSelection',
    'entryToggle',
    'configurationValidation',
    'environmentMutation'
  ] as const) {
    const detail = report.runtime.capabilities[name];
    lines.push(`  ${name}: ${detail.status} (source: ${detail.source}; reason: ${detail.reason ?? 'none'})`);
  }
  lines.push('');
  lines.push('Paths:');
  lines.push(`  Home: ${report.paths.home}`);
  const source = { flag: 'from --envctl-dir', env: 'from DSHENV_HOME', default: 'default' } as const;
  lines.push(`  Manager Dir: ${report.paths.managerDir}${report.paths.managerDirSource ? ` (${source[report.paths.managerDirSource]})` : ''}`);
  lines.push(`  Manifest: ${report.paths.manifestExists ? 'Found' : 'Not created'}`);
  lines.push(`  Lockfile: ${report.paths.lockExists ? 'Found' : 'Not created'}`);
  lines.push(`  State: ${report.paths.stateExists ? 'Found' : 'Not created'}`);

  if (report.bundles && (report.bundles.skipped.length > 0 || report.bundles.unchecked.length > 0)) {
    lines.push('');
    lines.push('Profile bundles:');
    lines.push(...report.bundles.skipped.map((item) => `  ! [${item.profile}] ${item.package} is skipped: ${item.reason}`));
    lines.push(...report.bundles.unchecked.map((item) => `  Not checked: ${item}`));
  }

  if (report.remote) {
    const changes = describeRemoteDrift(report.remote.drift, report.remote.lockDrift).join(', ');
    lines.push('');
    lines.push('Remote:');
    lines.push(`  URL: ${report.remote.url}`);
    lines.push(`  Branch: ${report.remote.branch}`);
    lines.push(`  Pinned Commit: ${report.remote.commit}`);
    lines.push(`  Local Changes: ${changes || 'none'}`);
  }

  return lines.join('\n') + '\n';
}
