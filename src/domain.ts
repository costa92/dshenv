export type SourceType = 'npm' | 'git' | 'local-link' | 'local-file' | 'in-box' | 'unknown';

export interface NpmSource {
  type: 'npm';
  version: string;
}

export interface GitSource {
  type: 'git';
  url: string;
  ref?: string;
  commit?: string;
}

export interface LocalLinkSource {
  type: 'local-link';
  path: string;
}

export interface LocalFileSource {
  type: 'local-file';
  path: string;
}

export interface InBoxSource {
  type: 'in-box';
}

export type PluginSource = NpmSource | GitSource | LocalLinkSource | LocalFileSource | InBoxSource;

export interface PatchEntry {
  id: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}

// A cordis patch entry as DSH reads it (an id-targeted override or an insert list), kept verbatim.
export type ProfilePatch = Record<string, unknown>;

export interface PluginManifestEntry {
  package: string;
  enabled?: boolean;
  source: PluginSource;
  patches?: PatchEntry[];
}

export interface EnvironmentManifest {
  apiVersion: 'dshenv/v1';
  environment?: {
    sourceRoot?: string;
    harness?: {
      sourceDir?: string;
      allowUntestedVersion?: boolean;
    };
  };
  profiles: Record<
    string,
    {
      plugins: Record<string, PluginManifestEntry>;
      patches?: ProfilePatch[];
    }
  >;
  // $DSH_HOME/cordis.patch.yml: DSH applies it to every profile, after the profile's own patches.
  patches?: ProfilePatch[];
}

export type NpmLockSource = {
  type: 'npm';
  resolvedVersion: string;
  integrity?: string;
  resolvedFrom?: string;
};

export type GitLockSource = {
  type: 'git';
  url: string;
  commit: string;
};

export type LocalLinkLockSource = {
  type: 'local-link';
  path: string;
  digest?: string;
};

export type LocalFileLockSource = {
  type: 'local-file';
  path: string;
  digest?: string;
};

export type InBoxLockSource = {
  type: 'in-box';
};

export type PluginLockSource =
  | NpmLockSource
  | GitLockSource
  | LocalLinkLockSource
  | LocalFileLockSource
  | InBoxLockSource;

export interface PluginLockEntry {
  package: string;
  source: PluginLockSource;
}

export interface EnvironmentLock {
  apiVersion: 'dshenv-lock/v1';
  profiles: Record<
    string,
    {
      plugins: Record<string, PluginLockEntry>;
    }
  >;
}

export interface PluginStateEntry {
  package: string;
  status: string;
  installedVersion?: string;
  lastVerified?: string;
}

export interface PluginOwnershipRecord {
  package: string;
  alias: string;
  sourceType: SourceType;
  lockedVersion?: string;
  adoptedAt: string;
  adoptedBy: string;
}

export interface SkillOwnershipRecord {
  // The digest both envctl/skills and $DSH_HOME/skills had when they last matched.
  digest: string;
}

// What dshenv owns, by resource kind; only an owned resource is removed once the manifest drops it.
export interface OwnedResources {
  // profile -> package
  plugin?: Record<string, Record<string, PluginOwnershipRecord>>;
  // skill name
  skill?: Record<string, SkillOwnershipRecord>;
}

export type PluginOwnership = NonNullable<OwnedResources['plugin']>;

export interface EnvironmentState {
  apiVersion: 'dshenv-state/v1';
  lastApplied: string;
  appliedLockHash: string;
  profiles: Record<
    string,
    {
      plugins: Record<string, PluginStateEntry>;
    }
  >;
  appliedOverlay?: string;
  resources?: OwnedResources;
}

export interface CaptureDocument {
  apiVersion: 'dshenv-capture/v1';
  manifest: EnvironmentManifest;
  lock: EnvironmentLock;
  warnings: string[];
}

export interface OverlayPatchEntry {
  id: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface OverlayPluginEntry {
  package?: string;
  enabled?: boolean;
  source?: PluginSource;
  patches?: OverlayPatchEntry[];
  remove?: true;
}

export interface EnvironmentOverlay {
  apiVersion: 'dshenv-overlay/v1';
  environment?: EnvironmentManifest['environment'];
  profiles?: Record<string, { plugins?: Record<string, OverlayPluginEntry>; patches?: ProfilePatch[] }>;
  patches?: ProfilePatch[];
}
