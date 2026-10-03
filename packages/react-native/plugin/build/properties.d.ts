export declare function isPlaceholderToken(token: string): boolean;
export interface PropertiesInput {
    readonly appToken?: string;
    /** Defaults on. Opt out with `false`. */
    readonly nativeCrashReporting?: boolean;
}
/**
 * `<rootProject>/bugsee.properties`. The token is the unprefixed `app_token`
 * key. `plugin.ndk.enabled=true` is written only for a real, non-placeholder
 * token while native crash reporting is on (the default). `plugin.appToken`
 * is not a key the Gradle plugin reads, and this file never emits it.
 * No endpoint key: a placeholder token omits the upload flag instead of
 * pointing the build at another host.
 */
export declare function bugseePropertiesText(input?: PropertiesInput): string;
