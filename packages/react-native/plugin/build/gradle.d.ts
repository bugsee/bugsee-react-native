/**
 * The plugin marker is on Maven Central, not the Plugin Portal. Declaring
 * any repositories block replaces Gradle's implicit Plugin Portal, so a
 * missing block gets the portal, Google, and Maven Central together.
 */
export declare function ensureMavenCentral(settingsGradle: string): string;
export declare function ensureGradlePluginDeclared(projectBuildGradle: string, version: string): string;
/**
 * `ndkVersion` is the baked `android.sdk`, or null when native crash
 * reporting is explicitly off. Null does not add an implementation line.
 * It excludes the wrapper's `api` NDK artifact so that AAR stays off the
 * APK. The wrapper declaration itself is left in place.
 */
export declare function ensureAppAppliesPlugin(appBuildGradle: string, ndkVersion: string | null): string;
