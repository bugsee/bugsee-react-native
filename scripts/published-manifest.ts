/**
 * Compares what each native SDK PUBLISHES about its launch options against what this package
 * committed.
 *
 * Every SDK release publishes an immutable option manifest at
 * `download.bugsee.com/sdk/options/<platform>/<version>.json`. The fixtures this package ships
 * (`option-keys.json`, `android-options-manifest.json`) are extracted from SDK sources and could
 * drift from what a release really registers; this is the check against the release itself, run at
 * build and publish time so a misalignment fails the build instead of reaching a customer as an
 * option that is silently ignored.
 */

export interface PublishedOption {
  key: string;
  type: string;
  hidden?: boolean;
  deprecated?: unknown;
  enum?: { name: string; values: unknown };
}

export interface PublishedManifest {
  manifestVersion: number;
  sdk: string;
  sdkVersion: string;
  options: PublishedOption[];
}

export type Platform = 'android' | 'ios';

export const MANIFEST_BASE = 'https://download.bugsee.com/sdk/options';

export function manifestUrl(base: string, platform: Platform, version: string): string {
  return `${base.replace(/\/+$/, '')}/${platform}/${version}.json`;
}

/** Rejects anything that is not a version-1 manifest, rather than comparing against a half-read one. */
export function parseManifest(text: string, source: string): PublishedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const manifest = parsed as Partial<PublishedManifest> | null;
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    typeof manifest.sdk !== 'string' ||
    typeof manifest.sdkVersion !== 'string' ||
    !Array.isArray(manifest.options)
  ) {
    throw new Error(`${source} is not an option manifest (needs sdk, sdkVersion and options)`);
  }
  return manifest as PublishedManifest;
}

/** The fields the committed manifest and the published one must agree on, in a comparable form. */
function describe(option: PublishedOption): string {
  return JSON.stringify({
    type: option.type,
    hidden: option.hidden === true,
    deprecated: option.deprecated !== undefined,
    enum: option.enum === undefined ? null : { name: option.enum.name, values: sorted(option.enum.values) },
  });
}

function sorted(values: unknown): unknown {
  if (values === null || typeof values !== 'object') {
    return values;
  }
  return Object.fromEntries(
    Object.entries(values as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export interface CheckInput {
  platform: Platform;
  /** The version native-versions.json pins. */
  pinnedVersion: string;
  published: PublishedManifest;
  /** Every user-facing key the package lists for the platform: the shared keys plus its own. */
  knownKeys: readonly string[];
  /** The committed Android manifest, compared option by option. iOS has none. */
  committed?: readonly PublishedOption[];
}

/**
 * Every way the published manifest and the committed fixtures disagree; empty means aligned.
 *
 * Hidden options are internals (`$$ENDPOINT`, `$$WRAPPER`): they are not part of the user-facing
 * key lists, so they are left out of the key comparison. The committed Android manifest does
 * include them, and is compared in full.
 */
export function checkPublished(input: CheckInput): string[] {
  const { platform, pinnedVersion, published, knownKeys, committed } = input;
  const problems: string[] = [];

  if (published.sdk !== platform) {
    problems.push(`the manifest is for sdk "${published.sdk}", not "${platform}"`);
  }
  if (published.sdkVersion !== pinnedVersion) {
    problems.push(
      `the manifest is for ${published.sdkVersion}, but native-versions.json pins ${pinnedVersion}`,
    );
  }

  const publishedKeys = new Set(
    published.options.filter((option) => option.hidden !== true).map((option) => option.key),
  );
  const known = new Set(knownKeys);
  for (const key of [...publishedKeys].sort()) {
    if (!known.has(key)) {
      problems.push(
        `the ${platform} SDK registers ${key}, which this package does not list: add it to ` +
          'option-keys.json (cli-extract-option-keys.ts) and give it an accessor',
      );
    }
  }
  for (const key of [...known].sort()) {
    if (!publishedKeys.has(key)) {
      problems.push(
        `this package lists ${key} for ${platform}, which the ${pinnedVersion} SDK does not register, ` +
          'so setting it would be silently ignored',
      );
    }
  }

  if (committed !== undefined) {
    const have = new Map(committed.map((option) => [option.key, option]));
    const want = new Map(published.options.map((option) => [option.key, option]));
    for (const [key, option] of [...want].sort(([a], [b]) => a.localeCompare(b))) {
      const ours = have.get(key);
      if (ours === undefined) {
        problems.push(`android-options-manifest.json is missing ${key}`);
      } else if (describe(ours) !== describe(option)) {
        problems.push(
          `android-options-manifest.json differs from the published manifest for ${key}: ` +
            `committed ${describe(ours)}, published ${describe(option)}`,
        );
      }
    }
    for (const key of [...have.keys()].sort()) {
      if (!want.has(key)) {
        problems.push(`android-options-manifest.json has ${key}, which the published manifest does not`);
      }
    }
  }

  return problems;
}
