import { isProfileOperation, type EnvironmentPlan, type ProfileOperation } from '../planner/plan.js';
import { HOME_PATCH_TARGET, PROFILE_PATCHES_ALIAS } from '../profile-patches/entries.js';
import type { HmrStatus } from '../dsh/hmr.js';

export type RestartReason = 'hmr-on' | 'package-update' | 'hmr-off' | 'hmr-unknown';
export type RestartOperationKind = 'install' | 'update' | 'enable' | 'disable' | 'configure' | 'remove';

export interface RestartItem {
  profile: string;
  package: string;
  kind: RestartOperationKind;
  reason: RestartReason;
  detail?: string;
}

export interface RestartSummary {
  notRequired: RestartItem[];
  required: RestartItem[];
}

const RESTART_KINDS: ReadonlySet<string> = new Set(['install', 'update', 'enable', 'disable', 'configure', 'remove']);

function isRestartKind(kind: string): kind is RestartOperationKind {
  return RESTART_KINDS.has(kind);
}

function changesHomePatches(plan: EnvironmentPlan): boolean {
  return plan.operations.some((op) => op.resource === 'home-patch' && op.kind === 'configure');
}

// Profiles whose operations need an HMR verdict, in plan order; a global patch change reaches every existing profile.
export function profilesToProbe(plan: EnvironmentPlan, existingProfiles: string[] = []): string[] {
  return [
    ...new Set([
      ...plan.operations.filter(isProfileOperation).filter((op) => isRestartKind(op.kind)).map((op) => op.profile),
      ...(changesHomePatches(plan) ? existingProfiles : [])
    ])
  ];
}

// Restart items name profile patches by their block alias.
export function restartPackage(operation: ProfileOperation): string {
  return operation.resource === 'profile-patch' ? PROFILE_PATCHES_ALIAS : operation.package;
}

export function restartItemFor(operation: ProfileOperation, hmr: HmrStatus): RestartItem | null {
  if (!isRestartKind(operation.kind)) {
    return null;
  }
  const base = { profile: operation.profile, package: restartPackage(operation), kind: operation.kind };
  // HMR only re-composes the bundle list; an upgraded package keeps its old module in memory.
  if (operation.kind === 'update') {
    return { ...base, reason: 'package-update' };
  }
  switch (hmr.state) {
    case 'on':
      return { ...base, reason: 'hmr-on' };
    case 'off':
      return { ...base, reason: 'hmr-off' };
    case 'unknown':
      return { ...base, reason: 'hmr-unknown', detail: hmr.reason };
  }
}

export function buildRestartSummary(
  plan: EnvironmentPlan,
  hmrByProfile: ReadonlyMap<string, HmrStatus>,
  existingProfiles: string[] = []
): RestartSummary {
  const summary: RestartSummary = { notRequired: [], required: [] };
  const verdict = (profile: string): HmrStatus => hmrByProfile.get(profile) ?? { state: 'unknown', reason: 'hot reload was not probed' };
  const push = (item: RestartItem | null) => {
    if (item) (item.reason === 'hmr-on' ? summary.notRequired : summary.required).push(item);
  };
  for (const operation of plan.operations.filter(isProfileOperation)) {
    push(restartItemFor(operation, verdict(operation.profile)));
  }
  if (changesHomePatches(plan)) {
    for (const profile of existingProfiles) {
      const hmr = verdict(profile);
      const base = { profile, package: HOME_PATCH_TARGET, kind: 'configure' as const };
      push(hmr.state === 'unknown' ? { ...base, reason: 'hmr-unknown', detail: hmr.reason } : { ...base, reason: hmr.state === 'on' ? 'hmr-on' : 'hmr-off' });
    }
  }
  return summary;
}

export function describeRestartReason(item: RestartItem): string {
  switch (item.reason) {
    case 'hmr-on':
      return 'hot reloaded';
    case 'package-update':
      return 'package updates are not hot-reloaded';
    case 'hmr-off':
      return `hot reload is off for profile ${item.profile}`;
    case 'hmr-unknown':
      return `hot reload state of profile ${item.profile} is unknown: ${item.detail ?? 'no detail'}`;
  }
}
