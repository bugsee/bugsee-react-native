/**
 * Compares what each native SDK PUBLISHES about its launch options against what this package
 * committed.
 *
 * Every SDK release publishes an immutable option manifest at
 * `download.bugsee.com/sdk/options/<platform>/<version>.json`. The fixtures this package ships
 * (`option-keys.json`, the `*-options-manifest.json` copies) are extracted from SDK sources and could
 * drift from what a release really registers; this is the check against the release itself, run at
 * build and publish time so a misalignment fails the build instead of reaching a customer as an
 * option that is silently ignored.
 *
 * The comparison is one-directional. It complains about what the SDK PUBLISHES that this package does
 * not match: an option it lacks, or one whose type or default differs. It never complains about an
 * option this package has and the SDK does not, because the package can have options of its own that
 * the SDK ignores and only the wrapper acts on.
 */

export interface PublishedOption {
  key: string;
  type: string;
  default?: unknown;
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

/** What this check reads: the only manifest format it understands. */
export const SUPPORTED_MANIFEST_VERSION = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The reason an option row is unusable, or undefined when it is a version-1 row. */
function rowProblem(row: unknown): string | undefined {
  if (!isObject(row)) {
    return 'is not an object';
  }
  if (typeof row.key !== 'string' || row.key === '') {
    return 'has no key';
  }
  if (typeof row.type !== 'string') {
    return `(${row.key}) has no type`;
  }
  if (row.hidden !== undefined && typeof row.hidden !== 'boolean') {
    return `(${row.key}) has a hidden flag that is not a boolean`;
  }
  if (row.enum !== undefined) {
    const named = isObject(row.enum) && typeof row.enum.name === 'string' && isObject(row.enum.values);
    if (!named) {
      return `(${row.key}) has an enum without a name and values`;
    }
  }
  return undefined;
}

/**
 * Rejects anything that is not a manifest this check can read, rather than comparing against a
 * half-understood one. Version 1 is the only format: a later one may rename `hidden`, `deprecated` or
 * `enum`, and comparing it as version 1 would pass differences it cannot see.
 */
export function parseManifest(text: string, source: string): PublishedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (
    !isObject(parsed) ||
    typeof parsed.sdk !== 'string' ||
    typeof parsed.sdkVersion !== 'string' ||
    !Array.isArray(parsed.options)
  ) {
    throw new Error(`${source} is not an option manifest (needs sdk, sdkVersion and options)`);
  }
  if (parsed.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    throw new Error(
      `${source} is manifestVersion ${JSON.stringify(parsed.manifestVersion)}; ` +
        `this check reads version ${SUPPORTED_MANIFEST_VERSION}`,
    );
  }
  for (const [index, row] of parsed.options.entries()) {
    const problem = rowProblem(row);
    if (problem !== undefined) {
      throw new Error(`${source}: option #${index} ${problem}`);
    }
  }
  return parsed as unknown as PublishedManifest;
}

