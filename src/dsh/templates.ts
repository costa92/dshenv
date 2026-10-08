// The profiles DSH's loadProfile creates from its own template when they are missing (PROFILE_TEMPLATES, 0.1.7 to 0.2.1);
// any other name exists only once a plugin is installed into it.
export const DSH_PROFILE_TEMPLATES: readonly string[] = ['acp', 'headless', 'sdk', 'sdk-minimal', 'web'];

export function dshCreatesProfile(name: string): boolean {
  return DSH_PROFILE_TEMPLATES.includes(name);
}

export function missingProfileReason(profile: string): string {
  return `Profile '${profile}' does not exist yet; DSH creates only its template profiles (${DSH_PROFILE_TEMPLATES.join(', ')}) by itself, ` +
    `so start DSH with --profile ${profile} once after creating it with 'dsh plugin --profile ${profile} add <package>', or declare a plugin to install in it`;
}

// The bundles DSH's templates select (BUILTIN_PROFILE_BUNDLES in its plugin manager); the rest it ships are official ones.
export const DSH_TEMPLATE_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal'
]);

// DSH names its official bundles @deepseek-ai/dsh-experimental-<what>[-profile|-bundle]; the alias keeps the <what>.
export function officialBundleAlias(packageName: string): string | undefined {
  const match = /^@deepseek-ai\/dsh-experimental-(.+?)(?:-profile|-bundle)?$/.exec(packageName);
  return match?.[1];
}
