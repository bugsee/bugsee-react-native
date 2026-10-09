"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HERMES_COMMAND_UNREWRITABLE = exports.CHANGED_SYMBOL_BLOCK_NOTE = exports.CANNOT_EDIT = void 0;
exports.ensureMavenCentral = ensureMavenCentral;
exports.ensureGradlePluginDeclared = ensureGradlePluginDeclared;
exports.ensureAppAppliesPlugin = ensureAppAppliesPlugin;
exports.ensureSymbolUploads = ensureSymbolUploads;
exports.applyUploadSourcemapsProperty = applyUploadSourcemapsProperty;
// The rule for every edit here: a prebuild, clean or --no-clean, run any
// number of times, never removes or changes a byte of the user's own code.
// Every transform reads the file through one Groovy lexer, so a keyword, a
// brace or a Bugsee marker inside a comment or a string is never a target,
// and only Bugsee's own exact lines are ever replaced or removed. Where the
// file cannot be read or edited with certainty, the transform refuses with
// one error that names the file, the reason and the manual fix.
const PLUGIN_ID = 'com.bugsee.android.gradle';
const APP_GRADLE = 'android/app/build.gradle';
const ROOT_GRADLE = 'android/build.gradle';
const SETTINGS_GRADLE = 'android/settings.gradle';
/** Every refusal starts with this, then the file, the reason and the manual fix. */
exports.CANNOT_EDIT = '@bugsee/react-native cannot edit';
const BY_HAND = 'or make the Bugsee edits by hand (package README, "Android source maps")';
function refusal(file, reason, fix) {
    return new Error(`${exports.CANNOT_EDIT} ${file}: ${reason}. ${fix}`);
}
function unreadable(file, reason) {
    return refusal(file, reason, `Fix that line, ${BY_HAND}, then run expo prebuild again`);
}
/**
 * Runs a transform; anything that is not already a refusal (a defect in the
 * plugin) becomes one, so a prebuild never shows a raw TypeError and never
 * writes a half-made edit.
 */
function guarded(file, transform) {
    try {
        return transform();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith(exports.CANNOT_EDIT)) {
            throw error;
        }
        throw refusal(file, `the plugin hit an internal error while reading it (${message})`, `Report this with the file attached, ${BY_HAND}, then run expo prebuild again`);
    }
}
/** A brace that shares its line with other code is not an anchor: refuse rather than split the line. */
function anchorRefusal(file, line, lineNo, what, alternative) {
    const code = codeOf(line).trim();
    if (line.openAtEnd) {
        // A line added after this one would land inside the comment or string.
        return refusal(file, `line ${lineNo}: \`${code}\` ends inside a block comment or string that is still open, so ${what} cannot be added after it`, `Close the comment on that line, or ${alternative}, then run expo prebuild again`);
    }
    if (code === '{') {
        return refusal(file, `line ${lineNo}: the \`{\` is on a line of its own, so ${what} cannot be added without rewriting the line that names the block`, `Move the \`{\` up to the end of the line that names the block, or ${alternative}, then run expo prebuild again`);
    }
    return refusal(file, `line ${lineNo}: \`${code}\` shares its line with other code, so ${what} cannot be added without rewriting that line`, `Put the brace alone on its line, or ${alternative}, then run expo prebuild again`);
}
const KIND_CODE = 0;
const KIND_STRING = 1;
const KIND_COMMENT = 2;
/** Keywords after which Groovy reads `/` as the start of a slashy string. */
const BEFORE_EXPRESSION = new Set(['return', 'in', 'case', 'assert', 'throw', 'else', 'do']);
/** Characters after which `/` can only start a slashy string. */
const OPERATOR_BEFORE_SLASHY = '=([{,:;!?&|+-*<>~^%';
/** Stands for a string that just ended, as the previous code token. */
const STRING_END = '"';
const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
const isBlank = (ch) => ch === ' ' || ch === '\t' || ch === '\r';
/**
 * Whether a `/` starts a slashy string (true), divides (false), or cannot be
 * told apart (null). `last` is the previous code character on the line ('' at
 * the start of the line), `word` the identifier it ends, `spaced` whether
 * whitespace separates it from the slash, and `tight` whether the slash is
 * followed by a non-space character.
 */
function slashyAllowed(last, word, spaced, tight) {
    if (last === ')' || last === ']' || last === STRING_END) {
        return false;
    }
    if (isWordChar(last)) {
        const identifier = word();
        if (identifier === null) {
            return null;
        }
        if (BEFORE_EXPRESSION.has(identifier)) {
            return true;
        }
        // `a /b/` reads like a regex argument, `a / b` and `a/b` like division.
        return spaced && tight ? null : false;
    }
    if (last !== '' && OPERATOR_BEFORE_SLASHY.includes(last)) {
        return true;
    }
    return null;
}
/**
 * A Groovy lexer deep enough to tell code from comments and strings, and to
 * count braces in code only: `//` and block comments; '…', "…", '''…''' and
 * """…""" with backslash escapes; slashy /…/ and dollar-slashy $/…/$ strings;
 * `${…}` interpolation with nested code. Anything it cannot read with
 * certainty — a string that does not close on its line, a construct still
 * open at the end of the file, braces that do not balance, a `/` that may be
 * a slashy string or a division — is a refusal, never a guess.
 */
