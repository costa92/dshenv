import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExactVersionRegex } from '../manifest/schema.js';

// The package names DSH's compatibility reader accepts (packages/boot/app-boot/src/profile-compatibility.ts).
const DSH_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// An exemption from `dsh plugin allow-version`: this exact package version may load on these exact DSH versions.
export interface VersionExemption {
  profile: string;
  package: string;
  dshVersions: string[];
}

// profiles/<p>/compatibility.json, read as DSH reads it but never written: exemptions bind exact DSH versions, so they
// are this machine's, not the manifest's.
export function readVersionExemptions(profilesDir: string, profiles: string[]): { exemptions: VersionExemption[]; warnings: string[] } {
  const exemptions: VersionExemption[] = [];
  const warnings: string[] = [];
  for (const profile of profiles) {
    const file = path.join(profilesDir, profile, 'compatibility.json');
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`${file} cannot be read, so DSH grants no exemption from it: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(`${file} must map package@version keys to DSH version lists, so DSH grants no exemption from it`);
      continue;
    }
    for (const [key, versions] of Object.entries(value as Record<string, unknown>)) {
      // DSH takes only an exact package-name@version key and exact DSH versions, and ignores the whole record otherwise.
      const at = key.lastIndexOf('@');
      const valid = at > 0 && DSH_PACKAGE_NAME.test(key.slice(0, at)) && ExactVersionRegex.test(key.slice(at + 1)) &&
        Array.isArray(versions) && versions.every((version) => typeof version === 'string' && ExactVersionRegex.test(version));
      if (!valid) {
        warnings.push(`${file}: the record ${JSON.stringify(key)} is not an exact package-name@version mapped to exact DSH versions; DSH ignores it`);
        continue;
      }
      exemptions.push({ profile, package: key, dshVersions: versions as string[] });
    }
  }
  return { exemptions, warnings };
}
