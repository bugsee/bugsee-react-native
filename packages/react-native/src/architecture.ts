/**
 * The New Architecture check that runs before the TurboModule is looked up.
 *
 * React Native 0.81 still lets an app turn the New Architecture off, and this
 * package does not support that (design 4.5). On the legacy architecture
 * `TurboModuleRegistry.getEnforcing` does not fail: it falls back to the
 * bridge's `NativeModules`, finds the module there, and hands back an object
 * without the codegen event emitters. The import then succeeds, `Bugsee.wrap`
 * throws a `TypeError` about `onDataRequest`, `launch()` resolves, and every
 * lifecycle event fails natively -- half working, which is worse than not
 * working. So the import refuses instead, with an error that names the cause
 * and the fix.
 *
 * How the New Architecture shows itself to JS (React Native's
 * `TurboModuleBinding::install`): bridgeless (the New Architecture default
 * since 0.74) defines `RN$Bridgeless`; the New Architecture on a bridge
 * installs `__turboModuleProxy`. The legacy architecture installs neither.
 */

/** The globals the check reads; `globalThis` in the app, a plain object in tests. */
export interface ArchitectureGlobals {
  readonly RN$Bridgeless?: unknown;
  readonly __turboModuleProxy?: unknown;
}

/** True when the JS runtime is on the New Architecture (bridgeless or not). */
export function isNewArchitecture(globals: ArchitectureGlobals): boolean {
  return globals.RN$Bridgeless === true || typeof globals.__turboModuleProxy === 'function';
}

/**
 * The error the import throws on the legacy architecture: the package, the
 * module, the cause and the fix. A literal (the privacy scanner admits only
 * literals and identifiers into an error).
 */
export const LEGACY_ARCHITECTURE_MESSAGE =
  "@bugsee/react-native: the native module 'Bugsee' needs React Native's New Architecture, " +
  'and this app runs the legacy architecture. React Native 0.81 is the last release that ' +
  'allows turning it off; this package does not support that. Turn the New Architecture on ' +
  '(newArchEnabled=true in android/gradle.properties; RCT_NEW_ARCH_ENABLED=1 when running ' +
  "pod install; \"newArchEnabled\": true in an Expo app's config) and rebuild the app.";

/** Throws {@link LEGACY_ARCHITECTURE_MESSAGE} unless the runtime is on the New Architecture. */
export function requireNewArchitecture(globals: ArchitectureGlobals = globalThis as ArchitectureGlobals): void {
  if (!isNewArchitecture(globals)) {
    throw new Error(LEGACY_ARCHITECTURE_MESSAGE);
  }
}
