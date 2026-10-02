"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadNativeVersions = loadNativeVersions;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * Walk up from the plugin until `native-versions.json` appears. That file
 * is the only pin: the Gradle plugin version is `android.gradlePlugin` and
 * the NDK artifact version is `android.sdk`.
 */
function loadNativeVersions(startDir) {
    let dir = startDir;
    for (let i = 0; i < 10; i += 1) {
        const candidate = (0, node_path_1.join)(dir, 'native-versions.json');
        if ((0, node_fs_1.existsSync)(candidate)) {
            const parsed = JSON.parse((0, node_fs_1.readFileSync)(candidate, 'utf8'));
            const sdk = parsed.android?.sdk;
            const gradlePlugin = parsed.android?.gradlePlugin;
            if (!sdk || !gradlePlugin) {
                throw new Error(`${candidate} is missing android.sdk or android.gradlePlugin`);
            }
            return { sdk, gradlePlugin };
        }
        const parent = (0, node_path_1.dirname)(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    throw new Error(`native-versions.json not found above ${startDir}`);
}
//# sourceMappingURL=native-versions.js.map