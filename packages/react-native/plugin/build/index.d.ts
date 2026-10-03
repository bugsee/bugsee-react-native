import type { ConfigPlugin } from '@expo/config-plugins';
export interface BugseePluginProps {
    /** Unprefixed `app_token` in android/bugsee.properties. */
    appToken?: string;
    /**
     * Accepted for the spec's option list. The settled Xcode hook injects
     * debug ids on the composed map and does not execute the upload.
     */
    uploadSourcemaps?: boolean;
    /** Defaults on. `false` skips the Archive dSYM post-action. */
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
declare const _default: ConfigPlugin<BugseePluginProps>;
export default _default;