function scan(source, file) {
    const masked = [];
    const kinds = [];
    const lines = [];
    const stack = [];
    const openBraces = [];
    let depth = 0;
    let lineNo = 1;
    // Per-line state; startLine resets it for every line after the first.
    let lineStart = 0;
    let lineDepth = 0;
    let lineOpenAtStart = false;
    let commentAt = null;
    /** The previous code character on the line, STRING_END for a string, '' at the line start. */
    let last = '';
    const top = () => stack[stack.length - 1];
    const inString = () => stack.some((frame) => frame.kind === 'string');
    const emit = (ch) => {
        if (ch === '\n') {
            masked.push('\n');
            kinds.push(KIND_CODE);
        }
        else if (inString()) {
            masked.push('S');
            kinds.push(KIND_STRING);
        }
        else if (top()?.kind === 'comment') {
            masked.push(' ');
            kinds.push(KIND_COMMENT);
        }
        else {
            masked.push(ch);
            kinds.push(KIND_CODE);
        }
    };
    const emitN = (from, count) => {
        for (let k = 0; k < count; k += 1) {
            emit(source[from + k]);
        }
    };
    /** `ch` is the code character just read, or a sentinel for a string that just ended. */
    const noteCode = (ch) => {
        commentAt = null;
        last = ch;
    };
    /** The identifier that ends right before `at`, when `last` is a word character; null when a comment sits between. */
    const wordBefore = (at) => /[A-Za-z0-9_]+\s*$/.exec(source.slice(lineStart, at))?.[0].trimEnd() ?? null;
    const endLine = (end) => {
        lines.push({
            start: lineStart,
            raw: source.slice(lineStart, end),
            code: masked.slice(lineStart, end).join(''),
            depth: lineDepth,
            depthAfter: depth,
            openAtStart: lineOpenAtStart,
            openAtEnd: stack.length > 0,
            commentAt,
        });
    };
    const startLine = (at) => {
        lineStart = at;
        lineDepth = depth;
        lineOpenAtStart = stack.length > 0;
        commentAt = null;
        last = '';
    };
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        const frame = top();
        if (ch === '\n') {
            if (frame?.kind === 'string' && frame.oneLine) {
                throw unreadable(file, `line ${frame.line}: a string opened on this line does not close on it`);
            }
            if (frame?.kind === 'comment' && !frame.block) {
                stack.pop();
            }
            endLine(i);
            emit('\n');
            i += 1;
            lineNo += 1;
            startLine(i);
            continue;
        }
        if (frame?.kind === 'comment') {
            if (frame.block && source.startsWith('*/', i)) {
                emitN(i, 2);
                i += 2;
                stack.pop();
            }
            else {
                emit(ch);
                i += 1;
            }
            continue;
        }
        if (frame?.kind === 'string') {
            const next = source[i + 1];
            if (frame.escape === 'quoted' && ch === '\\' && (next ?? '\n') !== '\n') {
                emitN(i, 2);
                i += 2;
                continue;
            }
            if (frame.escape === 'slashy' && ch === '\\' && next === '/') {
                emitN(i, 2);
                i += 2;
                continue;
            }
            if (frame.escape === 'dollar' && ch === '$' && (next === '$' || next === '/')) {
                emitN(i, 2);
                i += 2;
                continue;
            }
            if (frame.interpolates && ch === '$' && next === '{') {
                emitN(i, 2);
                i += 2;
                stack.push({ kind: 'code', depth: 1, line: lineNo });
                continue;
            }
            if (source.startsWith(frame.close, i)) {
                // A fourth quote: the first one is content and the string closes on the last three.
                if (frame.close.length === 3 && source[i + 3] === ch) {
                    emit(ch);
                    i += 1;
                    continue;
                }
                emitN(i, frame.close.length);
                i += frame.close.length;
                stack.pop();
                continue;
            }
            emit(ch);
            i += 1;
            continue;
        }
        // Code, at the top level or inside an interpolation.
        if (ch === '/') {
            const next = source[i + 1];
            if (next === '/' || next === '*') {
                commentAt = commentAt ?? i - lineStart;
                stack.push({ kind: 'comment', block: next === '*', line: lineNo });
                emitN(i, 2);
                i += 2;
                continue;
            }
            const spaced = isBlank(source[i - 1] ?? '');
            const after = next ?? '\n';
            const tight = !isBlank(after) && after !== '\n';
            const slashy = slashyAllowed(last, () => wordBefore(i), spaced, tight);
            if (slashy === null) {
                throw unreadable(file, `line ${lineNo}: cannot tell whether the / starts a slashy string or divides`);
            }
            noteCode(slashy ? STRING_END : ch);
            if (slashy) {
                stack.push({ kind: 'string', close: '/', interpolates: true, escape: 'slashy', oneLine: false, line: lineNo });
            }
            emit(ch);
            i += 1;
            continue;
        }
        // `$` is an identifier character too: `a$/2` is `a$` divided, not a dollar-slashy string.
        if (ch === '$' && source[i + 1] === '/' && !isWordChar(last)) {
            noteCode(STRING_END);
            stack.push({ kind: 'string', close: '/$', interpolates: true, escape: 'dollar', oneLine: false, line: lineNo });
            emitN(i, 2);
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const triple = source.startsWith(ch.repeat(3), i);
            noteCode(STRING_END);
            stack.push({
                kind: 'string',
                close: triple ? ch.repeat(3) : ch,
                interpolates: ch === '"',
                escape: 'quoted',
                oneLine: !triple,
                line: lineNo,
            });
            emitN(i, triple ? 3 : 1);
            i += triple ? 3 : 1;
            continue;
        }
        if (ch === '{') {
            if (frame) {
                frame.depth += 1;
            }
            else {
                depth += 1;
                openBraces.push(lineNo);
            }
            noteCode(ch);
            emit(ch);
            i += 1;
            continue;
        }
        if (ch === '}') {
            if (frame) {
                frame.depth -= 1;
                if (frame.depth === 0) {
                    stack.pop();
                }
            }
            else {
                if (depth === 0) {
                    throw unreadable(file, `line ${lineNo}: a closing brace has no opening brace`);
                }
                depth -= 1;
                openBraces.pop();
            }
            noteCode(ch);
            emit(ch);
            i += 1;
            continue;
        }
        if (!isBlank(ch)) {
            noteCode(ch);
        }
        emit(ch);
        i += 1;
    }
    const open = top();
    if (open?.kind === 'comment' && open.block) {
        throw unreadable(file, `line ${open.line}: a block comment opened on this line never closes`);
    }
    if (open?.kind === 'string') {
        if (open.oneLine) {
            throw unreadable(file, `line ${open.line}: a string opened on this line does not close on it`);
        }
        throw unreadable(file, `line ${open.line}: a string opened on this line never closes`);
    }
    if (open?.kind === 'code') {
        throw unreadable(file, `line ${open.line}: a \${ interpolation opened on this line never closes`);
    }
    if (depth > 0) {
        throw unreadable(file, `line ${openBraces[0]}: a brace opened on this line never closes`);
    }
    // A line comment may still be open here; the last line's openAtEnd is never read.
    endLine(source.length);
    const text = masked.join('');
    if (text.length !== source.length) {
        throw new Error(`the mask drifted from the source (${text.length} vs ${source.length})`);
    }
    return {
        file,
        source,
        masked: text,
        lines,
        isCode: (index) => kinds[index] === KIND_CODE,
    };
}
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const eolOf = (source) => (source.includes('\r\n') ? '\r\n' : '\n');
const crOf = (eol) => (eol === '\r\n' ? '\r' : '');
const stripCr = (line) => line.replace(/\r$/, '');
/** The line's code as written, up to a trailing comment, carriage return excluded. */
function codeOf(line) {
    return stripCr(line.raw.slice(0, line.commentAt ?? line.raw.length));
}
/** A line that is only a `//` comment in code context, at any indentation. */
function isLineComment(line) {
    return !line.openAtStart && line.commentAt !== null && line.raw.slice(0, line.commentAt).trim() === '' && line.raw.slice(line.commentAt).startsWith('//');
}
/** Bugsee's own comment line, as the plugin writes it, at any indentation. */
function isMarker(line, marker) {
    return isLineComment(line) && stripCr(line.raw).trim() === marker;
}
const indentOf = (raw) => raw.slice(0, raw.length - raw.trimStart().length);
/** The line opens a block with nothing but `keyword {` (a trailing comment allowed) on it. */
function isOpenerLine(line, keyword) {
    return !line.openAtStart && keyword.test(codeOf(line).trim());
}
/** The line holds nothing but a closing brace (a trailing comment allowed). */
function isCloserLine(line) {
    return !line.openAtStart && codeOf(line).trim() === '}';
}
/** The indentation of the block's first direct entry, or one level under the opener when it has none. */
function innerIndent(s, opener, closer) {
    const inner = s.lines.slice(opener + 1, closer).find((line) => stripCr(line.raw).trim() !== '');
    return inner !== undefined ? indentOf(inner.raw) : `${indentOf(s.lines[opener].raw)}    `;
}
/** Inserts `added` (without EOLs) as whole lines at line index `at`, with the file's EOL. */
function insertLines(source, at, added) {
    const lines = source.split('\n');
    const cr = crOf(eolOf(source));
    lines.splice(at, 0, ...added.map((line) => `${line}${cr}`));
    return lines.join('\n');
}
/** Bugsee's own code line, exactly, alone as a statement, at the top level, nothing after it. */
function isOwnStatement(line, statement) {
    return (line !== undefined &&
        !line.openAtStart &&
        line.depth === 0 &&
        line.commentAt === null &&
        codeOf(line).trim() === statement);
}
/**
 * Appends a block after the content, separated by one blank line, keeping
 * the file's own trailing whitespace. The block's lines use the file's EOL.
 */
