import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentManifest } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { CommandSpec } from '../dsh/command.js';
import { readCandidateDiagnostics, readDumpDiagnostics, type UnmatchedPatch } from '../dsh/dump-check.js';
import type { EnvironmentPlan } from '../planner/plan.js';
import { isValidProfileName } from '../manifest/schema.js';
import { HOME_PATCH_TARGET } from '../profile-patches/entries.js';
import { profilePatchContent, readProfilePatchFile } from './patches.js';
import { assertNotInterrupted } from '../io/interrupt.js';

export interface PatchTargetReport {
  // Entries of the profile and global layers DSH would skip, matching no row, once apply wrote them.
  unmatched: UnmatchedPatch[];
  // Of those, the ones that stop apply --yes: a profile entry whose id DSH matches in no layer today, or a global entry
  // whose id no profile has.
  added: UnmatchedPatch[];
  // Profiles DSH could not compose, and why.
  unchecked: string[];
}

// `dsh --dump-config` composes without loading plugins or evaluating !!js, so this only catches ids no row has.
export async function checkPatchTargets(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  plan: EnvironmentPlan,
  command: CommandSpec | null,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<PatchTargetReport | undefined> {
  const writes = (op: EnvironmentPlan['operations'][number]) => op.kind === 'configure' && (op.resource === 'profile-patch' || op.resource === 'home-patch');
  const profileWrites = new Set(plan.operations.flatMap((op) => (writes(op) && op.resource === 'profile-patch' ? [op.profile] : [])));
  const homeWrite = plan.operations.some((op) => writes(op) && op.resource === 'home-patch');
  if (!command || (profileWrites.size === 0 && !homeWrite)) return undefined;

  // A dump creates a missing profile; one apply has not created yet has nothing to compose either.
  const existing = (profile: string) => isValidProfileName(profile) && fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'));
  // The global file reaches every profile.
  const everyProfile = homeWrite && fs.existsSync(paths.profilesDir) ? fs.readdirSync(paths.profilesDir) : [];
  const profiles = [...new Set([...profileWrites, ...everyProfile])].filter(existing).sort();
  const homePatch = homeWrite ? profilePatchContent(await readProfilePatchFile(paths, HOME_PATCH_TARGET), HOME_PATCH_TARGET, manifest.patches ?? []) : undefined;
  const options = { command, home: paths.home, profilesDir: paths.profilesDir, timeoutMs };

  // A plugin step of this apply changes the rows such a profile has, which a dump of it today cannot show.
  const pluginChanges = new Set(plan.operations.flatMap((op) => (op.resource === 'plugin' && op.kind !== 'blocked' ? [op.profile] : [])));

  const report: PatchTargetReport = { unmatched: [], added: [], unchecked: [] };
  // Per profile checked: the global ids DSH would skip, and every id it skips today in any layer.
  const globalChecks: Array<{ skipped: UnmatchedPatch[]; before: Set<string> }> = [];
  await Promise.all(
    profiles.map(async (profile) => {
      if (pluginChanges.has(profile)) {
        report.unchecked.push(`${profile}: its plugins change in this apply, so DSH cannot show its rows yet`);
        return;
      }
      const profilePatch = profileWrites.has(profile)
        ? profilePatchContent(await readProfilePatchFile(paths, profile), profile, manifest.profiles[profile]?.patches ?? [])
        : undefined;
      // One after the other: both dumps prepare the same node_modules.
      const current = await readDumpDiagnostics(profile, options);
      assertNotInterrupted(signal);
      const candidate = current.ok ? await readCandidateDiagnostics(profile, { profilePatch, homePatch }, options) : current;
      if (!current.ok || !candidate.ok) {
        report.unchecked.push(`${profile}: ${(candidate as { reason: string }).reason}`);
        return;
      }
      const ours = candidate.unmatched.filter((item) => item.layer === 'profile' || item.layer === 'global');
      report.unmatched.push(...ours);
      // An id DSH skips today stays allowed when it moves to another layer.
      const before = new Set(current.unmatched.map((item) => item.id));
      report.added.push(...ours.filter((item) => item.layer === 'profile' && !before.has(item.id)));
      globalChecks.push({ skipped: ours.filter((item) => item.layer === 'global'), before });
    })
  );
  // The global file reaches every profile, and one that lacks a row is normal: an id stops apply only when no profile
  // has its row, and only when every profile could be asked.
  if (report.unchecked.length === 0 && globalChecks.length > 0) {
    const ids = new Set(globalChecks.flatMap((check) => check.skipped.map((item) => item.id)));
    for (const id of ids) {
      const skippedEverywhere = globalChecks.every((check) => check.skipped.some((item) => item.id === id));
      if (skippedEverywhere && globalChecks.some((check) => !check.before.has(id))) {
        report.added.push(...globalChecks.flatMap((check) => check.skipped.filter((item) => item.id === id)));
      }
    }
  }
  const order = (a: UnmatchedPatch, b: UnmatchedPatch) => a.profile.localeCompare(b.profile) || a.layer.localeCompare(b.layer) || a.id.localeCompare(b.id);
  report.unmatched.sort(order);
  report.added.sort(order);
  report.unchecked.sort();
  return report;
}
