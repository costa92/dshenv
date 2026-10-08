import * as fs from 'node:fs';
import type { EnvironmentManifest, EnvironmentOverlay } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError, missingManifestError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withEnvironmentLock } from '../io/lock.js';
import { loadManifest, serializeManifest } from '../manifest/files.js';
import { readOverlay } from '../overlay/effective.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { assertBaseMergesWithOverlay, resolveWriteLayer, saveOverlay } from '../overlay/write.js';
import { assertNotRemoteOwned } from '../remote/ownership.js';
import { ENV_KEY_ADVICE, documentSecrets, type DocumentSecret } from '../security/secrets.js';
import { resolveCliOverlay } from './context.js';

// Resolves which layer a manifest write goes to; `overlay` is set only when writing the active overlay.
export function resolveWrite(
  opts: { overlay?: string | false },
  paths: EnvironmentPaths,
  layerOption: string | undefined
): { selection: OverlaySelection | null; overlay: OverlaySelection | null } {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
  }
  const selection = resolveCliOverlay(opts, paths);
  return { selection, overlay: resolveWriteLayer(selection, layerOption) === 'overlay' ? selection : null };
}

// Manifest and overlays are shared across machines; a credential one already holds is warned about, not refused here.
function assertNoNewSecrets(file: string, before: DocumentSecret[], after: DocumentSecret[]): void {
  const added = after.filter((secret) => !before.some((known) => known.digest === secret.digest));
  if (added.length > 0) {
    throw new ValidationError(`Refusing to write a plaintext credential into ${file} (${added.map((secret) => secret.location).join(', ')}); ${ENV_KEY_ADVICE}`);
  }
}

export async function writeOverlay<T>(
  paths: EnvironmentPaths,
  overlay: OverlaySelection,
  edit: (doc: EnvironmentOverlay, base: EnvironmentManifest) => T
): Promise<T> {
  return withEnvironmentLock(paths, async () => {
    const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
    const doc = readOverlay(paths, overlay.name);
    const before = documentSecrets(doc);
    const result = edit(doc, base);
    assertNoNewSecrets(`overlay '${overlay.name}'`, before, documentSecrets(doc));
    await saveOverlay(paths, overlay.name, base, doc);
    return result;
  });
}

export async function writeBase<T>(
  paths: EnvironmentPaths,
  selection: OverlaySelection | null,
  edit: (manifest: EnvironmentManifest) => T
): Promise<T> {
  return withEnvironmentLock(paths, async () => {
    assertNotRemoteOwned(paths, paths.manifestFile);
    const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
    const before = documentSecrets(manifest);
    const result = edit(manifest);
    assertNoNewSecrets('the manifest', before, documentSecrets(manifest));
    assertBaseMergesWithOverlay(paths, selection, manifest);
    await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');
    return result;
  });
}
