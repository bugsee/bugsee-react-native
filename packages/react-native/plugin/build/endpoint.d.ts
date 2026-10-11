/**
 * The plugin's `endpoint` option: a self-hosted, staging or regional Bugsee
 * API base. Unset (the default) leaves every tool and both SDKs on their own
 * default, production.
 *
 * The value is the version-EXCLUSIVE base, as `plugin.endpoint` in
 * bugsee.properties and bugsee-cli's BUGSEE_ENDPOINT take it: both add the
 * API version themselves. Only the iOS SDK's runtime option wants the
 * version in it, and `iosRuntimeEndpoint` adds it.
 *
 * The shape is narrow on purpose. The value is written into a properties
 * file, a single-quoted shell word in the bundle phase and the Archive
 * post-action, an Info.plist and AndroidManifest.xml; a value that is safe
 * in all of them, and a URL every one of their readers parses the same way,
 * is https, a host of letters, digits, dots and dashes, an optional port and
 * an optional plain path. Nothing in the error echoes the value.
 */
export declare const ENDPOINT_NOT_VALID: string;
export declare const ENDPOINT_HAS_VERSION: string;
/**
 * The validated endpoint, without trailing slashes, or undefined when the
 * option is unset or empty. Throws for anything else.
 */
export declare function pluginEndpoint(value: unknown): string | undefined;
/**
 * The iOS SDK's `endpoint` launch option for a validated base. It reads the
 * value verbatim as the versioned API base (src/options/endpoint.ts
 * `endpointFor`), so the version segment is added here.
 */
export declare function iosRuntimeEndpoint(base: string): string;