function appendBlock(source, block, eol) {
    const body = block.split('\n').join(eol);
    if (source === '') {
        return `${body}${eol}`;
    }
    const lead = source.endsWith('\n') ? eol : `${eol}${eol}`;
    return `${source}${lead}${body}${eol}`;
}
/**
 * Removes lines `from` through `to`, with the blank line before them when
 * there is one: the one appendBlock put there.
 */
function removeBlock(lines, from, to) {
    const blank = from > 0 && lines[from - 1].trim() === '' ? 1 : 0;
    lines.splice(from - blank, to - from + 1 + blank);
}
/** Index of the first line of `block` written as consecutive own lines at the top level, or -1. */
function findOwnBlock(s, block) {
    return s.lines.findIndex((first, i) => first.depth === 0 &&
        block.every((text, k) => {
            const line = s.lines[i + k];
            return line !== undefined && !line.openAtStart && stripCr(line.raw) === text;
        }));
}
/** Index of the matching `}` for the `{` at `open`, counting code braces only. */
function matchingBrace(masked, open) {
    let depth = 0;
    let i = open;
    for (;; i += 1) {
        const ch = masked[i];
        if (ch === '{') {
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
}
/** The first `keyword {` block in code, searched within [from, to); with `topLevel`, only one at brace depth 0. */
function blockExtent(s, keyword, from = 0, to = s.masked.length, topLevel = false) {
    // The mask has no keyword in a string or comment, so any match is code.
    const re = new RegExp(`(?<![A-Za-z0-9_])${keyword}\\s*\\{`, 'g');
    re.lastIndex = from;
    const region = s.masked.slice(0, to);
    for (let m = re.exec(region); m !== null; m = re.exec(region)) {
        const open = m.index + m[0].length - 1;
        if (!topLevel || depthAt(s, open) === 0) {
            return { open, bodyStart: open + 1, bodyEnd: matchingBrace(s.masked, open) };
        }
    }
    return null;
}
/** Index of the line holding the character at `index`. */
const lineIndexAt = (s, index) => s.source.slice(0, index).split('\n').length - 1;
/** Brace depth, code only, just before `index`. */
function depthAt(s, index) {
    const line = s.lines[lineIndexAt(s, index)];
    const before = s.masked.slice(line.start, index);
    return line.depth + before.split('{').length - before.split('}').length;
}
/** Matches of `re` (global) in the source whose first character is code, within [from, to). */
function codeMatches(s, re, from = 0, to = s.source.length) {
    const out = [];
    const region = s.source.slice(0, to);
    re.lastIndex = from;
    for (let m = re.exec(region); m !== null; m = re.exec(region)) {
        if (s.isCode(m.index)) {
            out.push(m);
        }
    }
    return out;
}
/** True when `needle` occurs in code or in a string, not only in comments. */
function occursLive(s, needle) {
    for (let at = s.source.indexOf(needle); at !== -1; at = s.source.indexOf(needle, at + 1)) {
        if (s.masked[at] !== ' ') {
            return true;
        }
    }
    return false;
}
// ---------------------------------------------------------------------------
// settings.gradle
// ---------------------------------------------------------------------------
/**
 * The plugin marker is on Maven Central, not the Plugin Portal. Declaring
 * any repositories block replaces Gradle's implicit Plugin Portal, so a
 * missing block gets the portal, Google, and Maven Central together.
 */
function ensureMavenCentral(settingsGradle) {
    return guarded(SETTINGS_GRADLE, () => mavenCentral(settingsGradle));
}
const REPOSITORIES = ['repositories {', '    gradlePluginPortal()', '    google()', '    mavenCentral()', '}'];
function mavenCentral(settingsGradle) {
    const s = scan(settingsGradle, SETTINGS_GRADLE);
    const eol = eolOf(settingsGradle);
    const extent = blockExtent(s, 'pluginManagement');
    if (!extent) {
        return `pluginManagement {${eol}${REPOSITORIES.map((line) => `    ${line}`).join(eol)}${eol}}${eol}${settingsGradle}`;
    }
    if (blockExtentCall(s, 'mavenCentral', extent.bodyStart, extent.bodyEnd)) {
        return settingsGradle;
    }
    const repositories = blockExtent(s, 'repositories', extent.bodyStart, extent.bodyEnd);
    if (repositories) {
        // Before the closing brace, which must stand alone on its line.
        const opener = lineIndexAt(s, repositories.open);
        const closer = lineIndexAt(s, repositories.bodyEnd);
        if (!isOpenerLine(s.lines[opener], /^repositories\s*\{$/) || !isCloserLine(s.lines[closer])) {
            const at = isCloserLine(s.lines[closer]) ? opener : closer;
            throw anchorRefusal(SETTINGS_GRADLE, s.lines[at], at + 1, 'mavenCentral()', 'add mavenCentral() to pluginManagement.repositories yourself');
        }
        return insertLines(settingsGradle, closer, [`${innerIndent(s, opener, closer)}mavenCentral()`]);
    }
    const opener = lineIndexAt(s, extent.open);
    const closer = lineIndexAt(s, extent.bodyEnd);
    if (!isOpenerLine(s.lines[opener], /^pluginManagement\s*\{$/) || !isCloserLine(s.lines[closer])) {
        const at = isCloserLine(s.lines[closer]) ? opener : closer;
        throw anchorRefusal(SETTINGS_GRADLE, s.lines[at], at + 1, 'a repositories block with mavenCentral()', 'add repositories { mavenCentral() } to pluginManagement yourself');
    }
    const indent = innerIndent(s, opener, closer);
    return insertLines(settingsGradle, closer, ['', ...REPOSITORIES.map((line) => `${indent}${line}`)]);
}
/** A `name(` call in code within [from, to). */
function blockExtentCall(s, name, from, to) {
    return codeMatches(s, new RegExp(`(?<![A-Za-z0-9_])${name}\\s*\\(`, 'g'), from, to).length > 0;
}
// ---------------------------------------------------------------------------
// Root build.gradle
// ---------------------------------------------------------------------------
const DECLARED_VERSION = /(id\s*\(?\s*['"]com\.bugsee\.android\.gradle['"]\s*\)?\s+version\s*\(?\s*['"])([^'"]*)(['"])/g;
/**
 * Declares the plugin `apply false` on the root project. A declaration from
 * an earlier prebuild gets this version written over its own, so a
 * `--no-clean` prebuild after a wrapper bump does not keep the old pin.
 */
function ensureGradlePluginDeclared(projectBuildGradle, version) {
    if (!/^[0-9A-Za-z.+_-]+$/.test(version)) {
        throw refusal(ROOT_GRADLE, `the gradlePluginVersion option "${version}" is not a plain version string`, 'Fix the option in the Expo config (the @bugsee/react-native plugin entry), then run expo prebuild again');
    }
    return guarded(ROOT_GRADLE, () => gradlePluginDeclared(projectBuildGradle, version));
}
function gradlePluginDeclared(projectBuildGradle, version) {
    const s = scan(projectBuildGradle, ROOT_GRADLE);
    const eol = eolOf(projectBuildGradle);
    const declared = codeMatches(s, DECLARED_VERSION)[0];
    if (declared) {
        const end = declared.index + declared[0].length;
        return `${projectBuildGradle.slice(0, declared.index)}${declared[1]}${version}${declared[3]}${projectBuildGradle.slice(end)}`;
    }
    // Another declaration form (in a string, so not the pattern above): left alone.
    if (occursLive(s, PLUGIN_ID)) {
        return projectBuildGradle;
    }
    // apply false: the plugin has to be applied on the application module.
    // Applied to the root project it fails configuration, because it hangs
    // its tasks off an Android variant.
    const pin = `id '${PLUGIN_ID}' version '${version}' apply false`;
    // Gradle allows one plugins {} block per script, so an existing top-level
    // one takes the pin, before its closing brace; both braces must stand alone.
    const re = /(?<![A-Za-z0-9_.])plugins\s*\{/g;
    for (let m = re.exec(s.masked); m !== null; m = re.exec(s.masked)) {
        const open = m.index + m[0].length - 1;
        if (depthAt(s, open) !== 0) {
            continue;
        }
        const opener = lineIndexAt(s, open);
        const closer = lineIndexAt(s, matchingBrace(s.masked, open));
        if (!isOpenerLine(s.lines[opener], /^plugins\s*\{$/) || !isCloserLine(s.lines[closer])) {
            const at = isCloserLine(s.lines[closer]) ? opener : closer;
            throw anchorRefusal(ROOT_GRADLE, s.lines[at], at + 1, 'the Bugsee Gradle plugin declaration', `add \`${pin}\` to that plugins block yourself`);
        }
        return insertLines(projectBuildGradle, closer, [`${innerIndent(s, opener, closer)}${pin}`]);
    }
    const declaration = ['plugins {', `    ${pin}`, '}'];
    // plugins {} has to stay with the buildscript block. A later allprojects
    // or apply statement makes Gradle reject the block.
    const buildscript = blockExtent(s, 'buildscript', 0, s.masked.length, true);
    if (buildscript) {
        // After the closing brace's line, which must hold nothing else.
        const closer = lineIndexAt(s, buildscript.bodyEnd);
        const line = s.lines[closer];
        if (!isCloserLine(line) || line.openAtEnd) {
            throw anchorRefusal(ROOT_GRADLE, line, closer + 1, 'the plugins block that declares the Bugsee Gradle plugin', `declare \`id '${PLUGIN_ID}' version '${version}' apply false\` in a plugins block yourself`);
        }
        const indent = indentOf(line.raw);
        return insertLines(projectBuildGradle, closer + 1, [...declaration.map((entry) => `${indent}${entry}`), '']);
    }
    return `${declaration.join(eol)}${eol}${eol}${projectBuildGradle}`;
}
// ---------------------------------------------------------------------------
// App build.gradle
// ---------------------------------------------------------------------------
const NDK_EXCLUDE = "exclude group: 'com.bugsee', module: 'bugsee-android-ndk'";
/**
 * `ndkVersion` is the baked `android.sdk`, or null when native crash
 * reporting is explicitly off. Null strips a direct
 * `implementation "com.bugsee:bugsee-android-ndk"` line from an earlier
 * prebuild and excludes the wrapper's transitive `api` artifact. A
 * configuration exclude does not drop a direct dependency. A later run
 * with the option omitted or on removes that exclude and adds the
 * implementation line. The wrapper `api` itself is left in place.
 *
 * `ndk.debugSymbolLevel` is never written: Bugsee Gradle plugin 4.0.8 and
 * later upload native symbols from the unstripped libraries in
 * `merged_native_libs`, whatever the level, which only decides what AGP packs
 * for Google Play (the app's own choice). The `debugSymbolLevel
 * 'SYMBOL_TABLE'` block earlier versions wrote is removed, recognised by its
 * marker and exact lines only; a level of the user's is left alone. The
 * Hermes preserve command and the finish hook are the JS source-map path,
 * so they are written either way. The hook
 * applies the package's scripts/bugsee-sourcemaps.gradle, which injects the
 * debug id and uploads the composed map unless `bugseeUploadSourcemaps=false`
 * or no real token is configured.
 */
function ensureAppAppliesPlugin(appBuildGradle, ndkVersion, log = console.warn) {
    if (ndkVersion !== null && !/^[0-9A-Za-z.+_-]+$/.test(ndkVersion)) {
        throw refusal(APP_GRADLE, `the NDK artifact version "${ndkVersion}" (native-versions.json android.sdk) is not a plain version string`, 'Fix the baked version, then run expo prebuild again');
    }
    return guarded(APP_GRADLE, () => {
        // The steps that can refuse run first, on the file as the user wrote it,
        // so their line numbers are the user's; the plugin apply line goes in last.
        let next = appBuildGradle;
        if (ndkVersion === null) {
            next = ensureNdkExcluded(dropNdkImplementation(next, log));
        }
        else {
            next = dropNdkExclude(next);
            next = ensureNdkImplementation(next, ndkVersion, log);
        }
        next = removeInsertedSymbolTable(next, log);
        return ensurePluginApplied(ensureHermesHooks(next));
    });
}
const REACT_PLUGIN_LINE = /^\s*apply\s+plugin:\s*(["'])com\.facebook\.react\1\s*$/;
function ensurePluginApplied(source) {
    const s = scan(source, APP_GRADLE);
    if (occursLive(s, PLUGIN_ID)) {
        return source;
    }
    const eol = eolOf(source);
    const statement = `apply plugin: "${PLUGIN_ID}"${crOf(eol)}`;
    const lines = source.split('\n');
    const react = s.lines.findIndex((line) => !line.openAtStart && line.depth === 0 && REACT_PLUGIN_LINE.test(codeOf(line)));
    if (react >= 0) {
        const reactLine = s.lines[react];
        if (reactLine.openAtEnd) {
            throw anchorRefusal(APP_GRADLE, reactLine, react + 1, `\`apply plugin: "${PLUGIN_ID}"\``, `add \`apply plugin: "${PLUGIN_ID}"\` yourself`);
        }
        const raw = reactLine.raw;
        const indent = raw.slice(0, raw.length - raw.trimStart().length);
        lines.splice(react + 1, 0, `${indent}${statement}`);
    }
    else {
        lines.unshift(statement);
    }
    return lines.join('\n');
}
/** Bugsee's NDK dependency carries this marker; without it, an NDK line is the user's. */
const NDK_MARKER = '// bugsee:ndk';
const NDK_ARTIFACT = 'com.bugsee:bugsee-android-ndk';
const NDK_OWN_CODE = /^(\s*implementation\s+"com\.bugsee:bugsee-android-ndk:)([^"]*)("\s*)$/;
/** The opener of the dependencies block the plugin appends when the file has none. */
const NDK_OPENER = `dependencies { ${NDK_MARKER}`;
const DEPENDENCIES_OPENER = /^dependencies\s*\{$/;
/** Bugsee's own NDK line: its exact statement with its marker as the trailing comment. */
function isOwnNdkLine(line) {
    return (!line.openAtStart &&
        line.commentAt !== null &&
        stripCr(line.raw.slice(line.commentAt)).trim() === NDK_MARKER &&
        NDK_OWN_CODE.test(codeOf(line)));
}
/** The user declares the NDK artifact themselves, in code or a string, on a line that is not Bugsee's. */
function userDeclaresNdk(s) {
    return s.lines.some((line) => !isOwnNdkLine(line) && lineMentionsLive(s, line, NDK_ARTIFACT));
}
function lineMentionsLive(s, line, needle) {
    for (let at = line.raw.indexOf(needle); at !== -1; at = line.raw.indexOf(needle, at + 1)) {
        if (s.masked[line.start + at] !== ' ') {
            return true;
        }
    }
    return false;
}
const USER_NDK_NOTE = '@bugsee/react-native: android/app/build.gradle declares com.bugsee:bugsee-android-ndk itself; the plugin leaves that line alone and does not add or remove its own';
function ensureNdkImplementation(source, ndkVersion, log) {
    const s = scan(source, APP_GRADLE);
    const own = s.lines.findIndex(isOwnNdkLine);
    if (own !== -1) {
        const lines = source.split('\n');
        const line = s.lines[own];
        const code = codeOf(line);
        lines[own] = `${code.replace(NDK_OWN_CODE, `$1${ndkVersion}$3`)}${line.raw.slice(code.length)}`;
        return lines.join('\n');
    }
    if (userDeclaresNdk(s)) {
        log(USER_NDK_NOTE);
        return source;
    }
    const dep = `implementation "${NDK_ARTIFACT}:${ndkVersion}" ${NDK_MARKER}`;
    // The first top-level dependencies block, wherever its opener sits on its
    // line (the mask hides strings and comments); that line must hold nothing else.
    const re = /(?<![A-Za-z0-9_.])dependencies\s*\{/g;
    let opener = -1;
    for (let m = re.exec(s.masked); m !== null && opener === -1; m = re.exec(s.masked)) {
        const open = m.index + m[0].length - 1;
        if (depthAt(s, open) === 0) {
            opener = lineIndexAt(s, open);
        }
    }
    if (opener === -1) {
        return appendBlock(source, `${NDK_OPENER}\n    ${dep}\n}`, eolOf(source));
    }
    const line = s.lines[opener];
    if (!isOpenerLine(line, DEPENDENCIES_OPENER) || line.openAtEnd) {
        throw anchorRefusal(APP_GRADLE, line, opener + 1, 'the Bugsee NDK dependency', `declare \`implementation "${NDK_ARTIFACT}:${ndkVersion}"\` yourself`);
    }
    const closer = s.lines.findIndex((entry, i) => i > opener && entry.depthAfter === line.depth);
    return insertLines(source, opener + 1, [`${innerIndent(s, opener, closer)}${dep}`]);
}
/**
 * Removes Bugsee's marked NDK line, and the dependencies block the plugin
 * appended for it when nothing else is left inside. A user's own NDK line
 * is left alone and noted.
 */
function dropNdkImplementation(source, log) {
    const s = scan(source, APP_GRADLE);
    if (userDeclaresNdk(s)) {
        log(USER_NDK_NOTE);
    }
    const lines = source.split('\n');
    for (let i = s.lines.length - 1; i >= 0; i -= 1) {
        const line = s.lines[i];
        if (isOwnNdkLine(line)) {
            lines.splice(i, 1);
        }
    }
    const stripped = scan(lines.join('\n'), APP_GRADLE);
    const opener = stripped.lines.findIndex((line) => !line.openAtStart && line.depth === 0 && stripCr(line.raw) === NDK_OPENER);
    if (opener !== -1) {
        // The block the plugin appended has no blank lines of its own: nothing left means the closer comes next.
        const closer = stripped.lines.findIndex((entry, i) => i > opener && entry.depthAfter === 0);
        if (closer === opener + 1 && isCloserLine(stripped.lines[closer])) {
            const rest = lines;
            removeBlock(rest, opener, closer);
            return rest.join('\n');
        }
    }
    return lines.join('\n');
}
const NDK_EXCLUDE_BLOCK = ['configurations.configureEach {', `    ${NDK_EXCLUDE}`, '}'];
function ensureNdkExcluded(source) {
    const s = scan(source, APP_GRADLE);
    if (findOwnBlock(s, NDK_EXCLUDE_BLOCK) !== -1) {
        return source;
    }
    return appendBlock(source, NDK_EXCLUDE_BLOCK.join('\n'), eolOf(source));
}
function dropNdkExclude(source) {
    const s = scan(source, APP_GRADLE);
    const at = findOwnBlock(s, NDK_EXCLUDE_BLOCK);
    if (at < 0) {
        return source;
    }
    const lines = source.split('\n');
    removeBlock(lines, at, at + NDK_EXCLUDE_BLOCK.length - 1);
    return lines.join('\n');
}
/**
 * The block earlier versions of this plugin wrote into the debug and release
 * build types, kept verbatim so it can be recognised and removed. Its text is
 * a fingerprint, not documentation: `libreactnative.so` is not pre-stripped
 * (the Maven AAR ships it with DWARF), and with Gradle plugin 4.0.8 the
 * native upload no longer depends on the level at all.
 */
const SYMBOL_TABLE_BLOCK = [
    "// bugsee-symbol-table: AGP defaults this to NONE, so the plugin's native upload finds",
    '// nothing and skips. SYMBOL_TABLE emits symbols for code this app',
    '// builds. Maven Hermes and libreactnative.so are pre-stripped;',
    '// this level does not symbolicate those two.',
    'ndk {',
    "    debugSymbolLevel 'SYMBOL_TABLE'",
    '}',
];
/** How many of Bugsee's symbol-table block lines stand at `start`, in order, at the marker's indentation. */
function symbolBlockLinesAt(lines, start) {
    const indent = indentOf(lines[start].raw);
    let count = 0;
    while (count < SYMBOL_TABLE_BLOCK.length) {
        const line = lines[start + count];
        // The first line is a marker in code, and no block line opens a string, so none of them starts inside one.
        if (line === undefined || stripCr(line.raw) !== `${indent}${SYMBOL_TABLE_BLOCK[count]}`) {
            break;
        }
        count += 1;
    }
    return count;
}
/** Index of the first line after `start` that is not a `//` comment line (may be lines.length). */
function afterLineComments(lines, start) {
    let j = start + 1;
    while (j < lines.length && isLineComment(lines[j])) {
        j += 1;
    }
    return j;
}
exports.CHANGED_SYMBOL_BLOCK_NOTE = '@bugsee/react-native: android/app/build.gradle has the symbol-table block an earlier version of the plugin wrote, changed inside; it is left as you have it. Bugsee no longer needs ndk.debugSymbolLevel, so you can remove the block, or keep it for Google Play';
/**
 * Removes exactly the symbol-table block earlier versions wrote, at whatever
 * indentation it stands, and nothing after it. A block whose comment lines
 * are intact but whose body was changed (a user added or edited a line
 * inside) is the user's now: it is left alone and noted. A stray marker loses
 * only its own matching comment lines.
 */
function removeInsertedSymbolTable(source, log) {
    const s = scan(source, APP_GRADLE);
    const kept = [];
    for (let i = 0; i < s.lines.length; i += 1) {
        const line = s.lines[i];
        const matched = isMarker(line, SYMBOL_TABLE_BLOCK[0]) ? symbolBlockLinesAt(s.lines, i) : 0;
        if (matched === 0) {
            kept.push(line.raw);
            continue;
        }
        if (matched < SYMBOL_TABLE_BLOCK.length && matched >= 4) {
            log(exports.CHANGED_SYMBOL_BLOCK_NOTE);
            kept.push(line.raw);
            continue;
        }
        i += matched - 1;
    }
    return kept.join('\n');
}
const HERMES_COMMAND_EXPR = 'new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/scripts/hermesc-preserve-js.sh"';
const SOURCEMAPS_SCRIPT = 'scripts/bugsee-sourcemaps.gradle';
/** First line of the hook this plugin writes. */
const SOURCEMAPS_HOOK_MARKER = '// bugsee-sourcemaps: debug ids and source-map upload for release bundles (@bugsee/react-native).';
/**
 * The hook is the package's own Gradle script, so the bare example and Expo
 * apps run the same code: inject after compose, upload, fail the bundle
 * task when Hermes skipped hermesc-preserve-js.sh.
 */
const SOURCEMAPS_APPLY = `apply from: new File(new File(["node", "--print", "require.resolve('@bugsee/react-native/package.json')"].execute(null, rootDir).text.trim()).getParentFile(), "${SOURCEMAPS_SCRIPT}")`;
/** First line of the inline hook earlier versions wrote. */
const LEGACY_HOOK_MARKER = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
/** The line both earlier inline hooks have after their comments; user code does not. */
const LEGACY_HOOK_FINGERPRINT = 'def bugseeHermesSourcemaps = ';
exports.HERMES_COMMAND_UNREWRITABLE = `${exports.CANNOT_EDIT} ${APP_GRADLE}: react.hermesCommand spans several lines or shares its line with another statement, so it cannot be pointed at scripts/hermesc-preserve-js.sh. Put it alone on one line, or delete it, and prebuild again`;
/** Brackets all close, something is there, and it does not end in an operator. */
function completeExpression(code) {
    let depth = 0;
    for (const ch of code) {
        if ('([{'.includes(ch)) {
            depth += 1;
        }
        else if (')]}'.includes(ch)) {
            depth -= 1;
        }
    }
    return depth === 0 && code.trim().length > 0 && !/[-+*/,([.?:&|=]$/.test(code.trimEnd());
}
/** The next code line starts by continuing the previous expression. */
const CONTINUATION = /^(\?\.|\.|\?|:|\+|-|\*|\/|&&|\|\|)/;
const HERMES_COMMAND = /^([ \t]*)hermesCommand(\s*=(?!=)|\.set\()/;
const REACT_BLOCK = /^\s*react\s*\{\s*$/;
/**
 * Points react.hermesCommand at hermesc-preserve-js.sh. Only the setting at
 * the top level of the react block counts: one in a comment, a string,
 * another block or a nested block is left alone. A one-line
 * `hermesCommand = …` or `hermesCommand.set(…)` is rewritten, a trailing
 * comment kept. Anything this cannot read with certainty (a value that
 * continues on the next line, an open bracket or multi-line string, nothing
 * after `=`, another statement after `;`) is refused. A react block without
 * the setting gets one. With no react block the file is left alone, and the
 * bundle task fails with the fix instead.
 */
function rewriteHermesCommand(source) {
    const s = scan(source, APP_GRADLE);
    const lines = source.split('\n');
    const eol = eolOf(source);
    const react = s.lines.findIndex((line) => !line.openAtStart && line.depth === 0 && REACT_BLOCK.test(line.code));
    if (react === -1) {
        return source;
    }
    // The block's lines, up to its closing brace (braces balance, so it exists).
    const end = s.lines.findIndex((line, i) => i > react && line.depthAfter === 0);
    let found = false;
    for (let i = react + 1; i < end; i += 1) {
        const line = s.lines[i];
        const match = line.openAtStart || line.depth !== 1 ? null : HERMES_COMMAND.exec(line.code);
        if (!match) {
            continue;
        }
        found = true;
        if (line.raw.includes('hermesc-preserve-js.sh')) {
            continue;
        }
        // Comments are spaces in the mask, so the whole masked line is the value.
        const value = `${match[2] === '.set(' ? '(' : ''}${line.code.slice(match[0].length)}`;
        // The closing brace follows at the latest, so a next code line exists.
        const next = s.lines.slice(i + 1).find((later) => later.code.trim().length > 0);
        if (line.openAtEnd || value.includes(';') || !completeExpression(value) || CONTINUATION.test(next.code.trim())) {
            throw new Error(exports.HERMES_COMMAND_UNREWRITABLE);
        }
        // The value is replaced; what follows it (whitespace, a comment, the CR) is kept.
        const valueEnd = line.raw.slice(0, line.commentAt ?? line.raw.length).trimEnd().length;
        lines[i] = `${match[1]}hermesCommand = ${HERMES_COMMAND_EXPR}${line.raw.slice(valueEnd)}`;
    }
    if (!found) {
        const reactLine = s.lines[react];
        if (reactLine.openAtEnd) {
            throw anchorRefusal(APP_GRADLE, reactLine, react + 1, 'react.hermesCommand', 'set react.hermesCommand yourself');
        }
        const opener = reactLine.raw;
        const indent = opener.slice(0, opener.length - opener.trimStart().length);
        lines.splice(react + 1, 0, `${indent}    hermesCommand = ${HERMES_COMMAND_EXPR}${crOf(eol)}`);
    }
    return lines.join('\n');
}
/**
 * Index of the last line of an inline hook an earlier version wrote, which
 * starts at `start` with its marker: comment lines, the
 * `def bugseeHermesSourcemaps = ` line both old versions have, more
 * `def bugsee…` lines, then `afterEvaluate {` through the brace that
 * matches it, alone at column 0. Null when the lines after the marker are
 * anything else, so a stray marker never takes user code with it.
 */
function legacyHookEnd(lines, start) {
    let j = afterLineComments(lines, start);
    // A line after a line comment is never inside a string.
    const fingerprint = lines[j];
    if (fingerprint === undefined || !fingerprint.raw.startsWith(LEGACY_HOOK_FINGERPRINT)) {
        return null;
    }
    while (j < lines.length && lines[j].raw.startsWith('def bugsee')) {
        j += 1;
    }
    // An `afterEvaluate {` inside a string left open by a def line never counts:
    // its brace is not code, so the depth after it is unchanged and the line
    // itself would have to be the closing `}`.
    const open = lines[j];
    if (open === undefined || stripCr(open.raw) !== 'afterEvaluate {') {
        return null;
    }
    // Braces balance, so some line from j on returns to the opener's depth.
    const close = lines.findIndex((line, k) => k >= j && line.depthAfter === open.depth);
    return stripCr(lines[close].raw) === '}' ? close : null;
}
/**
 * Leaves exactly one hook: the marker and, on the very next line, the
 * apply line. A complete hook (this version's or an earlier inline one)
 * keeps its place; every other Bugsee leftover — a marker without its
 * apply line, an apply line without its marker, a second hook — goes, one
 * line at a time, and nothing else is touched. Only Bugsee's exact lines
 * count: a user's fork of the script, an apply inside a block, or a line
 * with more after it is user code. With no complete hook the new one is
 * appended.
 */
function ensureHermesHooks(source) {
    const rewritten = rewriteHermesCommand(source);
    const s = scan(rewritten, APP_GRADLE);
    const eol = eolOf(rewritten);
    const cr = crOf(eol);
    const kept = [];
    let hookAt = -1;
    for (let i = 0; i < s.lines.length; i += 1) {
        const line = s.lines[i];
        let end = null;
        if (isMarker(line, SOURCEMAPS_HOOK_MARKER)) {
            end = isOwnStatement(s.lines[i + 1], SOURCEMAPS_APPLY) ? i + 1 : null;
        }
        else if (isMarker(line, LEGACY_HOOK_MARKER)) {
            end = legacyHookEnd(s.lines, i);
        }
        else if (!isOwnStatement(line, SOURCEMAPS_APPLY)) {
            kept.push(line.raw);
            continue;
        }
        if (end !== null) {
            hookAt = hookAt < 0 ? kept.length : hookAt;
            i = end;
        }
    }
    if (hookAt >= 0) {
        kept.splice(hookAt, 0, `${SOURCEMAPS_HOOK_MARKER}${cr}`, `${SOURCEMAPS_APPLY}${cr}`);
        return kept.join('\n');
    }
    return appendBlock(kept.join('\n'), `${SOURCEMAPS_HOOK_MARKER}\n${SOURCEMAPS_APPLY}`, eol);
}
const UPLOADS_OFF_MARKER = '// bugsee-upload-symbols-off:';
const UPLOADS_OFF_BLOCK = [
    `${UPLOADS_OFF_MARKER} uploadSymbols is false in the Expo config. The Bugsee`,
    '// Gradle plugin 4.0.7 has no switch for its mapping, NDK symbol and build',
    '// uploads, so their tasks are turned off here.',
    "tasks.matching { it.name.startsWith('uploadBugsee') }.configureEach { enabled = false }",
];
/**
 * `uploadSymbols: false` on Android: disables every `uploadBugsee*` task
 * (mapping, NDK symbols, build info) inside a marked block. On again
 * removes exactly that block.
 */
function ensureSymbolUploads(appBuildGradle, enabled) {
    return guarded(APP_GRADLE, () => symbolUploads(appBuildGradle, enabled));
}
function symbolUploads(appBuildGradle, enabled) {
    const s = scan(appBuildGradle, APP_GRADLE);
    const at = findOwnBlock(s, UPLOADS_OFF_BLOCK);
    if (enabled) {
        if (at < 0) {
            return appBuildGradle;
        }
        const lines = appBuildGradle.split('\n');
        removeBlock(lines, at, at + UPLOADS_OFF_BLOCK.length - 1);
        return lines.join('\n');
    }
    if (at >= 0) {
        return appBuildGradle;
    }
    return appendBlock(appBuildGradle, UPLOADS_OFF_BLOCK.join('\n'), eolOf(appBuildGradle));
}
const UPLOAD_SOURCEMAPS_KEY = 'bugseeUploadSourcemaps';
/**
 * `uploadSourcemaps: false` writes `bugseeUploadSourcemaps=false` into
 * android/gradle.properties, which the finish hook reads. On (the default)
 * removes that key.
 */
function applyUploadSourcemapsProperty(properties, enabled) {
    const kept = properties.filter((item) => !(item.type === 'property' && item.key === UPLOAD_SOURCEMAPS_KEY));
    if (enabled) {
        return kept;
    }
    return [...kept, { type: 'property', key: UPLOAD_SOURCEMAPS_KEY, value: 'false' }];
}
//# sourceMappingURL=gradle.js.map