/** The fields the committed manifest and the published one must agree on, in a comparable form. */
function describe(option: PublishedOption): string {
  return JSON.stringify({
    type: option.type,
    default: option.default === undefined ? null : option.default,
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
  /** The committed copy of this platform's manifest, compared option by option. */
  committed?: readonly PublishedOption[];
  /** Its file name, for the messages. */
  committedName?: string;
}

/**
 * Every way the published manifest and the committed fixtures disagree; empty means aligned.
 *
 * Hidden options are internals (`$$ENDPOINT`, `$$WRAPPER`): they are not part of the user-facing
 * key lists, so they are left out of the key comparison. The committed manifests do include
 * them, and are compared in full: type, default, hidden flag, deprecation and enum constants.
 */
export function checkPublished(input: CheckInput): string[] {
  const { platform, pinnedVersion, published, knownKeys, committed } = input;
  const file = input.committedName ?? 'android-options-manifest.json';
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

  if (committed !== undefined) {
    const have = new Map(committed.map((option) => [option.key, option]));
    const want = new Map(published.options.map((option) => [option.key, option]));
    for (const [key, option] of [...want].sort(([a], [b]) => a.localeCompare(b))) {
      const ours = have.get(key);
      if (ours === undefined) {
        problems.push(`${file} is missing ${key}`);
      } else if (describe(ours) !== describe(option)) {
        problems.push(
          `${file} differs from the published manifest for ${key}: ` +
            `committed ${describe(ours)}, published ${describe(option)}`,
        );
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The accessor classes against the published manifest
// ---------------------------------------------------------------------------

/**
 * The TypeScript enum each SDK's published enum name stands for. The SDKs name them differently
 * (`BugseeSeverityLevel` on iOS, `IssueSeverity` on Android), and this package has one enum each.
 */
export const ENUM_TS_NAMES: Readonly<Record<string, string>> = {
  LogLevel: 'LogLevel',
  VideoMode: 'VideoMode',
  VideoQuality: 'VideoQuality',
  FrameRate: 'FrameRate',
  IssueSeverity: 'IssueSeverity',
  MemoryLeakMode: 'MemoryLeakMode',
  BugseeLogLevel: 'LogLevel',
  BugseeVideoQuality: 'VideoQuality',
  BugseeFrameRate: 'FrameRate',
  BugseeSeverityLevel: 'IssueSeverity',
  BugseeStyle: 'ReportingUIStyle',
  BugseeCrashHandlerType: 'CrashHandlerType',
};

export interface Accessor {
  name: string;
  key: string;
  type: string;
  hasSetter: boolean;
  owner: 'base' | 'android' | 'ios';
}

export interface AccessorCheckInput {
  platform: Platform;
  pinnedVersion: string;
  published: PublishedManifest;
  /** Every accessor reachable on this platform's options class: the base class's plus its own. */
  accessors: readonly Accessor[];
  /** Keys that deliberately have no accessor, with the reason. */
  noAccessor: Readonly<Record<string, string>>;
  /** The package's enums, `{ LogLevel: { Error: 1, ... } }`. */
  enums: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Native members the package withholds, `{ FrameRate: { Raw: 4 } }` (see enums.ts). */
  withheld: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const SDK_CLASS: Record<Platform, string> = {
  android: 'AndroidLaunchOptions',
  ios: 'IOSLaunchOptions',
};

function expectedTsType(option: PublishedOption): string | undefined {
  switch (option.type) {
    case 'boolean':
      return 'boolean';
    case 'int':
    case 'float':
      return 'number';
    case 'string':
      return 'string';
    default:
      return undefined;
  }
}

function sortedValues(values: unknown): string[] {
  return Object.values((values ?? {}) as Record<string, unknown>).map(String).sort();
}

/**
 * Every way the accessor classes fall short of the published manifest. Each problem names the option,
 * so a failing build says exactly which one is missing or wrong and where to add it:
 *
 * - an option the SDK registers that has no accessor (and no reason in `noAccessor`);
 * - an accessor with no setter, or whose declared type cannot hold the option's type;
 * - an enum option whose TypeScript enum has other constants than the SDK's.
 *
 * It is one-directional on purpose: an accessor for an option the SDK does NOT register is fine. This
 * package can have options of its own that the SDK ignores and only the wrapper acts on.
 */
export function checkAccessors(input: AccessorCheckInput): string[] {
  const { platform, pinnedVersion, published, accessors, noAccessor, enums, withheld } = input;
  const where = `${SDK_CLASS[platform]} (or BugseeLaunchOptions)`;
  const sdk = `the ${platform} SDK ${pinnedVersion} manifest`;
  const problems: string[] = [];

  const byKey = new Map(accessors.map((accessor) => [accessor.key, accessor]));
  const options = published.options.filter((option) => option.hidden !== true);

  for (const option of [...options].sort((a, b) => a.key.localeCompare(b.key))) {
    if (option.key in noAccessor) {
      continue;
    }
    const accessor = byKey.get(option.key);
    const shape = `${option.type === 'enum' ? `enum ${option.enum?.name}` : option.type}, default ${JSON.stringify(option.default ?? null)}`;
    if (accessor === undefined) {
      problems.push(
        `MISSING OPTION ${option.key} (${shape}) is in ${sdk} but ${where} has no accessor for it. ` +
          'Add a getter and setter, or list it in noAccessor.ts with the reason.',
      );
      continue;
    }
    if (!accessor.hasSetter) {
      problems.push(`${accessor.name} (${option.key}) has a getter but no setter, so the option cannot be set`);
    }
    problems.push(...checkType(option, accessor, enums, withheld));
  }
  return problems;
}

function checkType(
  option: PublishedOption,
  accessor: Accessor,
  enums: AccessorCheckInput['enums'],
  withheld: AccessorCheckInput['withheld'],
): string[] {
  const members = accessor.type.split('|').map((member) => member.trim());
  if (option.type !== 'enum') {
    const expected = expectedTsType(option);
    if (expected === undefined) {
      return [`${accessor.name} (${option.key}) is a ${option.type} option, which this package cannot represent`];
    }
    return members.includes(expected)
      ? []
      : [`${accessor.name} (${option.key}) is declared ${accessor.type}, but the SDK type is ${option.type} (${expected})`];
  }

  const name = option.enum?.name ?? '';
  const tsName = ENUM_TS_NAMES[name];
  if (tsName === undefined) {
    return [`${accessor.name} (${option.key}) is the SDK enum ${name}, which has no TypeScript enum here (add it to ENUM_TS_NAMES)`];
  }
  if (!members.includes(tsName)) {
    return [`${accessor.name} (${option.key}) is declared ${accessor.type}, but the SDK type is the enum ${name} (${tsName})`];
  }
  const ours = enums[tsName];
  if (ours === undefined) {
    return [`${accessor.name} (${option.key}) uses ${tsName}, which is not exported from enums.ts`];
  }
  const published = (option.enum?.values ?? {}) as Record<string, unknown>;
  const left = withheld[tsName] ?? {};
  const kept = Object.fromEntries(Object.entries(published).filter(([member]) => !(member in left)));
  const isNumeric = Object.values(published).every((value) => typeof value === 'number');
  // A numeric enum is compared by VALUE (the SDKs name members differently); a string-valued one
  // (MemoryLeakMode) by constant NAME, which is what crosses the bridge.
  const want = isNumeric ? sortedValues(kept) : Object.keys(kept).sort();
  const have = sortedValues(ours);
  return want.join() === have.join()
    ? []
    : [`${tsName} has the constants [${have.join(', ')}] but ${name} in the SDK has [${want.join(', ')}] (${option.key})`];
}

// ---------------------------------------------------------------------------
// Options an SDK removed between the previous pin and the current one
// ---------------------------------------------------------------------------

/**
 * The pin before the current one, per platform, and the removals React Native has dealt with.
 *
 * Comparing this package with an SDK's manifest cannot find a REMOVED option: the package may have
 * options of its own, so "we have it, the SDK does not" proves nothing. The SDK's own manifests can: an
 * option in the previous pin's manifest and absent from the current one was removed by the SDK, and the
 * accessor and docs for it are now dead. (iOS 7.0.0-beta7 dropped `detect.kill` and
 * `capture.mach-exceptions` this way, and the accessors for them lingered until someone noticed.)
 */
export interface SdkBaseline {
  android: { previous: string; current: string };
  ios: { previous: string; current: string };
  /** Removals that were dealt with deliberately, each with the reason. */
  acknowledgedRemovals: AcknowledgedRemoval[];
}

export interface AcknowledgedRemoval {
  platform: Platform;
  key: string;
  reason: string;
}

function versionPair(value: unknown, platform: string, source: string): { previous: string; current: string } {
  if (!isObject(value) || typeof value.previous !== 'string' || typeof value.current !== 'string') {
    throw new Error(`${source}: ${platform} needs a "previous" and a "current" version`);
  }
  return { previous: value.previous, current: value.current };
}

/** Rejects a baseline that is malformed, rather than comparing against half of one. */
export function parseBaseline(text: string, source: string): SdkBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${source} is not a baseline object`);
  }
  const acknowledged = parsed.acknowledgedRemovals ?? [];
  if (!Array.isArray(acknowledged)) {
    throw new Error(`${source}: acknowledgedRemovals must be a list`);
  }
  const acknowledgedRemovals = acknowledged.map((entry: unknown, index: number): AcknowledgedRemoval => {
    const valid =
      isObject(entry) &&
      (entry.platform === 'android' || entry.platform === 'ios') &&
      typeof entry.key === 'string' &&
      entry.key !== '' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== '';
    if (!valid) {
      throw new Error(`${source}: acknowledgedRemovals #${index} needs a platform, a key and a reason`);
    }
    const { platform, key, reason } = entry as unknown as AcknowledgedRemoval;
    return { platform, key, reason };
  });
  return {
    android: versionPair(parsed.android, 'android', source),
    ios: versionPair(parsed.ios, 'ios', source),
    acknowledgedRemovals,
  };
}

/**
 * Problems with the baseline itself: it must describe the pin it sits next to, and its two versions
 * must differ. Moving the pin without updating it is exactly when the removal check has to run, so this
 * says what to write.
 */
export function checkBaseline(
  platform: Platform,
  baseline: { previous: string; current: string },
  pinnedVersion: string,
): string[] {
  if (baseline.current !== pinnedVersion) {
    return [
      `native-versions.json pins ${platform} ${pinnedVersion}, but scripts/sdk-baseline.json says the current ` +
        `${platform} version is ${baseline.current}. Set "previous" to ${baseline.current} and "current" to ` +
        `${pinnedVersion}; the options removed between them are then checked.`,
    ];
  }
  if (baseline.previous === baseline.current) {
    return [`scripts/sdk-baseline.json has the same previous and current ${platform} version, ${baseline.current}`];
  }
  return [];
}

export interface RemovalCheckInput {
  platform: Platform;
  previousVersion: string;
  currentVersion: string;
  previous: PublishedManifest;
  current: PublishedManifest;
  acknowledged: readonly AcknowledgedRemoval[];
  /**
   * What this package still has for a key, by key: a live accessor on this platform (one that is not
   * deprecated) or an entry in the key list. A removed option is "dealt with" when nothing is left, so it
   * is reported only while its key is here; removing or deprecating the accessor and re-extracting the
   * fixtures clears it. The value says what is left, for the message.
   */
  live: ReadonlyMap<string, string>;
  /**
   * Internal options this package's code depends on (`RELIES_ON_INTERNAL`: the endpoint override). They
   * have no accessor to remove, so losing one is reported until it is acknowledged.
   */
  relied: ReadonlySet<string>;
}

/**
 * Every option the previous pin's manifest has and the current one lacks that this package still has
 * something for (a live accessor, a key-list entry, or, for an internal option, a dependency), unless it
 * was acknowledged; plus every acknowledgement that no longer matches a removal. A removal is dealt with
 * when nothing is left: remove or deprecate the accessor and re-extract the fixtures.
 */
export function checkRemovals(input: RemovalCheckInput): string[] {
  const { platform, previousVersion, currentVersion, previous, current, acknowledged, live, relied } = input;
  const here = acknowledged.filter((entry) => entry.platform === platform);
  const acknowledgedKeys = new Set(here.map((entry) => entry.key));
  const currentKeys = new Set(current.options.map((option) => option.key));
  const problems: string[] = [];

  const removed = previous.options
    .filter((option) => !currentKeys.has(option.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  const removedKeys = new Set(removed.map((option) => option.key));

  for (const option of removed) {
    if (acknowledgedKeys.has(option.key)) {
      continue;
    }
    const left = live.get(option.key);
    const depends = left !== undefined || relied.has(option.key);
    // Nothing left in this package for the key: the removal is dealt with. (An internal option this
    // package never touches cannot affect it either; the wrapper contract, $$ENDPOINT, is `relied`.)
    if (!depends) {
      continue;
    }
    const internal = option.hidden === true ? ' (an internal option this package relies on)' : '';
    problems.push(
      `REMOVED OPTION ${option.key}${internal} was in the ${platform} ${previousVersion} manifest and is absent ` +
        `from ${currentVersion}.${left === undefined ? '' : ` ${left}.`} Remove or deprecate its accessor and re-extract the fixtures, or, if ` +
        'React Native keeps it as an option of its own, acknowledge it in scripts/sdk-baseline.json with the reason.',
    );
  }

  for (const entry of here) {
    if (!removedKeys.has(entry.key)) {
      problems.push(
        `scripts/sdk-baseline.json acknowledges the removal of ${entry.key} on ${platform}, but it was not ` +
          `removed between ${previousVersion} and ${currentVersion}: delete the entry`,
      );
    }
  }
  return problems;
}

/**
 * What an accessor that still writes a removed key means for the person fixing it. A platform's own
 * accessor is simply dead: remove or deprecate it. A SHARED one (on the base class) serves both
 * platforms, so deprecating it would break the platform that still has the option; it has to be moved to
 * that platform's class, or removed if both SDKs dropped the option.
 */
export function describeLiveAccessor(
  name: string,
  owner: 'base' | 'android' | 'ios',
  platform: Platform,
): string {
  if (owner !== 'base') {
    return `${name} still writes it`;
  }
  const other = platform === 'android' ? 'iOS' : 'Android';
  const own = platform === 'android' ? 'IOSLaunchOptions' : 'AndroidLaunchOptions';
  return (
    `${name} still writes it, and is shared by both platforms (BugseeLaunchOptions): if only the ${platform} SDK ` +
    `dropped the option, move it to ${own}, since ${other} still has it; if both did, remove it`
  );
}
