"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SDK_ENDPOINT_KEPT = exports.SDK_ENDPOINT_MARKER = exports.SDK_ENDPOINT_META_DATA = exports.RN_ENDPOINT_META_DATA = void 0;
exports.manifestAutoLaunchToken = manifestAutoLaunchToken;
exports.endpointMetaData = endpointMetaData;
const properties_1 = require("./properties");
/**
 * The `com.bugsee.app-token` meta-data value, or null when the manifest
 * should be left alone. A placeholder token is not written: the native SDK
 * would launch it against the production API.
 */
function manifestAutoLaunchToken(input) {
    if (input.autoLaunch !== true) {
        return null;
    }
    const token = input.appToken ?? '';
    if (token.length === 0 || (0, properties_1.isPlaceholderToken)(token)) {
        return null;
    }
    return token;
}
/**
 * The wrapper's own meta-data: the `endpoint` option, which the native module
 * applies when `launch()` or `relaunch()` is given no endpoint
 * (BugseeModule.java, `PluginEndpoint`). The name is the wrapper's, so a
 * value found under it is this plugin's and is replaced or removed freely.
 */
exports.RN_ENDPOINT_META_DATA = 'com.bugsee.reactnative.endpoint';
/**
 * The Android SDK's own option, read on the manifest auto-launch path. The
 * customer may have written it, so it is touched only when
 * `SDK_ENDPOINT_MARKER` says this plugin wrote that exact value.
 */
exports.SDK_ENDPOINT_META_DATA = 'com.bugsee.option.$$ENDPOINT';
exports.SDK_ENDPOINT_MARKER = 'com.bugsee.reactnative.sdk-endpoint';
exports.SDK_ENDPOINT_KEPT = `@bugsee/react-native: AndroidManifest.xml already sets ${exports.SDK_ENDPOINT_META_DATA}, which this plugin did ` +
    'not write. It is left as it is, and the auto-launched SDK uses it rather than the endpoint option';
/**
 * The meta-data edits for the `endpoint` option. Every earlier edit of this
 * plugin is undone first, so a later prebuild without the option leaves no
 * endpoint behind, and one with a new value replaces the old one.
 */
function endpointMetaData(input) {
    const remove = [exports.RN_ENDPOINT_META_DATA];
    const set = {};
    const marker = input.existing(exports.SDK_ENDPOINT_MARKER);
    const sdk = input.existing(exports.SDK_ENDPOINT_META_DATA);
    const sdkIsOurs = marker !== undefined && sdk === marker;
    if (marker !== undefined) {
        remove.push(exports.SDK_ENDPOINT_MARKER);
    }
    if (sdkIsOurs) {
        remove.push(exports.SDK_ENDPOINT_META_DATA);
    }
    if (!input.endpoint) {
        return { remove, set };
    }
    set[exports.RN_ENDPOINT_META_DATA] = input.endpoint;
    if (input.autoLaunchToken === null) {
        return { remove, set };
    }
    if (sdk !== undefined && !sdkIsOurs) {
        return { remove, set, warning: exports.SDK_ENDPOINT_KEPT };
    }
    set[exports.SDK_ENDPOINT_META_DATA] = input.endpoint;
    set[exports.SDK_ENDPOINT_MARKER] = input.endpoint;
    return { remove, set };
}
//# sourceMappingURL=manifest.js.map