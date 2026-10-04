"use strict";
/**
 * pbxproj quoted strings keep their quotes in the xcode project's object
 * model, and escapes (`\n`, `\"`, `\\`) stay as two characters. The writer
 * prints the value unchanged, so a shell script has to be stored in that
 * same shape.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodePbxString = decodePbxString;
exports.encodePbxString = encodePbxString;
const ESCAPES = { n: '\n', r: '\r', t: '\t' };
/** `\x` becomes x, or the control character for n, r and t. A lone trailing `\` stays. */
function unescapeBody(body) {
    return body.replace(/\\([\s\S])/g, (_, next) => ESCAPES[next] ?? next);
}
function decodePbxString(stored) {
    if (stored.startsWith('"') && stored.endsWith('"')) {
        return unescapeBody(stored.slice(1, -1));
    }
    return stored;
}
function encodePbxString(value) {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
    return `"${escaped}"`;
}
//# sourceMappingURL=pbx-string.js.map