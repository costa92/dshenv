export interface DshVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseDshVersion(value: string): DshVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }

  const prerelease = match[4] ?? null;
  if (prerelease?.split('.').some(identifier => /^0\d+$/.test(identifier))) {
    return null;
  }

  return {
    raw: value,
    major,
    minor,
    patch,
    prerelease
  };
}

// Families whose npm release passed the smoke test, prereleases included (docs/DSH版本升级.md).
const VERIFIED_FAMILIES = ['0.1.7', '0.2.0', '0.2.1'] as const;
export type DshFamily = (typeof VERIFIED_FAMILIES)[number];

export function knownDshFamily(value: string): DshFamily | null {
  const version = parseDshVersion(value);
  if (!version) {
    return null;
  }
  const family = `${version.major}.${version.minor}.${version.patch}`;
  return VERIFIED_FAMILIES.find((candidate) => candidate === family) ?? null;
}

export interface CompatibilityCheckOptions {
  allowUntested?: boolean;
}

export function isCompatibleDshVersion(
  value: string,
  options?: CompatibilityCheckOptions
): { compatible: boolean; reason?: string; isUntested?: boolean } {
  const parsed = parseDshVersion(value);
  if (!parsed) {
    return { compatible: false, reason: 'Malformed or unparseable version string' };
  }

  if (knownDshFamily(value)) {
    return { compatible: true, isUntested: false };
  }

  // Allow override for untested versions if flag/option is passed
  if (options?.allowUntested) {
    return {
      compatible: true,
      isUntested: true,
      reason: `Version ${displayDshVersion(value)} allowed via --allow-untested-dsh override`
    };
  }

  return {
    compatible: false,
    reason: `Unsupported DSH version: ${value}. Use --allow-untested-dsh to enable untested runtimes.`
  };
}

// DSH_CLI can name a wrapper whose --version output carries a credential, so only a prerelease tag made of the usual
// words and numbers (rc.2, beta.1) is shown as it is.
const USUAL_PRERELEASE = /^(?:alpha|beta|rc|pre|preview|next|canary|dev|nightly|\d+)(?:\.(?:alpha|beta|rc|pre|preview|next|canary|dev|nightly|\d+))*$/;

export function displayDshVersion(value: string): string {
  const parsed = parseDshVersion(value);
  if (!parsed) {
    return 'an unparseable version';
  }
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (!parsed.prerelease) {
    return core;
  }
  return USUAL_PRERELEASE.test(parsed.prerelease) ? `${core}-${parsed.prerelease}` : `${core} (a prerelease)`;
}

// The prerelease tag is left out: DSH_CLI can name a wrapper whose --version output carries a credential.
export function unsupportedDshVersionMessage(value: string): string {
  const parsed = parseDshVersion(value);
  const shown = parsed ? ` ${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? ' (a prerelease)' : ''}` : '';
  return (
    `Unsupported DSH version${shown}: dshenv supports DSH ${VERIFIED_FAMILIES.join(', ')} (e.g. 0.2.0-rc.2). ` +
    'Point DSH_CLI at a supported DSH, or pass --allow-untested-dsh to use this one anyway.'
  );
}
