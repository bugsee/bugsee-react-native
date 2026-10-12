/**
 * The New Architecture check that runs before the TurboModule is looked up.
 * The same check as `@bugsee/react-native`'s `src/architecture.ts`, which
 * explains it; repeated here because this package does not import that one,
 * so it may be the first to load. On the legacy architecture (React Native
 * 0.81 with it turned off) `getEnforcing` falls back to the bridge and returns
 * a module without the codegen event emitters instead of failing.
 */

export interface ArchitectureGlobals {
  readonly RN$Bridgeless?: unknown;
  readonly __turboModuleProxy?: unknown;
}

export const LEGACY_ARCHITECTURE_MESSAGE =
  "@bugsee/react-native-feedback: the native module 'BugseeFeedbackModule' needs React Native's New Architecture, " +
  'and this app runs the legacy architecture. React Native 0.81 is the last release that ' +
  'allows turning it off; this package does not support that. Turn the New Architecture on ' +
  '(newArchEnabled=true in android/gradle.properties; RCT_NEW_ARCH_ENABLED=1 when running ' +
  "pod install; \"newArchEnabled\": true in an Expo app's config) and rebuild the app.";

export function requireNewArchitecture(globals: ArchitectureGlobals = globalThis as ArchitectureGlobals): void {
  if (globals.RN$Bridgeless === true || typeof globals.__turboModuleProxy === 'function') {
    return;
  }
  throw new Error(LEGACY_ARCHITECTURE_MESSAGE);
}
