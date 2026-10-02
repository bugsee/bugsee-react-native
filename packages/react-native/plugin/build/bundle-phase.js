"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BARE_BUNDLE_SCRIPT = void 0;
exports.rewriteBundlePhase = rewriteBundlePhase;
exports.rewriteProjectBundlePhase = rewriteProjectBundlePhase;
const pbx_string_1 = require("./pbx-string");
/**
 * The "Bundle React Native code and images" shell script from the bare
 * example's pbxproj. It runs `bugsee-xcode.sh`, which makes
 * `REACT_NATIVE_PATH` absolute with `cd`/`pwd` and injects after compose.
 * The upload function in that script is not executed.
 */
exports.BARE_BUNDLE_SCRIPT = [
    'set -e',
    '',
    'WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"',
    'BUGSEE_XCODE="${SRCROOT}/../node_modules/@bugsee/react-native/scripts/bugsee-xcode.sh"',
    '',
    '/bin/sh -c "\\"$WITH_ENVIRONMENT\\" \\"$BUGSEE_XCODE\\""',
    '',
].join('\n');
const BUGSEE_XCODE = '"${SRCROOT}/../node_modules/@bugsee/react-native/scripts/bugsee-xcode.sh"';
/**
 * Expo's bundle phase sets ENTRY_FILE, CLI_PATH and BUNDLE_COMMAND, then
 * runs react-native-xcode.sh. Replacing the whole phase would drop those
 * and the Expo bundle would not be the one bugsee-xcode.sh injects into.
 * Swap only that invocation for the existing hook.
 */
const EXPO_XCODE_INVOCATION = /`"\$NODE_BINARY" --print "require\('path'\)\.dirname\(require\.resolve\('react-native\/package\.json'\)\) \+ '\/scripts\/react-native-xcode\.sh'"`/;
const EXPO_REPLACEMENT = [
    'export REACT_NATIVE_PATH="$("$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\'))")"',
    `/bin/bash ${BUGSEE_XCODE}`,
].join('\n');
function rewriteBundlePhase(script) {
    if (script.includes('bugsee-xcode.sh')) {
        return script;
    }
    if (EXPO_XCODE_INVOCATION.test(script)) {
        return script.replace(EXPO_XCODE_INVOCATION, EXPO_REPLACEMENT);
    }
    if (script.includes('with-environment.sh') && script.includes('react-native-xcode.sh')) {
        return exports.BARE_BUNDLE_SCRIPT;
    }
    if (script.includes('react-native-xcode.sh')) {
        return `${script.replace(/react-native-xcode\.sh/g, 'bugsee-xcode.sh')}\n${EXPO_REPLACEMENT}\n`;
    }
    return `${script.replace(/\s*$/, '')}\n${EXPO_REPLACEMENT}\n`;
}
function rewriteProjectBundlePhase(project) {
    const section = project.hash?.project?.objects?.PBXShellScriptBuildPhase;
    if (!section) {
        throw new Error('PBXShellScriptBuildPhase is missing from the Xcode project');
    }
    let found = false;
    for (const [key, phase] of Object.entries(section)) {
        if (key.endsWith('_comment') || !phase || typeof phase === 'string') {
            continue;
        }
        const name = phase.name ? phase.name.replace(/^"|"$/g, '') : '';
        if (name !== 'Bundle React Native code and images') {
            continue;
        }
        if (typeof phase.shellScript !== 'string') {
            throw new Error('Bundle React Native code and images has no shellScript');
        }
        const current = phase.shellScript.startsWith('"')
            ? (0, pbx_string_1.decodePbxString)(phase.shellScript)
            : phase.shellScript;
        const next = rewriteBundlePhase(current);
        phase.shellScript = phase.shellScript.startsWith('"') ? (0, pbx_string_1.encodePbxString)(next) : next;
        found = true;
    }
    if (!found) {
        throw new Error('Bundle React Native code and images build phase not found');
    }
}
//# sourceMappingURL=bundle-phase.js.map