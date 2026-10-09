import type { AndroidConfig } from '@expo/config-plugins';
/** Every refusal starts with this, then the file, the reason and the manual fix. */
export declare const CANNOT_EDIT = "@bugsee/react-native cannot edit";
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
 * `ndk.debugSymbolLevel` is never written: Bugsee Gradle plugin 4.0.8 and
 * later upload native symbols from the unstripped libraries in
 * `merged_native_libs`, whatever the level, which only decides what AGP packs
 * for Google Play (the app's own choice). The `debugSymbolLevel
 * 'SYMBOL_TABLE'` block earlier versions wrote is removed, recognised by its
 * marker and exact lines only; a level of the user's is left alone. The
 * Hermes preserve command and the finish hook are the JS source-map path,
 * so they are written either way. The hook
 * applies the package's scripts/bugsee-sourcemaps.gradle, which injects the
 * debug id and uploads the composed map unless `bugseeUploadSourcemaps=false`
 * or no real token is configured.
 */
export declare function ensureAppAppliesPlugin(appBuildGradle: string, ndkVersion: string | null, log?: (message: string) => void): string;
export declare const CHANGED_SYMBOL_BLOCK_NOTE = "@bugsee/react-native: android/app/build.gradle has the symbol-table block an earlier version of the plugin wrote, changed inside; it is left as you have it. Bugsee no longer needs ndk.debugSymbolLevel, so you can remove the block, or keep it for Google Play";
export declare const HERMES_COMMAND_UNREWRITABLE = "@bugsee/react-native cannot edit android/app/build.gradle: react.hermesCommand spans several lines or shares its line with another statement, so it cannot be pointed at scripts/hermesc-preserve-js.sh. Put it alone on one line, or delete it, and prebuild again";
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
