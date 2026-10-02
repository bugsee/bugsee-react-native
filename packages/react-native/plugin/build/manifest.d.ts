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
