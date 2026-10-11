/**
 * Pure checks for staging-retrace.test.ts (campaign S-4, F7), kept apart from
 * the device driver so scripts/__tests__/e2e-retrace.test.ts can test them.
 */

/** The crash's top wrapper frame, as the logcat trace prints it. */
export const TEST_CRASH_FRAME = /\bat com\.bugsee\.reactnative\.BugseeModule\.testCrash\(([^)]*)\)/;

/**
 * Whether the position in `BugseeModule.testCrash(<position>)` is R8's
 * (`r8-map-id-…:1`, `SourceFile:1`), so that only retrace can turn it back
 * into `BugseeModule.java:<line>`. The original file name, an unknown or an
 * empty position mean the build was not obfuscated: AGP turns R8 off for a
 * debuggable build, even with minify on.
 */
export function isObfuscatedPosition(position: string): boolean {
  const trimmed = position.trim();
  return trimmed !== '' && trimmed !== 'Unknown Source' && !/^BugseeModule\.java(:\d+)?$/.test(trimmed);
}

/** Whether `adb shell run-as <package> …` output says the package is not debuggable. */
export function refusedRunAs(output: string): boolean {
  return /\bnot debuggable\b/i.test(output);
}
