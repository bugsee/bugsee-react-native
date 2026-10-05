"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HERMES_COMMAND_UNREWRITABLE = void 0;
exports.ensureMavenCentral = ensureMavenCentral;
exports.ensureGradlePluginDeclared = ensureGradlePluginDeclared;
exports.ensureAppAppliesPlugin = ensureAppAppliesPlugin;
exports.ensureSymbolUploads = ensureSymbolUploads;
exports.applyUploadSourcemapsProperty = applyUploadSourcemapsProperty;
const PLUGIN_ID = 'com.bugsee.android.gradle';
function blockExtent(source, keyword) {
    const start = source.indexOf(keyword);
    if (start < 0) {
        return null;
    }
    // No brace after the keyword: the loop finds none and returns null.
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') {
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return { bodyStart: open + 1, bodyEnd: i };
            }
        }
    }
    return null;
}
/**
 * The plugin marker is on Maven Central, not the Plugin Portal. Declaring
 * any repositories block replaces Gradle's implicit Plugin Portal, so a
 * missing block gets the portal, Google, and Maven Central together.
 */
function ensureMavenCentral(settingsGradle) {
    const extent = blockExtent(settingsGradle, 'pluginManagement');
    if (!extent) {
        const header = [
            'pluginManagement {',
            '    repositories {',
            '        gradlePluginPortal()',
            '        google()',
            '        mavenCentral()',
            '    }',
            '}',
            '',
        ].join('\n');
        return header + settingsGradle;
    }
    const body = settingsGradle.slice(extent.bodyStart, extent.bodyEnd);
    if (/mavenCentral\s*\(/.test(body)) {
        return settingsGradle;
    }
    const repositories = blockExtent(body, 'repositories');
    if (repositories) {
        // After the last entry, so the closing brace keeps its own line.
        const inner = body.slice(repositories.bodyStart, repositories.bodyEnd);
        const insertAt = extent.bodyStart + repositories.bodyStart + inner.trimEnd().length;
        return `${settingsGradle.slice(0, insertAt)}\n        mavenCentral()${settingsGradle.slice(insertAt)}`;
    }
    const addition = [
        '',
        '    repositories {',
        '        gradlePluginPortal()',
        '        google()',
        '        mavenCentral()',
        '    }',
        '',
    ].join('\n');
    return (settingsGradle.slice(0, extent.bodyEnd) + addition + settingsGradle.slice(extent.bodyEnd));
}
const DECLARED_VERSION = /(id\s*\(?\s*['"]com\.bugsee\.android\.gradle['"]\s*\)?\s+version\s*\(?\s*['"])([^'"]*)(['"])/;
/**
 * Declares the plugin `apply false` on the root project. A declaration from
 * an earlier prebuild gets this version written over its own, so a
 * `--no-clean` prebuild after a wrapper bump does not keep the old pin.
 */
function ensureGradlePluginDeclared(projectBuildGradle, version) {
    if (!/^[0-9A-Za-z.+_-]+$/.test(version)) {
        throw new Error(`refusing Gradle plugin version ${version}`);
    }
    if (projectBuildGradle.includes(PLUGIN_ID)) {
        return projectBuildGradle.replace(DECLARED_VERSION, `$1${version}$3`);
    }
    // apply false: the plugin has to be applied on the application module.
    // Applied to the root project it fails configuration, because it hangs
    // its tasks off an Android variant.
    const declaration = `plugins {\n    id '${PLUGIN_ID}' version '${version}' apply false\n}\n`;
    // plugins {} has to stay with the buildscript block. A later allprojects
    // or apply statement makes Gradle reject the block.
    const buildscript = blockExtent(projectBuildGradle, 'buildscript');
    if (buildscript) {
        const at = buildscript.bodyEnd + 1;
        return `${projectBuildGradle.slice(0, at)}\n${declaration}${projectBuildGradle.slice(at)}`;
    }
    return `${declaration}\n${projectBuildGradle}`;
}
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
 * On (omitted or a version) also writes `debugSymbolLevel 'SYMBOL_TABLE'`
 * on existing debug and release build types when that block is absent.
 * Off removes only the block this plugin inserted. Maven Hermes and
 * `libreactnative.so` are pre-stripped; the comment does not claim those
 * two are symbolicated. The Hermes preserve command and the finish hook
 * are the JS source-map path, so they are written either way. The hook
 * applies the package's scripts/bugsee-sourcemaps.gradle, which injects the
 * debug id and uploads the composed map unless `bugseeUploadSourcemaps=false`
 * or no real token is configured.
 */
function ensureAppAppliesPlugin(appBuildGradle, ndkVersion) {
    let next = appBuildGradle;
    if (!next.includes(PLUGIN_ID)) {
        const react = 'apply plugin: "com.facebook.react"';
        if (next.includes(react)) {
            next = next.replace(react, `${react}\napply plugin: "${PLUGIN_ID}"`);
        }
        else {
            next = `apply plugin: "${PLUGIN_ID}"\n${next}`;
        }
    }
    if (ndkVersion === null) {
        next = ensureNdkExcluded(dropNdkImplementation(next));
    }
    else {
        next = dropNdkExclude(next);
        next = ensureNdkImplementation(next, ndkVersion);
    }
    next = ensureSymbolTable(next, ndkVersion !== null);
    return ensureHermesHooks(next);
}
const NDK_IMPLEMENTATION_VERSION = /(implementation\s+["']com\.bugsee:bugsee-android-ndk:)([^"']*)(["'])/;
function ensureNdkImplementation(source, ndkVersion) {
    if (!/^[0-9A-Za-z.+_-]+$/.test(ndkVersion)) {
        throw new Error(`refusing NDK artifact version ${ndkVersion}`);
    }
    if (NDK_IMPLEMENTATION_VERSION.test(source)) {
        return source.replace(NDK_IMPLEMENTATION_VERSION, `$1${ndkVersion}$3`);
    }
    const dep = `    implementation "com.bugsee:bugsee-android-ndk:${ndkVersion}"`;
    const deps = source.indexOf('dependencies {');
    if (deps < 0) {
        return `${source.replace(/\s*$/, '')}\n\ndependencies {\n${dep}\n}\n`;
    }
    const brace = source.indexOf('{', deps);
    return `${source.slice(0, brace + 1)}\n${dep}${source.slice(brace + 1)}`;
}
const NDK_IMPLEMENTATION = /^\s*implementation\s+["']com\.bugsee:bugsee-android-ndk:/;
function dropNdkImplementation(source) {
    return source
        .split('\n')
        .filter((line) => !NDK_IMPLEMENTATION.test(line))
        .join('\n');
}
const NDK_EXCLUDE_BLOCK = [
    'configurations.configureEach {',
    `    ${NDK_EXCLUDE}`,
    '}',
].join('\n');
function ensureNdkExcluded(source) {
    if (source.includes(NDK_EXCLUDE_BLOCK)) {
        return source;
    }
    const block = ['', NDK_EXCLUDE_BLOCK, ''].join('\n');
    return `${source.replace(/\s*$/, '')}\n${block}`;
}
function dropNdkExclude(source) {
    const at = source.indexOf(NDK_EXCLUDE_BLOCK);
    if (at < 0) {
        return source;
    }
    // ensureHermesHooks normalises the file's trailing whitespace afterwards.
    const start = source[at - 1] === '\n' ? at - 1 : at;
    let end = at + NDK_EXCLUDE_BLOCK.length;
    while (source[end] === '\n') {
        end += 1;
    }
    return source.slice(0, start) + source.slice(end);
}
/** Identifies the ndk block this plugin inserted, so a user's block stays. */
const SYMBOL_TABLE_MARKER = 'bugsee-symbol-table:';
const SYMBOL_TABLE_BLOCK = [
    '// bugsee-symbol-table: AGP defaults this to NONE, so the plugin\'s native upload finds',
    '// nothing and skips. SYMBOL_TABLE emits symbols for code this app',
    '// builds. Maven Hermes and libreactnative.so are pre-stripped;',
    '// this level does not symbolicate those two.',
    'ndk {',
    "    debugSymbolLevel 'SYMBOL_TABLE'",
    '}',
].join('\n');
function matchingBrace(source, open) {
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
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
    return null;
}
function buildTypeSpans(source) {
    const extent = blockExtent(source, 'buildTypes');
    if (!extent) {
        return [];
    }
    const body = source.slice(extent.bodyStart, extent.bodyEnd);
    const spans = [];
    let depth = 0;
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === '{') {
            if (depth === 0) {
                const named = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(body.slice(0, i));
                const name = named?.[1];
                if (name === 'debug' || name === 'release') {
                    const open = extent.bodyStart + i;
                    const close = matchingBrace(source, open);
                    if (close != null) {
                        spans.push({ name, open, close });
                    }
                }
            }
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
        }
    }
    return spans;
}
function indentBlock(block, indent) {
    return block
        .split('\n')
        .map((line) => indent + line)
        .join('\n');
}
function insertSymbolTable(source, span) {
    const body = source.slice(span.open + 1, span.close);
    if (body.includes(SYMBOL_TABLE_MARKER) ||
        /debugSymbolLevel\s+(['"])SYMBOL_TABLE\1/.test(body) ||
        /\bndk\s*\{/.test(body)) {
        return source;
    }
    // The block goes last, one level deeper than the line the build type opens
    // on, and the closing brace gets its own line at that line's indentation.
    // A one-line `release { minifyEnabled true }` is split the same way.
    const lineStart = source.lastIndexOf('\n', span.open) + 1;
    const line = source.slice(lineStart, span.open);
    const lineIndent = line.slice(0, line.length - line.trimStart().length);
    const block = indentBlock(SYMBOL_TABLE_BLOCK, `${lineIndent}    `);
    return `${source.slice(0, span.close).trimEnd()}\n${block}\n${lineIndent}${source.slice(span.close)}`;
}
function ensureSymbolTable(source, enabled) {
    if (!enabled) {
        return removeInsertedSymbolTable(source);
    }
    const spans = buildTypeSpans(source).sort((a, b) => b.open - a.open);
    return spans.reduce((current, span) => insertSymbolTable(current, span), source);
}
/**
 * Index of the `}` closing the `ndk {` block that follows the marker's
 * comment lines, or null when the marker does not start such a block.
 */
function insertedBlockEnd(lines, start) {
    let j = start;
    while (j < lines.length && lines[j].trim().startsWith('//')) {
        j += 1;
    }
    const open = lines[j];
    if (open?.trim() !== 'ndk {') {
        return null;
    }
    // The block this plugin writes closes at the indentation it opened at.
    const closing = `${open.slice(0, open.indexOf('ndk {'))}}`;
    const close = lines.findIndex((line, k) => k > j && line.trimEnd() === closing);
    // An unclosed block is left alone rather than cut to the end of the file.
    return close < 0 ? null : close;
}
function removeInsertedSymbolTable(source) {
    const lines = source.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const end = line.includes(SYMBOL_TABLE_MARKER) ? insertedBlockEnd(lines, i) : null;
        if (end === null) {
            kept.push(line);
        }
        else {
            i = end;
        }
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
const SOURCEMAPS_HOOK = [
    SOURCEMAPS_HOOK_MARKER,
    `apply from: new File(new File(["node", "--print", "require.resolve('@bugsee/react-native/package.json')"].execute(null, rootDir).text.trim()).getParentFile(), "${SOURCEMAPS_SCRIPT}")`,
].join('\n');
/** First line of the inline hook earlier versions wrote. */
const LEGACY_HOOK_MARKER = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
exports.HERMES_COMMAND_UNREWRITABLE = 'react.hermesCommand in android/app/build.gradle spans several lines, so @bugsee/react-native ' +
    'cannot point it at scripts/hermesc-preserve-js.sh. Put it on one line, or delete it, and prebuild again.';
/**
 * A Groovy lexer just deep enough to tell code from comments and strings,
 * line by line: `//` and block comments, '…' and "…" strings (with
 * backslash escapes), and ''' / """ strings across lines. Slashy strings
 * are read as division.
 */
function scanLines(source) {
    const out = [];
    let state = 'code';
    for (const line of source.split('\n')) {
        const start = state;
        let code = '';
        let unclosed = false;
        let i = 0;
        while (i < line.length) {
            if (state !== 'code') {
                const close = state === 'block' ? '*/' : state;
                const at = line.indexOf(close, i);
                if (at < 0) {
                    i = line.length;
                }
                else {
                    code += state === 'block' ? ' ' : 'S';
                    state = 'code';
                    i = at + close.length;
                }
                continue;
            }
            const two = line.slice(i, i + 2);
            const three = line.slice(i, i + 3);
            if (two === '//') {
                break;
            }
            if (two === '/*') {
                state = 'block';
                i += 2;
            }
            else if (three === "'''" || three === '"""') {
                state = three;
                i += 3;
            }
            else if (line[i] === '"' || line[i] === "'") {
                const quote = line[i];
                let j = i + 1;
                while (j < line.length && line[j] !== quote) {
                    j += line[j] === '\\' ? 2 : 1;
                }
                unclosed = unclosed || j >= line.length;
                code += 'S';
                i = j + 1;
            }
            else {
                code += line[i];
                i += 1;
            }
        }
        out.push({ start, code, open: unclosed || state !== 'code' });
    }
    return out;
}
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
const HERMES_COMMAND = /^([ \t]*)hermesCommand(\s*=|\.set\()/;
const REACT_BLOCK = /^\s*react\s*\{\s*$/;
/**
 * Points react.hermesCommand at hermesc-preserve-js.sh. Only code counts:
 * a setting inside a comment or a multi-line string is left alone. A
 * one-line `hermesCommand = …` or `hermesCommand.set(…)` is rewritten,
 * a trailing comment included. Anything this cannot read with certainty
 * (a value that continues on the next line, an open bracket, quote or
 * block comment, nothing after `=`) is refused. A react block without
 * the setting gets one. With no react block the file is left alone, and
 * the bundle task fails with the fix instead.
 */
function rewriteHermesCommand(source) {
    const lines = source.split('\n');
    const scanned = scanLines(source);
    let found = false;
    let react = -1;
    scanned.forEach((scan, i) => {
        if (scan.start !== 'code') {
            return;
        }
        if (react < 0 && REACT_BLOCK.test(scan.code)) {
            react = i;
        }
        const match = HERMES_COMMAND.exec(scan.code);
        if (!match) {
            return;
        }
        found = true;
        if (lines[i].includes('hermesc-preserve-js.sh')) {
            return;
        }
        const value = `${match[2] === '.set(' ? '(' : ''}${scan.code.slice(match[0].length)}`;
        const next = scanned.slice(i + 1).find((later) => later.code.trim().length > 0);
        if (scan.open || !completeExpression(value) || (next !== undefined && CONTINUATION.test(next.code.trim()))) {
            throw new Error(exports.HERMES_COMMAND_UNREWRITABLE);
        }
        lines[i] = `${match[1]}hermesCommand = ${HERMES_COMMAND_EXPR}`;
    });
    if (!found && react >= 0) {
        const indent = /^[ \t]*/.exec(lines[react])?.[0] ?? '';
        lines.splice(react + 1, 0, `${indent}    hermesCommand = ${HERMES_COMMAND_EXPR}`);
    }
    return lines.join('\n');
}
function isApplyLine(line) {
    return line !== undefined && line.trim().startsWith('apply from:') && line.includes(SOURCEMAPS_SCRIPT);
}
/**
 * Index of the last line of an inline hook an earlier version wrote, which
 * starts at `start` with its marker: comment and `def bugsee…` lines, then
 * `afterEvaluate {` through its matching `}`, alone at column 0. Null when
 * the lines after the marker are anything else, so a stray marker never
 * takes user code with it.
 */
function legacyHookEnd(lines, start) {
    let j = start + 1;
    while (j < lines.length && /^(\/\/|def bugsee)/.test(lines[j])) {
        j += 1;
    }
    if (lines[j] !== 'afterEvaluate {') {
        return null;
    }
    // The brace that matches afterEvaluate's, alone on a line at column 0.
    const rest = lines.slice(j).join('\n');
    const close = matchingBrace(rest, rest.indexOf('{'));
    if (close === null) {
        return null;
    }
    const closeLine = j + rest.slice(0, close).split('\n').length - 1;
    return lines[closeLine] === '}' ? closeLine : null;
}
/**
 * Leaves exactly one hook: the marker and, on the very next line, the
 * apply line. A complete hook (this version's or an earlier inline one)
 * keeps its place; every other Bugsee leftover — a marker without its
 * apply line, an apply line without its marker, a second hook — goes, one
 * line at a time, and nothing else is touched. With no complete hook the
 * new one is appended.
 */
function ensureHermesHooks(source) {
    const lines = rewriteHermesCommand(source).split('\n');
    const kept = [];
    let hookAt = -1;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        let end = null;
        if (line === SOURCEMAPS_HOOK_MARKER) {
            end = isApplyLine(lines[i + 1]) ? i + 1 : null;
        }
        else if (line === LEGACY_HOOK_MARKER) {
            end = legacyHookEnd(lines, i);
        }
        else if (!isApplyLine(line)) {
            kept.push(line);
            continue;
        }
        if (end !== null) {
            hookAt = hookAt < 0 ? kept.length : hookAt;
            i = end;
        }
    }
    if (hookAt >= 0) {
        kept.splice(hookAt, 0, SOURCEMAPS_HOOK);
        return kept.join('\n');
    }
    return `${kept.join('\n').replace(/\s*$/, '')}\n\n${SOURCEMAPS_HOOK}\n`;
}
const UPLOADS_OFF_MARKER = '// bugsee-upload-symbols-off:';
const UPLOADS_OFF_BLOCK = [
    `${UPLOADS_OFF_MARKER} uploadSymbols is false in the Expo config. The Bugsee`,
    '// Gradle plugin 4.0.7 has no switch for its mapping, NDK symbol and build',
    '// uploads, so their tasks are turned off here.',
    "tasks.matching { it.name.startsWith('uploadBugsee') }.configureEach { enabled = false }",
].join('\n');
/**
 * `uploadSymbols: false` on Android: disables every `uploadBugsee*` task
 * (mapping, NDK symbols, build info) inside a marked block. On again
 * removes exactly that block.
 */
function ensureSymbolUploads(appBuildGradle, enabled) {
    const at = appBuildGradle.indexOf(UPLOADS_OFF_BLOCK);
    if (enabled) {
        if (at < 0) {
            return appBuildGradle;
        }
        const before = appBuildGradle.slice(0, at).replace(/\n+$/, '\n');
        const after = appBuildGradle.slice(at + UPLOADS_OFF_BLOCK.length).replace(/^\n+/, '');
        return before + after;
    }
    if (at >= 0) {
        return appBuildGradle;
    }
    return `${appBuildGradle.replace(/\s*$/, '')}\n\n${UPLOADS_OFF_BLOCK}\n`;
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