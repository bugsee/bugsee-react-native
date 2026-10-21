export interface AutoLaunchInput {
    readonly appToken?: string;
    /** Off unless set. Manifest auto-launch starts the native SDK before JS. */
    readonly autoLaunch?: boolean;
}
/**
 * The `com.bugsee.app-token` meta-data value, or null when the manifest
 * should be left alone. A placeholder token is not written: the native SDK
 * would launch it against the production API.
 */
export declare function manifestAutoLaunchToken(input: AutoLaunchInput): string | null;
/**
 * The Android SDK's auto-launch token. The customer may have written it, so a
 * later prebuild removes it only when `APP_TOKEN_MARKER` says this plugin
 * wrote that exact value.
 */
export declare const APP_TOKEN_META_DATA = "com.bugsee.app-token";
export declare const APP_TOKEN_MARKER = "com.bugsee.reactnative.app-token";
export interface AppTokenMetaDataInput {
    /** What `manifestAutoLaunchToken` returned. */
    readonly token: string | null;
    /** The value of a meta-data item already in the manifest, by name. */
    readonly existing: (name: string) => string | undefined;
}
/**
 * The meta-data edits for auto-launch. An entry this plugin wrote earlier is
 * removed first, so a later prebuild with `autoLaunch` off (or no usable
 * token) leaves none behind. Entries from plugin versions that wrote no
 * marker are not recognised and stay until a clean prebuild.
 */
export declare function appTokenMetaData(input: AppTokenMetaDataInput): Omit<EndpointMetaDataEdit, 'warning'>;
/**
 * The wrapper's own meta-data: the `endpoint` option, which the native module
 * applies when `launch()` or `relaunch()` is given no endpoint
 * (BugseeModule.java, `PluginEndpoint`). The name is the wrapper's, so a
 * value found under it is this plugin's and is replaced or removed freely.
 */
export declare const RN_ENDPOINT_META_DATA = "com.bugsee.reactnative.endpoint";
/**
 * The Android SDK's own option, read on the manifest auto-launch path. The
 * customer may have written it, so it is touched only when
 * `SDK_ENDPOINT_MARKER` says this plugin wrote that exact value.
 */
export declare const SDK_ENDPOINT_META_DATA = "com.bugsee.option.$$ENDPOINT";
export declare const SDK_ENDPOINT_MARKER = "com.bugsee.reactnative.sdk-endpoint";
export interface EndpointMetaDataInput {
    /** The validated `endpoint` option, if set. */
    readonly endpoint?: string;
    /** What `manifestAutoLaunchToken` returned: non-null when auto-launch is written. */
    readonly autoLaunchToken: string | null;
    /** The value of a meta-data item already in the manifest, by name. */
    readonly existing: (name: string) => string | undefined;
}
export interface EndpointMetaDataEdit {
    /** Removed first, by name. */
    readonly remove: readonly string[];
    /** Then added or replaced. */
    readonly set: Readonly<Record<string, string>>;
    /** Said once when the customer's own SDK endpoint is left in place. */
    readonly warning?: string;
}
export declare const SDK_ENDPOINT_KEPT: string;
/**
 * The meta-data edits for the `endpoint` option. Every earlier edit of this
 * plugin is undone first, so a later prebuild without the option leaves no
 * endpoint behind, and one with a new value replaces the old one.
 */
export declare function endpointMetaData(input: EndpointMetaDataInput): EndpointMetaDataEdit;
