"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.manifestAutoLaunchToken = manifestAutoLaunchToken;
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
//# sourceMappingURL=manifest.js.map