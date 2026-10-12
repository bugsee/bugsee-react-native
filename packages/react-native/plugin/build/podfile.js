"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeSymbolicatePrebuilt = removeSymbolicatePrebuilt;
exports.insertSymbolicatePrebuilt = insertSymbolicatePrebuilt;
/**
 * React Native's prebuilt `React.xcframework` ships without dSYMs unless
 * `pod install` runs with RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=1 (RN
 * scripts/cocoapods/rncore.rb). Without them the Archive's dSYMs folder has no
 * React dSYM and React frames stay raw addresses. Expo's Podfile reads only a
 * fixed set of Podfile.properties.json keys into ENV, so there is no property
 * to set; the plugin adds one marked line to the Podfile instead. `||=` keeps
 * an explicit value from the environment (RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS=0).
 */
const BEGIN = '# @generated begin bugsee-symbolicate-prebuilt - expo prebuild (DO NOT MODIFY)';
const END = '# @generated end bugsee-symbolicate-prebuilt';
const BLOCK = `${BEGIN}\nENV['RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS'] ||= '1'\n${END}\n`;
const EXISTING = new RegExp(`${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`);
function escape(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function removeSymbolicatePrebuilt(podfile) {
    return podfile.replace(EXISTING, '');
}
/** Idempotent: the block is added once, at the top of the Podfile. */
function insertSymbolicatePrebuilt(podfile) {
    return `${BLOCK}${removeSymbolicatePrebuilt(podfile)}`;
}
//# sourceMappingURL=podfile.js.map