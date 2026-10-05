import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withProjectBuildGradle,
  withSettingsGradle,
  withXcodeProject,
} from '@expo/config-plugins';
import type { ConfigPlugin } from '@expo/config-plugins';

import type { XcodeProjectLike } from './bundle-phase';
import { rewriteProjectBundlePhase } from './bundle-phase';
import { dsymPostActionScript } from './dsym-script';
import {
  applyUploadSourcemapsProperty,
  ensureAppAppliesPlugin,
  ensureGradlePluginDeclared,
  ensureMavenCentral,
  ensureSymbolUploads,
} from './gradle';
import { manifestAutoLaunchToken } from './manifest';
import { loadNativeVersions } from './native-versions';
import { bugseePropertiesText } from './properties';
import { insertDsymPostAction, removeDsymPostAction } from './scheme';

export type AppTokenOption = string | { ios?: string; android?: string };

export interface BugseePluginProps {
  /**
   * Bugsee app tokens are per platform. A string is used for both; an
   * object sets each one. Android: the unprefixed `app_token` in
   * android/bugsee.properties. iOS: written into the Archive dSYM
   * post-action and the bundle phase (BUGSEE_PLUGIN_APP_TOKEN), so an
   * Archive from the Xcode GUI works without a shell environment;
   * BUGSEE_APP_TOKEN, BUGSEE_TOKEN_IOS and credentials.json still apply
   * when it is not set. A committed `ios/` (project.pbxproj and the shared
   * scheme) or `android/bugsee.properties` carries the token.
   */
  appToken?: AppTokenOption;
  /**
   * Defaults on. After the debug id is injected, both platforms upload the
   * composed source map with bugsee-cli when a real app token is
   * configured; a placeholder or missing token skips with one build-log
   * line, and a failed upload warns without failing the build. `false`
   * writes `bugseeUploadSourcemaps=false` into android/gradle.properties and
   * `BUGSEE_UPLOAD_SOURCEMAPS=false` into the iOS bundle phase.
   */
  uploadSourcemaps?: boolean;
  /**
   * Defaults on. `false` keeps native symbols offline on both platforms:
   * iOS loses the Archive dSYM post-action (including one an earlier
   * prebuild left), and Android disables the Bugsee Gradle plugin's
   * `uploadBugsee*` tasks (R8 mapping, NDK symbols, build info) in a marked
   * block a later prebuild removes again. Source maps follow
   * `uploadSourcemaps`.
   */
  uploadSymbols?: boolean;
  /**
   * Defaults on. Writes `plugin.ndk.enabled=true` for a real token, adds
   * `com.bugsee:bugsee-android-ndk`, and sets `debugSymbolLevel 'SYMBOL_TABLE'`
   * on existing debug and release build types. `false` skips the flag, strips
   * that direct dependency, excludes the wrapper's NDK AAR, and removes the
   * symbol block this plugin inserted. JS source-map hooks stay either way.
   */
  nativeCrashReporting?: boolean;
  /** Defaults to native-versions.json `android.gradlePlugin`. */
  gradlePluginVersion?: string;
  /** Defaults off. Writes `com.bugsee.app-token` manifest meta-data. */
  autoLaunch?: boolean;
}

export const APP_GRADLE_NOT_GROOVY =
  '@bugsee/react-native edits android/app/build.gradle in Groovy; a Kotlin build.gradle.kts app module is not ' +
  'supported. Apply scripts/bugsee-sourcemaps.gradle and set react.hermesCommand by hand (see the package README, ' +
  '"Android source maps").';

const TOKEN_SHAPE = /^[0-9A-Za-z._-]+$/;

/** The token for one platform, or undefined. Refuses anything that is not token-shaped. */
export function platformToken(
  appToken: AppTokenOption | undefined,
  platform: 'ios' | 'android',
): string | undefined {
  const token = typeof appToken === 'string' ? appToken : appToken?.[platform];
  if (token === undefined || token === '') {
    return undefined;
  }
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
    throw new Error(`@bugsee/react-native: the ${platform} appToken is not a Bugsee app token`);
  }
  return token;
}

const withBugsee: ConfigPlugin<BugseePluginProps> = (config, props) => {
  const options: BugseePluginProps = props ?? {};
  const androidToken = platformToken(options.appToken, 'android');
  const iosToken = platformToken(options.appToken, 'ios');
  const uploadSourcemaps = options.uploadSourcemaps !== false;
  const uploadSymbols = options.uploadSymbols !== false;
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
    if (cfg.modResults.language !== 'groovy') {
      throw new Error(APP_GRADLE_NOT_GROOVY);
    }
    cfg.modResults.contents = ensureSymbolUploads(
      ensureAppAppliesPlugin(cfg.modResults.contents, ndkVersion),
      uploadSymbols,
    );
    return cfg;
  });

  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = applyUploadSourcemapsProperty(cfg.modResults, uploadSourcemaps);
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      await writeFile(
        join(cfg.modRequest.platformProjectRoot, 'bugsee.properties'),
        bugseePropertiesText({
          appToken: androidToken,
          nativeCrashReporting: options.nativeCrashReporting,
        }),
      );
      return cfg;
    },
  ]);

  config = withAndroidManifest(config, (cfg) => {
    const token = manifestAutoLaunchToken({ appToken: androidToken, autoLaunch: options.autoLaunch });
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
    rewriteProjectBundlePhase(cfg.modResults as unknown as XcodeProjectLike, {
      uploadSourcemaps,
      // Only the upload reads it; the Archive action carries its own copy.
      iosAppToken: uploadSourcemaps ? iosToken : undefined,
    });
    return cfg;
  });

  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const script = dsymPostActionScript(iosToken);
      for (const schemePath of listSchemes(cfg.modRequest.platformProjectRoot)) {
        const xml = await readFile(schemePath, 'utf8');
        const next = uploadSymbols ? insertDsymPostAction(xml, script) : removeDsymPostAction(xml);
        if (next !== xml) {
          await writeFile(schemePath, next);
        }
      }
      return cfg;
    },
  ]);

  return config;
};

/** Shared schemes of every .xcodeproj under ios/. Throws when there are none. */
export function listSchemes(iosRoot: string): string[] {
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
