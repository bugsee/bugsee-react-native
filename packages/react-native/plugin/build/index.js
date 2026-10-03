"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const config_plugins_1 = require("@expo/config-plugins");
const bundle_phase_1 = require("./bundle-phase");
const gradle_1 = require("./gradle");
const manifest_1 = require("./manifest");
const native_versions_1 = require("./native-versions");
const properties_1 = require("./properties");
const scheme_1 = require("./scheme");
const withBugsee = (config, props) => {
    const options = props ?? {};
    const versions = (0, native_versions_1.loadNativeVersions)(__dirname);
    const gradlePluginVersion = options.gradlePluginVersion ?? versions.gradlePlugin;
    const ndkVersion = options.nativeCrashReporting === false ? null : versions.sdk;
    config = (0, config_plugins_1.withSettingsGradle)(config, (cfg) => {
        cfg.modResults.contents = (0, gradle_1.ensureMavenCentral)(cfg.modResults.contents);
        return cfg;
    });
    config = (0, config_plugins_1.withProjectBuildGradle)(config, (cfg) => {
        cfg.modResults.contents = (0, gradle_1.ensureGradlePluginDeclared)(cfg.modResults.contents, gradlePluginVersion);
        return cfg;
    });
    config = (0, config_plugins_1.withAppBuildGradle)(config, (cfg) => {
        cfg.modResults.contents = (0, gradle_1.ensureAppAppliesPlugin)(cfg.modResults.contents, ndkVersion);
        return cfg;
    });
    config = (0, config_plugins_1.withDangerousMod)(config, [
        'android',
        async (cfg) => {
            await (0, promises_1.writeFile)((0, node_path_1.join)(cfg.modRequest.platformProjectRoot, 'bugsee.properties'), (0, properties_1.bugseePropertiesText)(options));
            return cfg;
        },
    ]);
    config = (0, config_plugins_1.withAndroidManifest)(config, (cfg) => {
        const token = (0, manifest_1.manifestAutoLaunchToken)(options);
        if (!token) {
            return cfg;
        }
        const mainApplication = config_plugins_1.AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
        config_plugins_1.AndroidConfig.Manifest.addMetaDataItemToMainApplication(mainApplication, 'com.bugsee.app-token', token);
        return cfg;
    });
    config = (0, config_plugins_1.withXcodeProject)(config, (cfg) => {
        (0, bundle_phase_1.rewriteProjectBundlePhase)(cfg.modResults);
        return cfg;
    });
    config = (0, config_plugins_1.withDangerousMod)(config, [
        'ios',
        async (cfg) => {
            const edit = options.uploadSymbols === false ? scheme_1.removeDsymPostAction : scheme_1.insertDsymPostAction;
            for (const schemePath of listSchemes(cfg.modRequest.platformProjectRoot)) {
                const xml = await (0, promises_1.readFile)(schemePath, 'utf8');
                const next = edit(xml);
                if (next !== xml) {
                    await (0, promises_1.writeFile)(schemePath, next);
                }
            }
            return cfg;
        },
    ]);
    return config;
};
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