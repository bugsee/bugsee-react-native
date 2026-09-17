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
