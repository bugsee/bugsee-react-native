import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withProjectBuildGradle,
  withSettingsGradle,
  withXcodeProject,
} from '@expo/config-plugins';
import type { ConfigPlugin } from '@expo/config-plugins';

import type { XcodeProjectLike } from './bundle-phase';
import { rewriteProjectBundlePhase } from './bundle-phase';
import { ensureAppAppliesPlugin, ensureGradlePluginDeclared, ensureMavenCentral } from './gradle';
import { manifestAutoLaunchToken } from './manifest';
import { loadNativeVersions } from './native-versions';
import { bugseePropertiesText } from './properties';
import { insertDsymPostAction } from './scheme';

export interface BugseePluginProps {
  /** Unprefixed `app_token` in android/bugsee.properties. */
  appToken?: string;
  /**
   * Accepted for the spec's option list. The settled Xcode hook injects
   * debug ids on the composed map and does not execute the upload.
   */
  uploadSourcemaps?: boolean;
  /** Defaults on. `false` skips the Archive dSYM post-action. */
  uploadSymbols?: boolean;
  /**
   * Defaults on. Writes `plugin.ndk.enabled=true` for a real token and adds
   * `com.bugsee:bugsee-android-ndk`. `false` opts out of both.
   */
  nativeCrashReporting?: boolean;
  /** Defaults to native-versions.json `android.gradlePlugin`. */
  gradlePluginVersion?: string;
  /** Defaults off. Writes `com.bugsee.app-token` manifest meta-data. */
  autoLaunch?: boolean;
}

const withBugsee: ConfigPlugin<BugseePluginProps> = (config, props) => {
  const options: BugseePluginProps = props ?? {};
  const versions = loadNativeVersions(__dirname);
  const gradlePluginVersion = options.gradlePluginVersion ?? versions.gradlePlugin;
  const ndkVersion = options.nativeCrashReporting === false ? null : versions.sdk;

  config = withSettingsGradle(config, (cfg) => {
    cfg.modResults.contents = ensureMavenCentral(cfg.modResults.contents);
    return cfg;
  });

  config = withProjectBuildGradle(config, (cfg) => {
    cfg.modResults.contents = ensureGradlePluginDeclared(
      cfg.modResults.contents,
      gradlePluginVersion,
    );
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = ensureAppAppliesPlugin(cfg.modResults.contents, ndkVersion);
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      await writeFile(
        join(cfg.modRequest.platformProjectRoot, 'bugsee.properties'),
        bugseePropertiesText(options),
      );
      return cfg;
    },
  ]);

  config = withAndroidManifest(config, (cfg) => {
    const token = manifestAutoLaunchToken(options);
    if (!token) {
      return cfg;
    }
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      mainApplication,
      'com.bugsee.app-token',
      token,
    );
    return cfg;
  });

  config = withXcodeProject(config, (cfg) => {
    rewriteProjectBundlePhase(cfg.modResults as unknown as XcodeProjectLike);
    return cfg;
  });

  if (options.uploadSymbols !== false) {
    config = withDangerousMod(config, [
      'ios',
      async (cfg) => {
        for (const schemePath of listSchemes(cfg.modRequest.platformProjectRoot)) {
          const xml = await readFile(schemePath, 'utf8');
          const next = insertDsymPostAction(xml);
          if (next !== xml) {
            await writeFile(schemePath, next);
          }
        }
        return cfg;
      },
    ]);
  }

  return config;
};

function listSchemes(iosRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(iosRoot);
  } catch (error) {
    throw new Error(`ios project not found at ${iosRoot}`, { cause: error });
  }
  const schemes: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.xcodeproj')) {
      continue;
    }
    const dir = join(iosRoot, entry, 'xcshareddata', 'xcschemes');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.xcscheme')) {
        schemes.push(join(dir, name));
      }
    }
  }
  if (schemes.length === 0) {
    throw new Error(`no shared xcscheme under ${iosRoot}`);
  }
  return schemes;
}

export default createRunOncePlugin(withBugsee, '@bugsee/react-native', '0.0.0');
