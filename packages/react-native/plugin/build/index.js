"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_GRADLE_NOT_GROOVY = void 0;
exports.gradleNotGroovy = gradleNotGroovy;
exports.platformToken = platformToken;
exports.listSchemes = listSchemes;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const config_plugins_1 = require("@expo/config-plugins");
const bundle_phase_1 = require("./bundle-phase");
const dsym_script_1 = require("./dsym-script");
const gradle_1 = require("./gradle");
const manifest_1 = require("./manifest");
const native_versions_1 = require("./native-versions");
const properties_1 = require("./properties");
const scheme_1 = require("./scheme");
exports.APP_GRADLE_NOT_GROOVY = `${gradle_1.CANNOT_EDIT} android/app/build.gradle: it is written in the Kotlin DSL (build.gradle.kts), which ` +
    '@bugsee/react-native does not edit. Apply scripts/bugsee-sourcemaps.gradle and set react.hermesCommand by hand ' +
    '(see the package README, "Android source maps"), then run expo prebuild again';
/** The settings or root Gradle file is Kotlin; the plugin edits Groovy only. */
function gradleNotGroovy(file) {
    return (`${gradle_1.CANNOT_EDIT} ${file}: it is written in the Kotlin DSL, which @bugsee/react-native does not edit. ` +
        'Make the Bugsee edits by hand (package README, "Android source maps"), then run expo prebuild again');
}
// One function per file, shared by the mods and by the check that runs them
// all first: a refusal in any file then leaves every file as it was.
function editSettingsGradle(file) {
    if (file.language !== 'groovy') {
        throw new Error(gradleNotGroovy('android/settings.gradle'));
    }
    return (0, gradle_1.ensureMavenCentral)(file.contents);
}
function editProjectBuildGradle(file, edits) {
    if (file.language !== 'groovy') {
        throw new Error(gradleNotGroovy('android/build.gradle'));
    }
    return (0, gradle_1.ensureGradlePluginDeclared)(file.contents, edits.gradlePluginVersion);
}
function editAppBuildGradle(file, edits) {
    if (file.language !== 'groovy') {
        throw new Error(exports.APP_GRADLE_NOT_GROOVY);
    }
    return (0, gradle_1.ensureSymbolUploads)((0, gradle_1.ensureAppAppliesPlugin)(file.contents, edits.ndkVersion), edits.uploadSymbols);
}
/** Runs every Gradle edit on the files as they are on disk, writing nothing. */
async function refuseUnlessEditable(projectRoot, edits) {
    editSettingsGradle(await config_plugins_1.AndroidConfig.Paths.getSettingsGradleAsync(projectRoot));
    editProjectBuildGradle(await config_plugins_1.AndroidConfig.Paths.getProjectBuildGradleAsync(projectRoot), edits);
    editAppBuildGradle(await config_plugins_1.AndroidConfig.Paths.getAppBuildGradleAsync(projectRoot), edits);
}
const TOKEN_SHAPE = /^[0-9A-Za-z._-]+$/;
/** The token for one platform, or undefined. Refuses anything that is not token-shaped. */
function platformToken(appToken, platform) {
    const token = typeof appToken === 'string' ? appToken : appToken?.[platform];
    if (token === undefined || token === '') {
        return undefined;
    }
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
        throw new Error(`@bugsee/react-native: the ${platform} appToken is not a Bugsee app token`);
    }
    return token;
}
const withBugsee = (config, props) => {
    const options = props ?? {};
    const androidToken = platformToken(options.appToken, 'android');
    const iosToken = platformToken(options.appToken, 'ios');
    const uploadSourcemaps = options.uploadSourcemaps !== false;
    const uploadSymbols = options.uploadSymbols !== false;
    const versions = (0, native_versions_1.loadNativeVersions)(__dirname);
    const edits = {
        gradlePluginVersion: options.gradlePluginVersion ?? versions.gradlePlugin,
        ndkVersion: options.nativeCrashReporting === false ? null : versions.sdk,
        uploadSymbols,
    };
    config = (0, config_plugins_1.withSettingsGradle)(config, (cfg) => {
        cfg.modResults.contents = editSettingsGradle(cfg.modResults);
        return cfg;
    });
    config = (0, config_plugins_1.withProjectBuildGradle)(config, (cfg) => {
        cfg.modResults.contents = editProjectBuildGradle(cfg.modResults, edits);
        return cfg;
    });
    config = (0, config_plugins_1.withAppBuildGradle)(config, (cfg) => {
        cfg.modResults.contents = editAppBuildGradle(cfg.modResults, edits);
        return cfg;
    });
    config = (0, config_plugins_1.withGradleProperties)(config, (cfg) => {
        cfg.modResults = (0, gradle_1.applyUploadSourcemapsProperty)(cfg.modResults, uploadSourcemaps);
        return cfg;
    });
    config = (0, config_plugins_1.withDangerousMod)(config, [
        'android',
        async (cfg) => {
            // Dangerous mods run first: a Gradle file the plugin cannot edit is
            // refused here, before any file is written.
            await refuseUnlessEditable(cfg.modRequest.projectRoot, edits);
            await (0, promises_1.writeFile)((0, node_path_1.join)(cfg.modRequest.platformProjectRoot, 'bugsee.properties'), (0, properties_1.bugseePropertiesText)({
                appToken: androidToken,
                nativeCrashReporting: options.nativeCrashReporting,
            }));
            return cfg;
        },
    ]);
    config = (0, config_plugins_1.withAndroidManifest)(config, (cfg) => {
        const token = (0, manifest_1.manifestAutoLaunchToken)({ appToken: androidToken, autoLaunch: options.autoLaunch });
        if (!token) {
            return cfg;
        }
        const mainApplication = config_plugins_1.AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
        config_plugins_1.AndroidConfig.Manifest.addMetaDataItemToMainApplication(mainApplication, 'com.bugsee.app-token', token);
        return cfg;
    });
    config = (0, config_plugins_1.withXcodeProject)(config, (cfg) => {
        (0, bundle_phase_1.rewriteProjectBundlePhase)(cfg.modResults, {
            uploadSourcemaps,
            // Only the upload reads it; the Archive action carries its own copy.
            iosAppToken: uploadSourcemaps ? iosToken : undefined,
        });
        return cfg;
    });
    config = (0, config_plugins_1.withDangerousMod)(config, [
        'ios',
        async (cfg) => {
            const script = (0, dsym_script_1.dsymPostActionScript)(iosToken);
            for (const schemePath of listSchemes(cfg.modRequest.platformProjectRoot)) {
                const xml = await (0, promises_1.readFile)(schemePath, 'utf8');
                const next = uploadSymbols ? (0, scheme_1.insertDsymPostAction)(xml, script) : (0, scheme_1.removeDsymPostAction)(xml);
                if (next !== xml) {
                    await (0, promises_1.writeFile)(schemePath, next);
                }
            }
            return cfg;
        },
    ]);
    return config;
};
/** Shared schemes of every .xcodeproj under ios/. Throws when there are none. */
function listSchemes(iosRoot) {
    let entries;
    try {
        entries = (0, node_fs_1.readdirSync)(iosRoot);
    }
    catch (error) {
        throw new Error(`ios project not found at ${iosRoot}`, { cause: error });
    }
    const schemes = [];
    for (const entry of entries) {
        if (!entry.endsWith('.xcodeproj')) {
            continue;
        }
        const dir = (0, node_path_1.join)(iosRoot, entry, 'xcshareddata', 'xcschemes');
        let names;
        try {
            names = (0, node_fs_1.readdirSync)(dir);
        }
        catch {
            continue;
        }
        for (const name of names) {
            if (name.endsWith('.xcscheme')) {
                schemes.push((0, node_path_1.join)(dir, name));
            }
        }
    }
    if (schemes.length === 0) {
        throw new Error(`no shared xcscheme under ${iosRoot}`);
    }
    return schemes;
}
exports.default = (0, config_plugins_1.createRunOncePlugin)(withBugsee, '@bugsee/react-native', '0.0.0');
//# sourceMappingURL=index.js.map