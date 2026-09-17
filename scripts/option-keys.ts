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
