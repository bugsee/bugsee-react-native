import type { AndroidConfig } from '@expo/config-plugins';
/**
 * The plugin marker is on Maven Central, not the Plugin Portal. Declaring
 * any repositories block replaces Gradle's implicit Plugin Portal, so a
 * missing block gets the portal, Google, and Maven Central together.
 */
export declare function ensureMavenCentral(settingsGradle: string): string;
/**
 * Declares the plugin `apply false` on the root project. A declaration from
 * an earlier prebuild gets this version written over its own, so a
 * `--no-clean` prebuild after a wrapper bump does not keep the old pin.
 */
export declare function ensureGradlePluginDeclared(projectBuildGradle: string, version: string): string;
/**
 * `ndkVersion` is the baked `android.sdk`, or null when native crash
 * reporting is explicitly off. Null strips a direct
 * `implementation "com.bugsee:bugsee-android-ndk"` line from an earlier
 * prebuild and excludes the wrapper's transitive `api` artifact. A
 * configuration exclude does not drop a direct dependency. A later run
 * with the option omitted or on removes that exclude and adds the
 * implementation line. The wrapper `api` itself is left in place.
 *
 * On (omitted or a version) also writes `debugSymbolLevel 'SYMBOL_TABLE'`
 * on existing debug and release build types when that block is absent.
 * Off removes only the block this plugin inserted. Maven Hermes and
 * `libreactnative.so` are pre-stripped; the comment does not claim those
 * two are symbolicated. The Hermes preserve command and the finish hook
 * are the JS source-map path, so they are written either way. The hook
 * applies the package's scripts/bugsee-sourcemaps.gradle, which injects the
 * debug id and uploads the composed map unless `bugseeUploadSourcemaps=false`
 * or no real token is configured.
 */
export declare function ensureAppAppliesPlugin(appBuildGradle: string, ndkVersion: string | null): string;
export declare const HERMES_COMMAND_UNREWRITABLE: string;
/**
 * `uploadSymbols: false` on Android: disables every `uploadBugsee*` task
 * (mapping, NDK symbols, build info) inside a marked block. On again
 * removes exactly that block.
 */
export declare function ensureSymbolUploads(appBuildGradle: string, enabled: boolean): string;
export type GradleProperty = AndroidConfig.Properties.PropertiesItem;
/**
 * `uploadSourcemaps: false` writes `bugseeUploadSourcemaps=false` into
 * android/gradle.properties, which the finish hook reads. On (the default)
 * removes that key.
 */
export declare function applyUploadSourcemapsProperty(properties: GradleProperty[], enabled: boolean): GradleProperty[];
