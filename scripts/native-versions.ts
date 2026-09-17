import versions from '../native-versions.json';

export interface NativeVersions {
  android: {
    /** `com.bugsee:bugsee-android` */
    sdk: string;
    /** `com.bugsee:bugsee-android-gradle-plugin`. Resolves from Maven Central,
     *  NOT the Gradle Plugin Portal, which does not serve it. */
    gradlePlugin: string;
  };
  ios: {
    /** Tag in the SPM repo, and the version embedded in the xcframework zip URL. */
    sdk: string;
    /** SPM package repository. Not a version; excluded from validation. */
    spmUrl: string;
  };
}

/**
 * Exactly one version per artifact, shared by the podspec, `Package.swift` and
 * the Gradle module — an app must get the same SDK whichever way it integrates.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** Keys that hold something other than a version and must not be checked. */
const NOT_A_VERSION = new Set(['spmUrl']);

export function readNativeVersions(
  override?: NativeVersions,
): NativeVersions {
  const resolved = override ?? (versions as NativeVersions);

  for (const [platform, group] of Object.entries(resolved)) {
    for (const [key, value] of Object.entries(group as Record<string, string>)) {
      if (NOT_A_VERSION.has(key)) continue;
      if (!EXACT_VERSION.test(value)) {
        throw new Error(
          `native-versions.${platform}.${key} must be an exact version ` +
            `(e.g. "7.2.0" or "7.0.0-beta1"), got ${JSON.stringify(value)}. ` +
            `Ranges are rejected because SwiftPM will not resolve a prerelease ` +
            `through one, so the iOS pin would silently match nothing.`,
        );
      }
    }
  }

  return resolved;
}
