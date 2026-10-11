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
     * when it is not set. A committed `ios/` (project.pbxproj and the shared
     * scheme) or `android/bugsee.properties` carries the token.
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
     * Defaults on. Writes `plugin.ndk.enabled=true` for a real token and adds
     * `com.bugsee:bugsee-android-ndk`; the Bugsee Gradle plugin then uploads
     * native symbols from the unstripped libraries, whatever
     * `ndk.debugSymbolLevel` says. `false` skips the flag, strips that direct
     * dependency and excludes the wrapper's NDK AAR. Either way the plugin
     * writes no `debugSymbolLevel`, and removes the symbol-table block earlier
     * versions wrote. JS source-map hooks stay either way.
     */
    nativeCrashReporting?: boolean;
    /** Defaults to native-versions.json `android.gradlePlugin`. */
    gradlePluginVersion?: string;
    /** Defaults off. Writes `com.bugsee.app-token` manifest meta-data. */
    autoLaunch?: boolean;
    /**
     * A self-hosted, staging or regional Bugsee API base, such as
     * `https://bugsee.example.com`: https, no credentials, query or fragment,
     * and no `/v2` (every reader adds the API version itself). Unset, the
     * default, keeps every tool and both SDKs on production. Set, it is
     * written for both platforms' uploads -- `plugin.endpoint` in
     * android/bugsee.properties, and BUGSEE_ENDPOINT in the iOS bundle phase
     * and the Archive dSYM post-action -- and for the runtime: the native
     * module launches with it whenever `launch()` or `relaunch()` is given no
     * `endpoint` of its own (Android `com.bugsee.reactnative.endpoint`
     * meta-data, iOS `BugseeReactNativeEndpoint` in Info.plist). With
     * `autoLaunch` it is also the auto-launched SDK's endpoint, unless the
     * manifest already sets one. A later prebuild without it removes every
     * one of these again.
     */
    endpoint?: string;
}
/** The Info.plist key the iOS native module reads `endpoint` from. */
export declare const IOS_ENDPOINT_PLIST_KEY = "BugseeReactNativeEndpoint";
export declare const APP_GRADLE_NOT_GROOVY: string;
/** The settings or root Gradle file is Kotlin; the plugin edits Groovy only. */
export declare function gradleNotGroovy(file: string): string;
/** The token for one platform, or undefined. Refuses anything that is not token-shaped. */
export declare function platformToken(appToken: AppTokenOption | undefined, platform: 'ios' | 'android'): string | undefined;
/** Shared schemes of every .xcodeproj under ios/. Throws when there are none. */
export declare function listSchemes(iosRoot: string): string[];
declare const _default: ConfigPlugin<BugseePluginProps>;
export default _default;
