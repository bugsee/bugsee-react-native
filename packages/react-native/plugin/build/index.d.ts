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
     * Defaults on. Writes `plugin.ndk.enabled=true` for a real token and adds
     * `com.bugsee:bugsee-android-ndk`. `false` skips both and excludes the
     * wrapper's NDK AAR from the app.
     */
    nativeCrashReporting?: boolean;
    /** Defaults to native-versions.json `android.gradlePlugin`. */
    gradlePluginVersion?: string;
    /** Defaults off. Writes `com.bugsee.app-token` manifest meta-data. */
    autoLaunch?: boolean;
}
declare const _default: ConfigPlugin<BugseePluginProps>;
export default _default;
