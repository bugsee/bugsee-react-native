"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
 * are the JS source-map path, so they are written either way. After the
 * debug id is final the hook uploads the composed map, unless
 * `bugseeUploadSourcemaps=false` or no real token is configured.
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
const PRESERVE_REFUSAL = 'Bugsee preserve directory is the packaged asset directory';
/** First line of the finish hook; marks it for replacement. */
const FINISH_HOOK_MARKER = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
const HERMES_FINISH_HOOK = [
    FINISH_HOOK_MARKER,
    '// finish injects the debug id into the composed map and the bytecode, then',
    '// uploads that map (hermes-sourcemaps.js runs the CLI) when android/bugsee.properties (or',
    '// BUGSEE_APP_TOKEN) holds a real token. bugseeUploadSourcemaps=false in',
    '// gradle.properties, or BUGSEE_UPLOAD_SOURCEMAPS=false, turns the upload off;',
    '// a placeholder or missing token skips it with one line. A failed upload',
    '// warns and the build goes on.',
    'def bugseeHermesSourcemaps = new File(new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/hermes-sourcemaps.js")',
    'def bugseeComposeSourceMaps = new File(new File(["node", "--print", "require.resolve(\'react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/compose-source-maps.js")',
    'afterEvaluate {',
    "    def bugseeUploadSourcemaps = String.valueOf(findProperty('bugseeUploadSourcemaps') ?: 'true')",
    "    def bugseeAppVersion = String.valueOf(android.defaultConfig.versionName ?: '')",
    "    def bugseeAppBuild = String.valueOf(android.defaultConfig.versionCode ?: '')",
    '    def bugseeProperties = rootProject.file("bugsee.properties")',
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
    '            def hermescNote = new File(preserveDir, asset + ".bugsee-hermesc")',
    '            def packagedCopies = [',
    '                new File(assetDir, asset + ".bugsee-js-source"),',
    '                new File(assetDir, asset + ".bugsee-hermesc"),',
    '                new File(assetDir, asset + ".bugsee-recompile"),',
    '                new File(assetDir, asset + ".bugsee-recompile.map"),',
    '            ]',
    '            try {',
    '                if (!bundleTask.hermesEnabled.get()) {',
    '                    // hermesc did not run, so a preserve file here is an earlier build\'s.',
    '                    bundleTask.logger.lifecycle("bugsee: Hermes is off for ${bundleTask.name}; no debug id is injected")',
    '                } else if (!preserved.isFile()) {',
    '                    bundleTask.logger.warn("bugsee: ${bundleTask.name} ran hermesc without hermesc-preserve-js.sh " +',
    '                        "(check react.hermesCommand); no debug id is injected and no source map is uploaded")',
    '                } else {',
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
    '                        "--platform", "android",',
    '                        "--properties", bugseeProperties.absolutePath,',
    '                        "--upload-sourcemaps", bugseeUploadSourcemaps,',
    '                        "--app-version", bugseeAppVersion,',
    '                        "--app-build", bugseeAppBuild,',
    '                    ])',
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
    '                // This build\'s only: a later build must never recompile them.',
    '                preserved.delete()',
    '                hermescNote.delete()',
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
/**
 * The hook runs from its marker comment to the brace closing the first
 * `afterEvaluate {` after it. A hook an earlier version wrote (without the
 * upload, or still calling `project.exec`, which Gradle 9 removed) is
 * replaced whole. Returns null when there is no complete hook.
 */
function finishHookExtent(source) {
    const start = source.indexOf(FINISH_HOOK_MARKER);
    if (start < 0) {
        return null;
    }
    const open = source.indexOf('afterEvaluate {', start);
    if (open < 0) {
        return null;
    }
    const close = matchingBrace(source, source.indexOf('{', open));
    return close === null ? null : { start, end: close + 1 };
}
function ensureHermesHooks(source) {
    const rewritten = rewriteHermesCommand(source);
    const extent = finishHookExtent(rewritten);
    if (extent) {
        return rewritten.slice(0, extent.start) + HERMES_FINISH_HOOK + rewritten.slice(extent.end);
    }
    return `${rewritten.replace(/\s*$/, '')}\n\n${HERMES_FINISH_HOOK}\n`;
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