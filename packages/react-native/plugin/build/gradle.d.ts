/**
 * The plugin marker is on Maven Central, not the Plugin Portal. Declaring
 * any repositories block replaces Gradle's implicit Plugin Portal, so a
 * missing block gets the portal, Google, and Maven Central together.
 */
export declare function ensureMavenCentral(settingsGradle: string): string;
export declare function ensureGradlePluginDeclared(projectBuildGradle: string, version: string): string;
/**
 * `ndkVersion` is `android.sdk` from native-versions.json, or null when
 * native crash reporting is opted out. Null skips the artifact; the plugin
 * is still applied so mapping upload can run.
 */
export declare function ensureAppAppliesPlugin(appBuildGradle: string, ndkVersion: string | null): string;
