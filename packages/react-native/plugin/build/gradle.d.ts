/**
 * The plugin marker is on Maven Central, not the Plugin Portal. Declaring
 * any repositories block replaces Gradle's implicit Plugin Portal, so a
 * missing block gets the portal, Google, and Maven Central together.
 */
export declare function ensureMavenCentral(settingsGradle: string): string;
export declare function ensureGradlePluginDeclared(projectBuildGradle: string, version: string): string;
/**
 * `ndkVersion` is the baked `android.sdk`, or null when native crash
 * reporting is explicitly off. Null strips a direct
 * `implementation "com.bugsee:bugsee-android-ndk"` line from an earlier
 * prebuild and excludes the wrapper's transitive `api` artifact. A
 * configuration exclude does not drop a direct dependency. A later run
 * with the option omitted or on removes that exclude and adds the
 * implementation line. The wrapper `api` itself is left in place.
 */
export declare function ensureAppAppliesPlugin(appBuildGradle: string, ndkVersion: string | null): string;
