/**
 * The minimum OS versions this wrapper declares, and where each number comes
 * from.
 *
 * The default rule: a wrapper does not declare a floor **above** the SDK it
 * wraps, because that drops devices the SDK still supports and nothing fails
 * at build time to tell you. Android follows it — the library sits at the
 * AAR's own 21 even though React Native apps sit at 24.
 *
 * iOS is a deliberate, documented exception. React Native has floored at 15.1
 * since 0.76 and gained SPM support only in 0.87, so no consumer can reach
 * the SDK's 13.0 whatever we declare. Sitting at 15 states the truth instead
 * of advertising unreachable devices. That exception is recorded in IOS_FLOOR
 * and asserted below; it is not licence to raise a floor anywhere else.
 */

/** What the wrapped Bugsee SDKs actually support. Verified against artefacts. */
export const SDK_FLOORS = {
  /** `uses-sdk` in the published `bugsee-android` AAR. The SDK defends this
   *  floor deliberately — it pins androidx.webkit to 1.14.0 because 1.15.0+
   *  require 23/24. */
  androidMinSdk: 21,
  /** `LC_BUILD_VERSION minos` in `Bugsee.xcframework/ios-arm64`, which agrees
   *  with `platforms: [.iOS(.v13)]` in the bugsee/spm package manifest.
   *  Recorded for provenance only — iOS does not follow the SDK down; see
   *  IOS_FLOOR. */
  iosDeploymentTarget: '13.0',
} as const;

/**
 * The iOS floor this wrapper declares, everywhere.
 *
 * Unlike Android, iOS deliberately sits above the SDK's own 13.0, because no
 * React Native app can reach it: RN has floored at 15.1 since 0.76, and SPM
 * support did not arrive until 0.87. Declaring 13.0 would only advertise
 * reach that no consumer can use. The native iOS SDK is moving to 15+ to
 * match.
 */
export const IOS_FLOOR = {
  /** SwiftPM manifests. RN's codegen templates hardcode `.iOS(.v15)`, and
   *  SwiftPM refuses a package that sits below a product it consumes. */
  spm: '15.0',
  /** CocoaPods fallback only — the podspec reads RN's own
   *  `min_ios_version_supported` at install time. */
  podFallback: '15.1',
} as const;

/**
 * The React Native versions this wrapper supports.
 *
 * 0.81 rather than 0.82 (the first New-Architecture-only release) or 0.83.
 * The floor is a reach decision, and the reach is not linear: a week of npm
 * downloads puts 0.83+ at 60% of the ecosystem and 0.81+ at 83%, because
 * Expo SDK 54 ships 0.81 and Expo skipped 0.82 entirely. Every step below
 * 0.81 buys about a point.
 *
 * 0.81 still allows opting out of the New Architecture, so support is
 * conditional on it being enabled — which it is by default from 0.76. That
 * is a documented requirement, NOT a legacy bridge fallback; there is no
 * second module implementation and there must not be one.
 *
 * 0.80 is the hard technical floor: `codegenConfig.ios.modulesProvider`,
 * which is how the TurboModule avoids colliding with the SDK's own `Bugsee`
 * class, does not exist before it. 0.81 clears that with a version to spare.
 */
export const REACT_NATIVE_SUPPORT = {
  floor: '0.81.0',
  /** What CI builds. 0.81-0.86 are CocoaPods-only; SPM arrived in 0.87. */
  matrix: ['0.81', '0.83', '0.86', '0.87'],
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

/** The React Native floor a package.json declares, as an exact version. */
export function parsePeerFloor(packageJson: string): string {
  const range = (JSON.parse(packageJson) as {
    peerDependencies?: Record<string, string>;
  }).peerDependencies?.['react-native'];
  const captured = range?.match(/^>=\s*(\d+\.\d+\.\d+)$/)?.[1];
  if (!captured) {
    throw new Error(
      `peerDependencies["react-native"] must be a ">=x.y.z" floor, got ` +
        `${JSON.stringify(range)}. A looser range would claim support for ` +
        `versions CI never builds.`,
    );
  }
  return captured;
}

/** The exact SPM tag a `Package.swift` pins `bugsee/spm` to. */
export function parseSpmPin(manifest: string): string {
  const captured = /url:\s*"[^"]*bugsee\/spm"\s*,\s*exact:\s*"([^"]+)"/
    .exec(manifest)?.[1];
  if (!captured) {
    throw new Error(
      'no exact bugsee/spm pin found. SwiftPM will not resolve a prerelease ' +
        'through a version range, so the pin must be `exact:`.',
    );
  }
  return captured;
}

/** The version a `Package.resolved` has locked `bugsee/spm` at. */
export function parseResolvedPin(resolved: string): string {
  const pins = (JSON.parse(resolved) as {
    pins?: { identity?: string; state?: { version?: string } }[];
  }).pins;
  const captured = pins?.find((p) => p.identity === 'spm')?.state?.version;
  if (!captured) throw new Error('no resolved version for the spm package');
  return captured;
}

/** The Java source/target level an Android `build.gradle` compiles at. */
export function parseGradleJavaLevel(buildGradle: string): string[] {
  const levels = [...buildGradle.matchAll(
    /^\s*(?:source|target)Compatibility\s+JavaVersion\.([A-Z0-9_]+)\s*$/gm,
  )].map((m) => m[1] as string);
  if (levels.length === 0) {
    throw new Error('no source/targetCompatibility declared in build.gradle');
  }
  return levels;
}

/** The `spm.name` a react-native.config.js pins. */
export function parseSpmName(config: string): string {
  const captured = /spm:\s*\{[^}]*?name:\s*['"]([^'"]+)['"]/s.exec(config)?.[1];
  if (!captured) {
    throw new Error(
      'no spm.name pinned in react-native.config.js. Without it the ' +
        'autolinker derives a name, and a derived name that collides with ' +
        "RN's reserved list is renamed silently.",
    );
  }
  return captured;
}

/** The library product a `Package.swift` exposes. */
export function parseSwiftProduct(manifest: string): string {
  const captured = /\.library\(\s*name:\s*"([^"]+)"/.exec(manifest)?.[1];
  if (!captured) throw new Error('no library product declared in Package.swift');
  return captured;
}

/** The react-native versions a CI workflow's compat matrix actually builds. */
export function parseCiCompatMatrix(workflow: string): string[] {
  const line = /react-native:\s*\[([^\]]+)\]/.exec(workflow)?.[1];
  if (!line) throw new Error('no react-native matrix found in the workflow');
  return [...line.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
}
