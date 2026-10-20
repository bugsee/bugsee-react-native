"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_GRADLE_NOT_GROOVY = exports.IOS_ENDPOINT_PLIST_KEY = void 0;
exports.gradleNotGroovy = gradleNotGroovy;
exports.platformToken = platformToken;
exports.listSchemes = listSchemes;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const config_plugins_1 = require("@expo/config-plugins");
const bundle_phase_1 = require("./bundle-phase");
const dsym_script_1 = require("./dsym-script");
const endpoint_1 = require("./endpoint");
const gradle_1 = require("./gradle");
const manifest_1 = require("./manifest");
const native_versions_1 = require("./native-versions");
const podfile_1 = require("./podfile");
const properties_1 = require("./properties");
const scheme_1 = require("./scheme");
/** The Info.plist key the iOS native module reads `endpoint` from. */
exports.IOS_ENDPOINT_PLIST_KEY = 'BugseeReactNativeEndpoint';
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
function editAppBuildGradle(file, edits, log = console.warn) {
    if (file.language !== 'groovy') {
        throw new Error(exports.APP_GRADLE_NOT_GROOVY);
    }
    return (0, gradle_1.ensureSymbolUploads)((0, gradle_1.ensureAppAppliesPlugin)(file.contents, edits.ndkVersion, log), edits.uploadSymbols);
}
/** Runs every Gradle edit on the files as they are on disk, writing nothing. */
async function refuseUnlessEditable(projectRoot, edits) {
    editSettingsGradle(await config_plugins_1.AndroidConfig.Paths.getSettingsGradleAsync(projectRoot));
    editProjectBuildGradle(await config_plugins_1.AndroidConfig.Paths.getProjectBuildGradleAsync(projectRoot), edits);
    // The mod that follows logs; the check stays quiet.
    editAppBuildGradle(await config_plugins_1.AndroidConfig.Paths.getAppBuildGradleAsync(projectRoot), edits, () => undefined);
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
    const symbolicateReactNative = options.symbolicateReactNativeFrameworks === true;
    const endpoint = (0, endpoint_1.pluginEndpoint)(options.endpoint);
    const holdFilters = (0, manifest_1.holdFiltersValue)(options.holdFilters);
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
                endpoint,
            }));
            return cfg;
        },
    ]);
    config = (0, config_plugins_1.withAndroidManifest)(config, (cfg) => {
        const token = (0, manifest_1.manifestAutoLaunchToken)({ appToken: androidToken, autoLaunch: options.autoLaunch });
        const edit = (0, manifest_1.endpointMetaData)({
            endpoint,
            autoLaunchToken: token,
            existing: (name) => config_plugins_1.AndroidConfig.Manifest.getMainApplicationMetaDataValue(cfg.modResults, name) ?? undefined,
        });
        const mainApplication = config_plugins_1.AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
        for (const name of edit.remove) {
            config_plugins_1.AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(mainApplication, name);
        }
        for (const [name, value] of Object.entries(edit.set)) {
            config_plugins_1.AndroidConfig.Manifest.addMetaDataItemToMainApplication(mainApplication, name, value);
        }
        if (edit.warning) {
            console.warn(edit.warning);
        }
        config_plugins_1.AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(mainApplication, manifest_1.RN_HOLD_FILTERS_META_DATA);
        if (holdFilters !== null) {
            config_plugins_1.AndroidConfig.Manifest.addMetaDataItemToMainApplication(mainApplication, manifest_1.RN_HOLD_FILTERS_META_DATA, holdFilters);
        }
        if (!token) {
            return cfg;
        }
        config_plugins_1.AndroidConfig.Manifest.addMetaDataItemToMainApplication(mainApplication, 'com.bugsee.app-token', token);
        return cfg;
    });
    config = (0, config_plugins_1.withXcodeProject)(config, (cfg) => {
        (0, bundle_phase_1.rewriteProjectBundlePhase)(cfg.modResults, {
            uploadSourcemaps,
            // Only the upload reads it; the Archive action carries its own copy.
            iosAppToken: uploadSourcemaps ? iosToken : undefined,
            endpoint: uploadSourcemaps ? endpoint : undefined,
        });
        return cfg;
    });
    config = (0, config_plugins_1.withInfoPlist)(config, (cfg) => {
        if (endpoint) {
            cfg.modResults[exports.IOS_ENDPOINT_PLIST_KEY] = (0, endpoint_1.iosRuntimeEndpoint)(endpoint);
        }
        else {
            delete cfg.modResults[exports.IOS_ENDPOINT_PLIST_KEY];
        }
        return cfg;
    });
    config = (0, config_plugins_1.withDangerousMod)(config, [
        'ios',
        async (cfg) => {
            const script = (0, dsym_script_1.dsymPostActionScript)(iosToken, endpoint);
            for (const schemePath of listSchemes(cfg.modRequest.platformProjectRoot)) {
                const xml = await (0, promises_1.readFile)(schemePath, 'utf8');
                const next = uploadSymbols ? (0, scheme_1.insertDsymPostAction)(xml, script) : (0, scheme_1.removeDsymPostAction)(xml);
                if (next !== xml) {
                    await (0, promises_1.writeFile)(schemePath, next);
                }
            }
            // The React dSYMs the post-action uploads exist only when pod install
            // downloads them; see podfile.ts.
            const podfilePath = (0, node_path_1.join)(cfg.modRequest.platformProjectRoot, 'Podfile');
            let podfile;
            try {
                podfile = await (0, promises_1.readFile)(podfilePath, 'utf8');
            }
            catch {
                podfile = undefined;
            }
            if (podfile !== undefined) {
                await (0, promises_1.writeFile)(podfilePath, symbolicateReactNative ? (0, podfile_1.insertSymbolicatePrebuilt)(podfile) : (0, podfile_1.removeSymbolicatePrebuilt)(podfile));
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
exports.default = (0, config_plugins_1.createRunOncePlugin)(withBugsee, '@bugsee/react-native', '7.0.0-beta3');
//# sourceMappingURL=index.js.map