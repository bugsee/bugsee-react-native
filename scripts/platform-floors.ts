/**
 * The minimum OS versions this wrapper declares, and where each number comes
 * from.
 *
 * A wrapper must never declare a floor **above** the SDK it wraps: doing so
 * drops devices the SDK itself still supports, and nothing fails at build
 * time to tell you. The only legitimate reason to sit higher is a build-time
 * dependency that refuses to resolve lower — which on iOS is React Native.
 */

/** What the wrapped Bugsee SDKs actually support. Verified against artefacts. */
export const SDK_FLOORS = {
  /** `uses-sdk` in the published `bugsee-android` AAR. The SDK defends this
   *  floor deliberately — it pins androidx.webkit to 1.14.0 because 1.15.0+
   *  require 23/24. */
  androidMinSdk: 21,
  /** `LC_BUILD_VERSION minos` in `Bugsee.xcframework/ios-arm64`, which agrees
   *  with `platforms: [.iOS(.v13)]` in the bugsee/spm package manifest. */
  iosDeploymentTarget: '13.0',
} as const;

/**
 * What React Native forces on anything that links it. SwiftPM rejects a
 * package whose floor is below a product it consumes:
 *
 *   error: The package product 'X' requires minimum platform version 15.0 for
 *   the iOS platform, but this target supports 13.0
 *
 * so the iOS floor is React Native's, not ours, wherever React is in scope.
 */
export const REACT_NATIVE_FLOORS = {
  /** `platforms:` in RN's generated `React-GeneratedCode` package. */
  iosSpmDeploymentTarget: '15.0',
  /** `min_ios_version_supported` in RN's `cocoapods/helpers.rb`; what
   *  `React-Core.podspec` resolves to. Only a fallback here — the podspec
   *  reads RN's own value at install time so it tracks the app's RN version. */
  iosPodDeploymentTargetFallback: '15.1',
} as const;

const SWIFT_PLATFORM = /platforms:\s*\[[^\]]*?\.iOS\(\.v([0-9_]+)\)/;
const GRADLE_MIN_SDK = /^\s*minSdk\s+(\d+)\s*$/m;
const PODSPEC_IOS_LINE = /:ios\s*=>(.*)$/m;
const QUOTED_VERSION = /'([\d.]+)'/g;

/** The iOS floor a `Package.swift` declares, as a dotted version. */
export function parseSwiftPlatform(manifest: string): string {
  const captured = SWIFT_PLATFORM.exec(manifest)?.[1];
  if (!captured) throw new Error('no iOS platform declared in Package.swift');
  // SwiftPM spells 15.1 as `.v15_1`; a bare `.v15` means 15.0.
  const parts = captured.split('_');
  return parts.length === 1 ? `${parts[0]}.0` : parts.join('.');
}

/** The `minSdk` an Android `build.gradle` declares. */
export function parseGradleMinSdk(buildGradle: string): number {
  const captured = GRADLE_MIN_SDK.exec(buildGradle)?.[1];
  if (!captured) throw new Error('no minSdk declared in build.gradle');
  return Number(captured);
}

/**
 * The hardcoded iOS floor a podspec falls back to when RN is out of scope.
 *
 * The declaration is a ternary, so the literal wanted is the last quoted
 * version on the `:ios =>` line, not the first -- reading the first would
 * pick up whatever the condition mentions.
 */
export function parsePodspecFallback(podspec: string): string {
  const line = PODSPEC_IOS_LINE.exec(podspec)?.[1];
  const quoted = line ? [...line.matchAll(QUOTED_VERSION)] : [];
  const captured = quoted.at(-1)?.[1];
  if (!captured) throw new Error('no :ios fallback declared in the podspec');
  return captured;
}
