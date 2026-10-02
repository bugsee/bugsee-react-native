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
        return ensureNdkExcluded(dropNdkImplementation(next));
    }
    next = dropNdkExclude(next);
    if (/implementation\s+["']com\.bugsee:bugsee-android-ndk:/.test(next)) {
        return next;
    }
    if (!/^[0-9A-Za-z.+_-]+$/.test(ndkVersion)) {
        throw new Error(`refusing NDK artifact version ${ndkVersion}`);
    }
    const dep = `    implementation "com.bugsee:bugsee-android-ndk:${ndkVersion}"`;
    const deps = next.indexOf('dependencies {');
    if (deps < 0) {
        return `${next.replace(/\s*$/, '')}\n\ndependencies {\n${dep}\n}\n`;
    }
    const brace = next.indexOf('{', deps);
    return `${next.slice(0, brace + 1)}\n${dep}${next.slice(brace + 1)}`;
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
//# sourceMappingURL=gradle.js.map