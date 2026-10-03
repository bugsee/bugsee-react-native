"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureMavenCentral = ensureMavenCentral;
exports.ensureGradlePluginDeclared = ensureGradlePluginDeclared;
exports.ensureAppAppliesPlugin = ensureAppAppliesPlugin;
const PLUGIN_ID = 'com.bugsee.android.gradle';
function blockExtent(source, keyword) {
    const start = source.indexOf(keyword);
    if (start < 0) {
        return null;
    }
    const open = source.indexOf('{', start);
    if (open < 0) {
        return null;
    }
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
        const insertAt = extent.bodyStart + repositories.bodyEnd;
        return (settingsGradle.slice(0, insertAt) +
            '\n        mavenCentral()' +
            settingsGradle.slice(insertAt));
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
function ensureGradlePluginDeclared(projectBuildGradle, version) {
    if (!/^[0-9A-Za-z.+_-]+$/.test(version)) {
        throw new Error(`refusing Gradle plugin version ${version}`);
    }
    if (projectBuildGradle.includes(PLUGIN_ID)) {
        return projectBuildGradle;
    }
    // apply false: the plugin has to be applied on the application module.
    // Applied to the root project it fails configuration, because it hangs
    // its tasks off an Android variant.
    const declaration = [
        '',
        'plugins {',
        `    id '${PLUGIN_ID}' version '${version}' apply false`,
        '}',
        '',
    ].join('\n');
    // plugins {} has to stay with the buildscript block. A later allprojects
    // or apply statement makes Gradle reject the block.
    const buildscript = blockExtent(projectBuildGradle, 'buildscript');
    if (buildscript) {
        const at = buildscript.bodyEnd + 1;
        return projectBuildGradle.slice(0, at) + declaration + projectBuildGradle.slice(at);
    }
    return declaration + projectBuildGradle;
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
 * does not upload.
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
function ensureNdkImplementation(source, ndkVersion) {
    if (/implementation\s+["']com\.bugsee:bugsee-android-ndk:/.test(source)) {
        return source;
    }
    if (!/^[0-9A-Za-z.+_-]+$/.test(ndkVersion)) {
        throw new Error(`refusing NDK artifact version ${ndkVersion}`);
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
    let start = at;
    if (start > 0 && source[start - 1] === '\n') {
        start -= 1;
    }
    let end = at + NDK_EXCLUDE_BLOCK.length;
    while (end < source.length && source[end] === '\n') {
        end += 1;
    }
    const next = source.slice(0, start) + source.slice(end);
    return next.endsWith('\n') || next.length === 0 ? next : `${next}\n`;
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
        .map((line) => (line.length === 0 ? line : indent + line))
        .join('\n');
}
function insertSymbolTable(source, span) {
    const body = source.slice(span.open + 1, span.close);
    if (body.includes(SYMBOL_TABLE_MARKER) ||
        /debugSymbolLevel\s+(['"])SYMBOL_TABLE\1/.test(body) ||
        /\bndk\s*\{/.test(body)) {
        return source;
    }
    const closing = /\n([ \t]*)$/.exec(body);
    const closingIndent = closing?.[1] ?? '';
    const block = indentBlock(SYMBOL_TABLE_BLOCK, `${closingIndent}    `);
    if (!closing) {
        return `${source.slice(0, span.close)}\n${block}\n${source.slice(span.close)}`;
    }
    const indentStart = span.close - closingIndent.length;
    return `${source.slice(0, indentStart)}${block}\n${closingIndent}${source.slice(span.close)}`;
}
function ensureSymbolTable(source, enabled) {
    if (!enabled) {
        return removeInsertedSymbolTable(source);
    }
    const spans = buildTypeSpans(source).sort((a, b) => b.open - a.open);
    return spans.reduce((current, span) => insertSymbolTable(current, span), source);
}
function removeInsertedSymbolTable(source) {
    const lines = source.split('\n');
    const kept = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line === undefined || !line.includes(SYMBOL_TABLE_MARKER)) {
            if (line !== undefined) {
                kept.push(line);
            }
            i += 1;
            continue;
        }
        let j = i;
        while (j < lines.length && (lines[j] ?? '').trim().startsWith('//')) {
            j += 1;
        }
        if ((lines[j] ?? '').trim() === 'ndk {') {
            j += 1;
            while (j < lines.length && (lines[j] ?? '').trim() !== '}') {
                j += 1;
            }
            if ((lines[j] ?? '').trim() === '}') {
                j += 1;
            }
            i = j;
            continue;
        }
        kept.push(line);
        i += 1;
    }
    return kept.join('\n');
}
const HERMES_COMMAND_EXPR = 'new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/scripts/hermesc-preserve-js.sh"';
const PRESERVE_REFUSAL = 'Bugsee preserve directory is the packaged asset directory';
const HERMES_FINISH_HOOK = [
    '// After compose-source-maps.js. Release variants only; debug does not bundle.',
    '// Upload is not invoked.',
    'def bugseeHermesSourcemaps = new File(new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/hermes-sourcemaps.js")',
    'def bugseeComposeSourceMaps = new File(new File(["node", "--print", "require.resolve(\'react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/compose-source-maps.js")',
    'afterEvaluate {',
    '    tasks.matching { task ->',
    '        task.name.startsWith("createBundle") && task.name.endsWith("JsAndAssets")',
    '    }.configureEach { bundleTask ->',
    '        bundleTask.doLast {',
    '            def asset = bundleTask.bundleAssetName.get()',
    '            def assetDir = bundleTask.jsBundleDir.get().asFile',
    '            // Same rewrite as hermesc-preserve-js.sh: assets are packaged, intermediates are not.',
    '            def preserveDir = new File(assetDir.absolutePath.replace(',
    '                "/generated/assets/",',
    '                "/intermediates/bugsee-sourcemaps/"',
    '            ))',
    '            if (preserveDir.absolutePath == assetDir.absolutePath) {',
    `                throw new GradleException("${PRESERVE_REFUSAL}")`,
    '            }',
    '            def preserved = new File(preserveDir, asset + ".bugsee-js-source")',
    '            def packagedCopies = [',
    '                new File(assetDir, asset + ".bugsee-js-source"),',
    '                new File(assetDir, asset + ".bugsee-hermesc"),',
    '                new File(assetDir, asset + ".bugsee-recompile"),',
    '                new File(assetDir, asset + ".bugsee-recompile.map"),',
    '            ]',
    '            try {',
    '                if (preserved.isFile()) {',
    '                    def composed = new File(bundleTask.jsSourceMapsDir.get().asFile, asset + ".map")',
    '                    def interDir = bundleTask.jsIntermediateSourceMapsDir.get().asFile',
    '                    def hook = bugseeHermesSourcemaps',
    '                    def compose = bugseeComposeSourceMaps',
    '                    def cmd = []',
    '                    cmd.addAll(bundleTask.nodeExecutableAndArgs.get())',
    '                    cmd.addAll([',
    '                        hook.absolutePath, "finish",',
    '                        "--bundle", preserved.absolutePath,',
    '                        "--bytecode", new File(assetDir, asset).absolutePath,',
    '                        "--composed", composed.absolutePath,',
    '                        "--intermediate", new File(interDir, asset + ".compiler.map").absolutePath,',
    '                        "--packager", new File(interDir, asset + ".packager.map").absolutePath,',
    '                        "--compose", compose.absolutePath,',
    '                    ])',
    '                    def hermescNote = new File(preserveDir, asset + ".bugsee-hermesc")',
    '                    if (hermescNote.isFile()) {',
    '                        cmd.add("--hermesc")',
    '                        cmd.add(hermescNote.getText("UTF-8").trim())',
    '                    }',
    '                    bundleTask.hermesFlags.get().each { flag ->',
    '                        cmd.add("--hermes-arg")',
    '                        cmd.add(flag)',
    '                    }',
    '                    // Gradle 9 removed Project.exec.',
    '                    bundleTask.services.get(org.gradle.process.ExecOperations).exec {',
    '                        commandLine cmd',
    '                    }',
    '                }',
    '            } finally {',
    '                packagedCopies.each { copy -> copy.delete() }',
    '            }',
    '        }',
    '    }',
    '}',
].join('\n');
function rewriteHermesCommand(source) {
    return source.replace(/^([ \t]*)hermesCommand\s*=\s*.+$/gm, (line, indent) => {
        if (line.includes('hermesc-preserve-js.sh')) {
            return line;
        }
        return `${indent}hermesCommand = ${HERMES_COMMAND_EXPR}`;
    });
}
const FINISH_EXEC_LINE = 'bundleTask.services.get(org.gradle.process.ExecOperations).exec {';
/**
 * Gradle 9 removed `Project.exec`. A finish hook written before that still
 * calls it from the `doLast` that runs `hermes-sourcemaps.js finish`. Replace
 * only that line, keeping its indentation. Any other `project.exec` in the
 * file stays. A hook that already uses ExecOperations is unchanged.
 */
function migrateFinishHookExec(source) {
    const marker = source.indexOf(PRESERVE_REFUSAL);
    if (marker < 0) {
        return source;
    }
    const finishCall = source.indexOf('"finish"', marker);
    if (finishCall < 0) {
        return source;
    }
    const doLastAt = source.lastIndexOf('bundleTask.doLast {', finishCall);
    if (doLastAt < 0) {
        return source;
    }
    const open = source.indexOf('{', doLastAt);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') {
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0 || finishCall > end) {
        return source;
    }
    const region = source.slice(finishCall, end + 1);
    const replaced = region.replace(/^([ \t]*)project\.exec \{$/m, `$1${FINISH_EXEC_LINE}`);
    if (replaced === region) {
        return source;
    }
    return source.slice(0, finishCall) + replaced + source.slice(end + 1);
}
function ensureHermesHooks(source) {
    const rewritten = rewriteHermesCommand(source);
    if (rewritten.includes(PRESERVE_REFUSAL)) {
        return migrateFinishHookExec(rewritten);
    }
    return `${rewritten.replace(/\s*$/, '')}\n\n${HERMES_FINISH_HOOK}\n`;
}
//# sourceMappingURL=gradle.js.map