export declare function isPlaceholderToken(token: string): boolean;
export interface PropertiesInput {
    readonly appToken?: string;
    /** Defaults on. Opt out with `false`. */
    readonly nativeCrashReporting?: boolean;
    /** A base `pluginEndpoint` validated; written as `plugin.endpoint`. */
    readonly endpoint?: string;
}
/**
 * `<rootProject>/bugsee.properties`. The token is the unprefixed `app_token`
 * key, written only for a real token: the Gradle plugin uploads the R8
 * mapping and registers the APK with any `app_token` it finds, so a
 * placeholder would reach `plugin.endpoint`, or production. For the same
 * token, `plugin.ndk.enabled=true` follows while native crash reporting is on
 * (the default). `plugin.appToken` is not a key the Gradle plugin reads, and
 * this file never emits it. `plugin.endpoint` is the `endpoint` option, for
 * every Gradle upload; without it the plugin's default, production, stands.
 */
export declare function bugseePropertiesText(input?: PropertiesInput): string;
