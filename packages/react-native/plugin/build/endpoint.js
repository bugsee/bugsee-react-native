"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENDPOINT_HAS_VERSION = exports.ENDPOINT_NOT_VALID = void 0;
exports.pluginEndpoint = pluginEndpoint;
exports.iosRuntimeEndpoint = iosRuntimeEndpoint;
const ENDPOINT_SHAPE = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;
const VERSION_SUFFIX = /\/v2$/i;
exports.ENDPOINT_NOT_VALID = '@bugsee/react-native: endpoint must be an https URL with a host, an optional port and an optional path, ' +
    'and no credentials, query or fragment (for example https://bugsee.example.com)';
exports.ENDPOINT_HAS_VERSION = '@bugsee/react-native: endpoint must not end in /v2. Give the API base: the Gradle plugin, bugsee-cli ' +
    'and the SDKs add the API version themselves';
/**
 * The validated endpoint, without trailing slashes, or undefined when the
 * option is unset or empty. Throws for anything else.
 */
function pluginEndpoint(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(exports.ENDPOINT_NOT_VALID);
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }
    if (!ENDPOINT_SHAPE.test(trimmed)) {
        throw new Error(exports.ENDPOINT_NOT_VALID);
    }
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new Error(exports.ENDPOINT_NOT_VALID);
    }
    if (url.protocol !== 'https:' || url.hostname === '') {
        throw new Error(exports.ENDPOINT_NOT_VALID);
    }
    const base = trimmed.replace(/\/+$/, '');
    if (VERSION_SUFFIX.test(base)) {
        throw new Error(exports.ENDPOINT_HAS_VERSION);
    }
    return base;
}
/**
 * The iOS SDK's `endpoint` launch option for a validated base. It reads the
 * value verbatim as the versioned API base (src/options/endpoint.ts
 * `endpointFor`), so the version segment is added here.
 */
function iosRuntimeEndpoint(base) {
    return `${base}/v2`;
}
//# sourceMappingURL=endpoint.js.map