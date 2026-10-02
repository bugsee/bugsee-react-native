export interface AndroidNativeVersions {
    readonly sdk: string;
    readonly gradlePlugin: string;
}
/**
 * Walk up from the plugin until `native-versions.json` appears. That file
 * is the only pin: the Gradle plugin version is `android.gradlePlugin` and
 * the NDK artifact version is `android.sdk`.
 */
export declare function loadNativeVersions(startDir: string): AndroidNativeVersions;
