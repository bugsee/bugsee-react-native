"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadNativeVersions = loadNativeVersions;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * `build:plugin` copies `android.sdk` and `android.gradlePlugin` from the
 * repo-root native-versions.json into `native-versions.baked.json` beside
 * this module. A published install has no repo-root JSON to walk to.
 */
function loadNativeVersions(moduleDir = __dirname) {
    const file = (0, node_path_1.join)(moduleDir, 'native-versions.baked.json');
    let parsed;
    try {
        parsed = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf8'));
    }
    catch (error) {
        throw new Error(`baked native versions not found at ${file}`, { cause: error });
    }
    const sdk = parsed.sdk;
    const gradlePlugin = parsed.gradlePlugin;
    if (!sdk || !gradlePlugin) {
        throw new Error(`${file} is missing sdk or gradlePlugin`);
    }
    return { sdk, gradlePlugin };
}
//# sourceMappingURL=native-versions.js.map