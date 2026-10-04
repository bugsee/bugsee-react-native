import type { ConfigPlugin } from '@expo/config-plugins';
export type AppTokenOption = string | {
    ios?: string;
    android?: string;
};
export interface BugseePluginProps {
    /**
     * Bugsee app tokens are per platform. A string is used for both; an
     * object sets each one. Android: the unprefixed `app_token` in
     * android/bugsee.properties. iOS: written into the Archive dSYM
     * post-action and the bundle phase (BUGSEE_PLUGIN_APP_TOKEN), so an
     * Archive from the Xcode GUI works without a shell environment;
     * BUGSEE_APP_TOKEN, BUGSEE_TOKEN_IOS and credentials.json still apply
     * when it is not set.
     */
    appToken?: AppTokenOption;
    /**
     * Defaults on. After the debug id is injected, both platforms upload the
     * composed source map with bugsee-cli when a real app token is
     * configured; a placeholder or missing token skips with one build-log
     * line, and a failed upload warns without failing the build. `false`
     * writes `bugseeUploadSourcemaps=false` into android/gradle.properties and
     * `BUGSEE_UPLOAD_SOURCEMAPS=false` into the iOS bundle phase.
     */
    uploadSourcemaps?: boolean;
    /**
     * Defaults on. `false` keeps native symbols offline on both platforms:
     * iOS loses the Archive dSYM post-action (including one an earlier
     * prebuild left), and Android disables the Bugsee Gradle plugin's
     * `uploadBugsee*` tasks (R8 mapping, NDK symbols, build info) in a marked
     * block a later prebuild removes again. Source maps follow
     * `uploadSourcemaps`.
     */
    uploadSymbols?: boolean;
    /**
     * Defaults on. Writes `plugin.ndk.enabled=true` for a real token, adds
     * `com.bugsee:bugsee-android-ndk`, and sets `debugSymbolLevel 'SYMBOL_TABLE'`
     * on existing debug and release build types. `false` skips the flag, strips
     * that direct dependency, excludes the wrapper's NDK AAR, and removes the
     * symbol block this plugin inserted. JS source-map hooks stay either way.
     */
    nativeCrashReporting?: boolean;
    /** Defaults to native-versions.json `android.gradlePlugin`. */
    gradlePluginVersion?: string;
    /** Defaults off. Writes `com.bugsee.app-token` manifest meta-data. */
    autoLaunch?: boolean;
}
/** The token for one platform, or undefined. Refuses anything that is not token-shaped. */
export declare function platformToken(appToken: AppTokenOption | undefined, platform: 'ios' | 'android'): string | undefined;
/** Shared schemes of every .xcodeproj under ios/. Throws when there are none. */
export declare function listSchemes(iosRoot: string): string[];
declare const _default: ConfigPlugin<BugseePluginProps>;
export default _default;
