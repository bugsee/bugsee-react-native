/**
 * Extracts the real `com.bugsee.option.*` key sets from the two native SDKs.
 *
 * Both SDKs accept the same namespace in 7.x, but neither publishes a
 * manifest yet, so the wrapper's key surface is derived from their sources and
 * committed as a fixture. CI has no SDK checkout; the fixture is what it
 * checks against, and this regenerates it.
 */

/** iOS keys, from `BugseeOptions.m` — the header only declares the symbols. */
export function parseIosKeys(source: string): string[] {
  const keys = [...source.matchAll(
    /NSString \*const \w+\s*=\s*@"(com\.bugsee\.option[^"]*)"/g,
  )].map((m) => m[1] as string);
  return [...new Set(keys)].sort();
}

/**
 * Android keys, from the `Options` interface.
 *
 * NOT from OptionsDescriptors.java: that file builds its registrations from
 * these constants and contains only three literal keys of its own, so reading
 * it would report Android as having almost no options and the shared set as
 * nearly empty.
 */
export function parseAndroidKeys(source: string): string[] {
  const keys = [...source.matchAll(
    /String \w+\s*=\s*"(com\.bugsee\.option[^"]*)"/g,
  )].map((m) => m[1] as string);
  return [...new Set(keys)].sort();
}

export interface PlatformKeys {
  shared: string[];
  ios: string[];
  android: string[];
}

export function splitByPlatform(ios: string[], android: string[]): PlatformKeys {
  if (ios.length === 0 || android.length === 0) {
    throw new Error(
      'one platform produced an empty key list, which means the parser missed ' +
        'the source rather than that the platform has no options',
    );
  }
  const androidSet = new Set(android);
  const iosSet = new Set(ios);
  return {
    shared: ios.filter((k) => androidSet.has(k)).sort(),
    ios: ios.filter((k) => !androidSet.has(k)).sort(),
    android: android.filter((k) => !iosSet.has(k)).sort(),
  };
}

/**
 * The constants of one option enum, as `{ Name: internalValue }`.
 *
 * Reads the value from the constructor argument, NOT the declaration order.
 * The two diverge on four of the five option enums. A pattern that excludes
 * digits also silently drops `V1` and `V2` from VideoMode, which makes
 * `Fullscreen` look like ordinal 1 rather than 3 -- that mistake was made
 * here before this was a parser.
 */
export function parseJavaEnum(source: string): Record<string, number> {
  const body = source.slice(source.indexOf('{'));
  const constants: Record<string, number> = {};
  for (const m of body.matchAll(
    /^\s{4}([A-Za-z_][A-Za-z0-9_]*)\(\s*(?:\(byte\)\s*)?(-?\d+)\s*\)\s*[,;]/gm,
  )) {
    constants[m[1] as string] = Number(m[2]);
  }
  if (Object.keys(constants).length === 0) {
    throw new Error('no enum constants found; the parser missed the source');
  }
  return constants;
}

/** One option, in the shape `bugsee/specs` sdk/options/manifest.md defines. */
export interface ManifestOption {
  key: string;
  type: 'boolean' | 'int' | 'float' | 'string' | 'enum' | 'map' | 'list';
  default: unknown;
  module: string;
  hidden: boolean;
  enum?: { name: string; values: Record<string, number> };
}

/** A whole manifest, format version 1. */
export interface OptionsManifest {
  manifestVersion: 1;
  sdk: 'android' | 'ios' | 'rust' | 'js';
  sdkVersion: string;
  buildConfiguration: string;
  generatedAt: string;
  options: ManifestOption[];
}

const JAVA_TYPES: Record<string, ManifestOption['type']> = {
  'boolean': 'boolean',
  'Boolean': 'boolean',
  'int': 'int',
  'Integer': 'int',
  'long': 'int',
  'Long': 'int',
  'float': 'float',
  'Float': 'float',
  'double': 'float',
  'Double': 'float',
  'String': 'string',
  'Map': 'map',
  'List': 'list',
};

/**
 * Reads Android's `OptionsDescriptors` registrations into manifest options.
 *
 * `type` is the SDK's DECLARED type, never inferred from the default — the
 * manifest spec is explicit about that, and inferring would turn every
 * `Integer` default of 0 into something indistinguishable from a float.
 */
export function parseAndroidDescriptors(
  source: string,
  keysByConstant: Record<string, string>,
  enums: Record<string, Record<string, number>>,
): ManifestOption[] {
  const options: ManifestOption[] = [];
  for (const m of source.matchAll(
    /createAndRegister\(\s*(?:Options\.(\w+)|"([^"]+)")\s*,\s*(\w+)\.class\s*,\s*([^;]*?)\s*\)\s*;/g,
  )) {
    const key = m[1] ? keysByConstant[m[1] as string] : (m[2] as string);
    if (key === undefined) continue;

    const declared = m[3] as string;
    const rest = (m[4] as string).split(',').map((part) => part.trim());
    const rawDefault = rest[0] ?? 'null';
    // The optional fourth argument marks an internal option.
    const hidden = rest[1] === 'true';

    const enumValues = enums[declared];
    options.push({
      key,
      type: enumValues ? 'enum' : (JAVA_TYPES[declared] ?? 'string'),
      default: parseJavaLiteral(rawDefault),
      module: 'bugsee-android',
      hidden,
      ...(enumValues
        ? { enum: { name: declared, values: enumValues } }
        : {}),
    });
  }
  if (options.length === 0) {
    throw new Error('no descriptors found; the parser missed the source');
  }
  return options;
}

/** A Java literal as JSON. Enum defaults become the CONSTANT NAME, per spec. */
function parseJavaLiteral(raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+f?$/.test(raw)) return Number(raw.replace(/f$/, ''));
  const quoted = /^"(.*)"$/.exec(raw);
  if (quoted) return quoted[1];
  // `VideoQuality.Default` -> "Default": the spec stores the constant name.
  const enumConstant = /^\w+\.(\w+)$/.exec(raw);
  return enumConstant ? enumConstant[1] : raw;
}
