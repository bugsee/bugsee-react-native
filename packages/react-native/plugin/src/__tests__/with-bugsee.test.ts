import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { compileModsAsync } from '@expo/config-plugins';
import type { ExpoConfig } from '@expo/config-types';

import withBugsee, { APP_GRADLE_NOT_GROOVY, gradleNotGroovy, platformToken } from '../index';
import { ENDPOINT_HAS_VERSION, ENDPOINT_NOT_VALID } from '../endpoint';
import { SDK_ENDPOINT_KEPT } from '../manifest';
import type { BugseePluginProps } from '../index';
import { CANNOT_EDIT } from '../gradle';
import type * as NativeVersions from '../native-versions';
import type * as NodePath from 'node:path';

type NativeVersionsModule = typeof NativeVersions;
type PathModule = typeof NodePath;

// The tests import src, which has no baked versions beside it; build/ does.
jest.mock('../native-versions', () => {
  const actual = jest.requireActual<NativeVersionsModule>('../native-versions');
  const { join: joinPath } = jest.requireActual<PathModule>('node:path');
  return {
    ...actual,
    loadNativeVersions: () => actual.loadNativeVersions(joinPath(__dirname, '..', '..', 'build')),
  };
});

const repoRoot = join(__dirname, '..', '..', '..', '..', '..');
const template = join(repoRoot, 'examples/expo/node_modules/expo/template.tgz');
const baked = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'build', 'native-versions.baked.json'), 'utf8'),
) as { sdk: string; gradlePlugin: string };

// Synthetic, UUID-shaped, never real apps.
const ANDROID_TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0001';
const IOS_TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0002';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

const FILES = {
  properties: 'android/bugsee.properties',
  app: 'android/app/build.gradle',
  root: 'android/build.gradle',
  settings: 'android/settings.gradle',
  gradleProperties: 'android/gradle.properties',
  manifest: 'android/app/src/main/AndroidManifest.xml',
  pbxproj: 'ios/HelloWorld.xcodeproj/project.pbxproj',
  scheme: 'ios/HelloWorld.xcodeproj/xcshareddata/xcschemes/HelloWorld.xcscheme',
  infoPlist: 'ios/HelloWorld/Info.plist',
};

// The dead loopback endpoint the e2e uses, and one more synthetic host.
const ENDPOINT = 'https://127.0.0.1:9';
const OTHER_ENDPOINT = 'https://bugsee.example.com:8443/api';

function baseConfig(): ExpoConfig {
  return {
    name: 'HelloWorld',
    slug: 'hello-world',
    ios: { bundleIdentifier: 'com.bugsee.pluginfixture' },
    android: { package: 'com.bugsee.pluginfixture' },
  };
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out[relative(root, full)] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(join(root, 'android'));
  walk(join(root, 'ios'));
  return out;
}

describe('withBugsee through the Expo mod compiler', () => {
  let work: string;
  let projectRoot: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'bugsee-with-plugin-'));
    const untar = spawnSync('tar', ['-xzf', template, '-C', work], { encoding: 'utf8' });
    if (untar.status !== 0) {
      throw new Error(untar.stderr || `could not unpack ${template}`);
    }
    projectRoot = join(work, 'package');
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  async function prebuild(
    props: BugseePluginProps | undefined,
    platforms: ('ios' | 'android')[] = ['ios', 'android'],
  ): Promise<void> {
    const config = withBugsee(baseConfig(), props as BugseePluginProps);
    await compileModsAsync(config, { projectRoot, platforms });
  }

  function read(name: keyof typeof FILES): string {
    return readFileSync(join(projectRoot, FILES[name]), 'utf8');
  }

  it('wires both platforms for a string token', async () => {
    await prebuild({ appToken: ANDROID_TOKEN });

    expect(read('properties')).toBe(`app_token=${ANDROID_TOKEN}\nplugin.ndk.enabled=true\n`);
    expect(read('settings')).toMatch(/pluginManagement \{[\s\S]*mavenCentral\(\)/);
    expect(read('root')).toContain(
      `id 'com.bugsee.android.gradle' version '${baked.gradlePlugin}' apply false`,
    );
    const app = read('app');
    expect(app).toContain('apply plugin: "com.bugsee.android.gradle"');
    expect(app).toContain(`implementation "com.bugsee:bugsee-android-ndk:${baked.sdk}"`);
    expect(app).toContain('"scripts/bugsee-sourcemaps.gradle")');
    expect(app).toContain('"/scripts/hermesc-preserve-js" + (System.getProperty("os.name").startsWith("Windows") ? ".cmd" : ".sh")');
    expect(app).not.toContain('bugsee-upload-symbols-off:');
    expect(read('gradleProperties')).not.toContain('bugseeUploadSourcemaps');
    expect(read('manifest')).not.toContain('com.bugsee.app-token');

    const pbxproj = read('pbxproj');
    expect(pbxproj).toContain('bugsee-xcode.sh');
    // A string token is both platforms' token.
    expect(pbxproj).toContain(`export BUGSEE_PLUGIN_APP_TOKEN='${ANDROID_TOKEN}'`);
    expect(pbxproj).not.toContain('BUGSEE_UPLOAD_SOURCEMAPS');
    const scheme = read('scheme');
    expect(scheme).toContain('title = "Upload dSYMs"');
    expect(scheme).toContain(`TOKEN='${ANDROID_TOKEN}'`);
  });

  it('keeps each platform to its own token', async () => {
    await prebuild({ appToken: { ios: IOS_TOKEN, android: ANDROID_TOKEN }, autoLaunch: true });
    expect(read('properties')).toContain(`app_token=${ANDROID_TOKEN}\n`);
    expect(read('manifest')).toContain(ANDROID_TOKEN);
    for (const file of ['properties', 'app', 'manifest', 'gradleProperties'] as const) {
      expect(read(file)).not.toContain(IOS_TOKEN);
    }
    expect(read('pbxproj')).toContain(`export BUGSEE_PLUGIN_APP_TOKEN='${IOS_TOKEN}'`);
    expect(read('scheme')).toContain(`TOKEN='${IOS_TOKEN}'`);
    expect(read('pbxproj')).not.toContain(ANDROID_TOKEN);
    expect(read('scheme')).not.toContain(ANDROID_TOKEN);
  });

  it('bakes no iOS token when only Android has one', async () => {
    await prebuild({ appToken: { android: ANDROID_TOKEN } });
    expect(read('pbxproj')).not.toContain('BUGSEE_PLUGIN_APP_TOKEN');
    expect(read('pbxproj')).not.toContain('bugsee settings');
    expect(read('scheme')).toContain('TOKEN=&quot;$BUGSEE_APP_TOKEN&quot;');
    expect(read('scheme')).not.toContain("TOKEN='");
    expect(read('properties')).toContain(`app_token=${ANDROID_TOKEN}`);
  });

  it('keeps the iOS token out of the bundle phase when source maps do not upload', async () => {
    await prebuild({ appToken: { ios: IOS_TOKEN }, uploadSourcemaps: false });
    expect(read('pbxproj')).not.toContain(IOS_TOKEN);
    expect(read('pbxproj')).toContain('export BUGSEE_UPLOAD_SOURCEMAPS=false');
    // The Archive post-action still carries it.
    expect(read('scheme')).toContain(`TOKEN='${IOS_TOKEN}'`);
  });

  it('removes the iOS token again when it is unset', async () => {
    await prebuild({});
    const without = snapshot(projectRoot);
    await prebuild({ appToken: { ios: IOS_TOKEN } });
    expect(read('pbxproj')).toContain(IOS_TOKEN);
    expect(read('scheme')).toContain(IOS_TOKEN);
    await prebuild({});
    expect(snapshot(projectRoot)).toEqual(without);
  });

  it('writes no token anywhere without one', async () => {
    await prebuild(undefined);
    expect(read('properties')).toBe('# Generated by @bugsee/react-native. No app token configured.\n');
    expect(read('pbxproj')).not.toContain('BUGSEE_PLUGIN_APP_TOKEN');
    expect(read('scheme')).toContain('title = "Upload dSYMs"');
  });

  it('turns the source-map upload off on both platforms and back on byte for byte', async () => {
    await prebuild({ appToken: ANDROID_TOKEN });
    const first = snapshot(projectRoot);

    await prebuild({ appToken: ANDROID_TOKEN, uploadSourcemaps: false });
    expect(read('gradleProperties')).toMatch(/^bugseeUploadSourcemaps=false$/m);
    expect(read('pbxproj')).toContain('export BUGSEE_UPLOAD_SOURCEMAPS=false');
    expect(read('pbxproj').match(/bugsee settings, written/g)).toHaveLength(1);
    expect(read('app')).toContain('scripts/bugsee-sourcemaps.gradle');

    await prebuild({ appToken: ANDROID_TOKEN, uploadSourcemaps: true });
    expect(snapshot(projectRoot)).toEqual(first);
  });

  it('keeps native symbols offline on both platforms with uploadSymbols false, reversibly', async () => {
    await prebuild({ appToken: ANDROID_TOKEN });
    const first = snapshot(projectRoot);

    await prebuild({ appToken: ANDROID_TOKEN, uploadSymbols: false });
    const app = read('app');
    expect(app).toContain(
      "tasks.matching { it.name.startsWith('uploadBugsee') }.configureEach { enabled = false }",
    );
    expect(app.match(/bugsee-upload-symbols-off:/g)).toHaveLength(1);
    expect(read('scheme')).not.toContain('xcode post-action');
    expect(readFileSync(join(projectRoot, 'ios/Podfile'), 'utf8')).not.toContain('RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS');
    // The source-map upload is its own option.
    expect(read('gradleProperties')).not.toContain('bugseeUploadSourcemaps');

    await prebuild({ appToken: ANDROID_TOKEN, uploadSymbols: false });
    expect(read('app').match(/bugsee-upload-symbols-off:/g)).toHaveLength(1);

    await prebuild({ appToken: ANDROID_TOKEN });
    expect(snapshot(projectRoot)).toEqual(first);
  });

  it('leaves the Podfile alone by default and for any non-true value', async () => {
    const podfilePath = join(projectRoot, 'ios/Podfile');
    const original = readFileSync(podfilePath, 'utf8');
    await prebuild({ appToken: ANDROID_TOKEN });
    expect(readFileSync(podfilePath, 'utf8')).toBe(original);
    await prebuild({ appToken: ANDROID_TOKEN, symbolicateReactNativeFrameworks: false });
    expect(readFileSync(podfilePath, 'utf8')).toBe(original);
  });

  it('asks pod install for React dSYMs with symbolicateReactNativeFrameworks, once, and removes it byte for byte', async () => {
    const podfilePath = join(projectRoot, 'ios/Podfile');
    const original = readFileSync(podfilePath, 'utf8');
    await prebuild({ appToken: ANDROID_TOKEN, symbolicateReactNativeFrameworks: true });
    const first = readFileSync(podfilePath, 'utf8');
    expect(first.split('\n')[1]).toBe("ENV['RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS'] ||= '1'");
    expect(first.match(/RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS/g)).toHaveLength(1);
    expect(first.endsWith(original)).toBe(true);
    await prebuild({ appToken: ANDROID_TOKEN, symbolicateReactNativeFrameworks: true });
    expect(readFileSync(podfilePath, 'utf8')).toBe(first);
    await prebuild({ appToken: ANDROID_TOKEN });
    expect(readFileSync(podfilePath, 'utf8')).toBe(original);
  });

  it('keeps the Podfile line independent of uploadSymbols', async () => {
    const podfilePath = join(projectRoot, 'ios/Podfile');
    await prebuild({ appToken: ANDROID_TOKEN, uploadSymbols: false, symbolicateReactNativeFrameworks: true });
    expect(readFileSync(podfilePath, 'utf8')).toContain('RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS');
  });

  it('drops the NDK pieces with nativeCrashReporting false', async () => {
    await prebuild({ appToken: ANDROID_TOKEN, nativeCrashReporting: false });
    expect(read('properties')).toBe(`app_token=${ANDROID_TOKEN}\n`);
    expect(read('app')).toContain("exclude group: 'com.bugsee', module: 'bugsee-android-ndk'");
    expect(read('app')).not.toMatch(/implementation\s+["']com\.bugsee:bugsee-android-ndk:/);
  });

  it('writes the manifest token only for autoLaunch with a real token', async () => {
    await prebuild({ appToken: PLACEHOLDER, autoLaunch: true });
    expect(read('manifest')).not.toContain('com.bugsee.app-token');
    await prebuild({ appToken: ANDROID_TOKEN, autoLaunch: true });
    expect(read('manifest')).toContain('android:name="com.bugsee.app-token"');
    expect(read('manifest')).toContain(`android:value="${ANDROID_TOKEN}"`);
  });

  it('honours a gradlePluginVersion override and rewrites it on the next run', async () => {
    await prebuild({ gradlePluginVersion: '9.9.9' });
    expect(read('root')).toContain("id 'com.bugsee.android.gradle' version '9.9.9' apply false");
    await prebuild({});
    expect(read('root')).toContain(`version '${baked.gradlePlugin}' apply false`);
    expect(read('root')).not.toContain('9.9.9');
  });

  it('is idempotent', async () => {
    await prebuild({ appToken: { ios: IOS_TOKEN, android: ANDROID_TOKEN } });
    const first = snapshot(projectRoot);
    await prebuild({ appToken: { ios: IOS_TOKEN, android: ANDROID_TOKEN } });
    expect(snapshot(projectRoot)).toEqual(first);
  });

  it('refuses a token that is not token-shaped', () => {
    expect(() => withBugsee(baseConfig(), { appToken: "x'; rm -rf /" })).toThrow(
      '@bugsee/react-native: the android appToken is not a Bugsee app token',
    );
    expect(() => withBugsee(baseConfig(), { appToken: { ios: 'a b' } })).toThrow(
      '@bugsee/react-native: the ios appToken is not a Bugsee app token',
    );
  });

  it('refuses a Kotlin app module at prebuild', async () => {
    const app = join(projectRoot, 'android/app');
    renameSync(join(app, 'build.gradle'), join(app, 'build.gradle.kts'));
    await expect(prebuild({}, ['android'])).rejects.toThrow(APP_GRADLE_NOT_GROOVY);
    expect(APP_GRADLE_NOT_GROOVY).toContain('bugsee-sourcemaps.gradle');
    expect(APP_GRADLE_NOT_GROOVY.startsWith(`${CANNOT_EDIT} android/app/build.gradle:`)).toBe(true);
  });

  it('names editGradleFiles in the Kotlin refusals, and that option lets a Kotlin project prebuild', async () => {
    expect(APP_GRADLE_NOT_GROOVY).toContain('"editGradleFiles": false');
    expect(gradleNotGroovy('android/build.gradle')).toContain('"editGradleFiles": false');
    const android = join(projectRoot, 'android');
    for (const [dir, name] of [
      [android, 'settings.gradle'],
      [android, 'build.gradle'],
      [join(android, 'app'), 'build.gradle'],
    ] as const) {
      renameSync(join(dir, name), join(dir, `${name}.kts`));
    }
    await prebuild({ appToken: ANDROID_TOKEN, editGradleFiles: false }, ['android']);
    expect(readFileSync(join(android, 'bugsee.properties'), 'utf8')).toContain(`app_token=${ANDROID_TOKEN}`);
    for (const file of ['settings.gradle.kts', 'build.gradle.kts', 'app/build.gradle.kts']) {
      expect(readFileSync(join(android, file), 'utf8')).not.toContain('bugsee');
    }
  });

  it('refuses a Kotlin settings or root file at prebuild', async () => {
    const android = join(projectRoot, 'android');
    renameSync(join(android, 'settings.gradle'), join(android, 'settings.gradle.kts'));
    await expect(prebuild({}, ['android'])).rejects.toThrow(gradleNotGroovy('android/settings.gradle'));
    renameSync(join(android, 'settings.gradle.kts'), join(android, 'settings.gradle'));
    renameSync(join(android, 'build.gradle'), join(android, 'build.gradle.kts'));
    await expect(prebuild({}, ['android'])).rejects.toThrow(gradleNotGroovy('android/build.gradle'));
    expect(gradleNotGroovy('android/build.gradle').startsWith(`${CANNOT_EDIT} android/build.gradle:`)).toBe(true);
  });

  it.each([
    ['app', 'android/app/build.gradle'],
    ['settings', 'android/settings.gradle'],
    ['root', 'android/build.gradle'],
  ] as const)('refuses a %s Gradle file it cannot read before it writes anything', async (file, name) => {
    const before = snapshot(projectRoot);
    appendFileSync(join(projectRoot, FILES[file]), 'def open = "never closed\n');
    const broken = snapshot(projectRoot);
    expect(broken).not.toEqual(before);
    await expect(prebuild({ appToken: ANDROID_TOKEN }, ['android'])).rejects.toThrow(`${CANNOT_EDIT} ${name}: line `);
    // No settings, root, app, properties or manifest edit happened.
    expect(snapshot(projectRoot)).toEqual(broken);
    expect(readdirSync(join(projectRoot, 'android'))).not.toContain('bugsee.properties');
  });

  describe('the endpoint option (F6)', () => {
    const RN_META = 'android:name="com.bugsee.reactnative.endpoint"';
    const SDK_META = 'android:name="com.bugsee.option.$$ENDPOINT"';
    const MARKER_META = 'android:name="com.bugsee.reactnative.sdk-endpoint"';

    it('writes nothing for it when it is unset', async () => {
      await prebuild({ appToken: ANDROID_TOKEN });
      expect(read('infoPlist')).not.toContain('BugseeReactNativeEndpoint');
      expect(read('manifest')).not.toContain('com.bugsee.reactnative');
      expect(read('properties')).not.toContain('plugin.endpoint');
    });

    it('writes it for both platforms\' uploads and their runtime', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await prebuild({ appToken: { ios: IOS_TOKEN, android: ANDROID_TOKEN }, endpoint: `${ENDPOINT}/`, autoLaunch: true });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      expect(read('properties')).toBe(`app_token=${ANDROID_TOKEN}\nplugin.ndk.enabled=true\nplugin.endpoint=${ENDPOINT}\n`);
      expect(read('manifest')).toContain(`<meta-data ${RN_META} android:value="${ENDPOINT}"/>`);
      expect(read('manifest')).toContain(`<meta-data ${SDK_META} android:value="${ENDPOINT}"/>`);
      expect(read('pbxproj')).toContain(`export BUGSEE_ENDPOINT='${ENDPOINT}'`);
      expect(read('scheme')).toContain(`export BUGSEE_ENDPOINT='${ENDPOINT}'&#10;`);
      expect(read('infoPlist')).toMatch(
        new RegExp(`<key>BugseeReactNativeEndpoint</key>\\s*<string>${ENDPOINT.replace(/\./g, '\\.')}/v2</string>`),
      );
    });

    it('is written with the placeholder token too, which itself is not', async () => {
      await prebuild({ appToken: PLACEHOLDER, endpoint: ENDPOINT });
      expect(read('properties')).toBe(`plugin.endpoint=${ENDPOINT}\n`);
      expect(read('manifest')).toContain(`<meta-data ${RN_META} android:value="${ENDPOINT}"/>`);
      expect(read('infoPlist')).toContain(`<string>${ENDPOINT}/v2</string>`);
    });

    it('leaves the bundle phase alone when source maps do not upload, and still bakes the post-action', async () => {
      await prebuild({ endpoint: ENDPOINT, uploadSourcemaps: false });
      expect(read('pbxproj')).not.toContain('BUGSEE_ENDPOINT');
      expect(read('scheme')).toContain(`export BUGSEE_ENDPOINT='${ENDPOINT}'`);
    });

    it('is replaced by a new value and removed again, byte for byte', async () => {
      await prebuild({ appToken: ANDROID_TOKEN });
      const without = snapshot(projectRoot);
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: ENDPOINT });
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: ENDPOINT });
      const once = snapshot(projectRoot);
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: OTHER_ENDPOINT });
      for (const file of ['properties', 'manifest', 'pbxproj', 'scheme', 'infoPlist'] as const) {
        expect(read(file)).not.toContain(ENDPOINT);
      }
      expect(read('manifest').split(RN_META)).toHaveLength(2);
      expect(read('pbxproj').match(/export BUGSEE_ENDPOINT=/g)).toHaveLength(1);
      // One baked line; the credentials.json fallback's `export BUGSEE_ENDPOINT="$ENDPOINT"` is the other.
      expect(read('scheme').match(/export BUGSEE_ENDPOINT='/g)).toHaveLength(1);
      expect(read('infoPlist')).toContain(`<string>${OTHER_ENDPOINT}/v2</string>`);
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: ENDPOINT });
      expect(snapshot(projectRoot)).toEqual(once);
      await prebuild({ appToken: ANDROID_TOKEN });
      expect(snapshot(projectRoot)).toEqual(without);
    });

    it('is the auto-launched SDK\'s endpoint with autoLaunch, marked as this plugin\'s, and removed with it', async () => {
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: ENDPOINT });
      const noAuto = snapshot(projectRoot);
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: ENDPOINT, autoLaunch: true });
      const manifest = read('manifest');
      expect(manifest).toContain(`<meta-data ${SDK_META} android:value="${ENDPOINT}"/>`);
      expect(manifest).toContain(`<meta-data ${MARKER_META} android:value="${ENDPOINT}"/>`);
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: OTHER_ENDPOINT, autoLaunch: true });
      expect(read('manifest')).toContain(`<meta-data ${SDK_META} android:value="${OTHER_ENDPOINT}"/>`);
      expect(read('manifest').split(SDK_META)).toHaveLength(2);
      await prebuild({ appToken: ANDROID_TOKEN, endpoint: ENDPOINT });
      // The token meta-data autoLaunch wrote stays, as it always has; every endpoint item is back as before.
      const back = snapshot(projectRoot);
      expect(back[FILES.manifest]).not.toContain(SDK_META);
      expect(back[FILES.manifest]).not.toContain(MARKER_META);
      expect({ ...back, [FILES.manifest]: '' }).toEqual({ ...noAuto, [FILES.manifest]: '' });
    });

    it('never touches an SDK endpoint the app wrote itself', async () => {
      const path = join(projectRoot, FILES.manifest);
      const own = '<meta-data android:name="com.bugsee.option.$$ENDPOINT" android:value="https://own.example.com"/>';
      writeFileSync(path, readFileSync(path, 'utf8').replace(/(<application\b[^>]*>)/, (open: string) => `${open}\n    ${own}`));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await prebuild({ appToken: ANDROID_TOKEN, endpoint: ENDPOINT, autoLaunch: true }, ['android']);
        expect(warn).toHaveBeenCalledWith(SDK_ENDPOINT_KEPT);
      } finally {
        warn.mockRestore();
      }
      const manifest = read('manifest');
      expect(manifest).toContain(`<meta-data ${SDK_META} android:value="https://own.example.com"/>`);
      expect(manifest).not.toContain(MARKER_META);
      expect(manifest).toContain(`<meta-data ${RN_META} android:value="${ENDPOINT}"/>`);
      await prebuild({ appToken: ANDROID_TOKEN }, ['android']);
      expect(read('manifest')).toContain(`<meta-data ${SDK_META} android:value="https://own.example.com"/>`);
      expect(read('manifest')).not.toContain(RN_META);
    });

    it('is refused at config time when it is not a plain https base', () => {
      expect(() => withBugsee(baseConfig(), { endpoint: 'http://bugsee.example.com' })).toThrow(ENDPOINT_NOT_VALID);
      expect(() => withBugsee(baseConfig(), { endpoint: "https://x.example.com/'; rm -rf /" })).toThrow(ENDPOINT_NOT_VALID);
      expect(() => withBugsee(baseConfig(), { endpoint: 'https://bugsee.example.com/v2' })).toThrow(ENDPOINT_HAS_VERSION);
    });
  });

  it('fails loudly without an iOS project or a shared scheme', async () => {
    rmSync(join(projectRoot, 'ios/HelloWorld.xcodeproj/xcshareddata'), { recursive: true, force: true });
    await expect(prebuild({}, ['ios'])).rejects.toThrow(`no shared xcscheme under ${join(projectRoot, 'ios')}`);
  });
});

describe('platformToken', () => {
  it('reads a string for both platforms and an object per platform', () => {
    expect(platformToken('abc', 'ios')).toBe('abc');
    expect(platformToken('abc', 'android')).toBe('abc');
    expect(platformToken({ ios: 'i' }, 'ios')).toBe('i');
    expect(platformToken({ ios: 'i' }, 'android')).toBeUndefined();
    expect(platformToken({ android: 'a' }, 'android')).toBe('a');
    expect(platformToken(undefined, 'ios')).toBeUndefined();
    expect(platformToken('', 'ios')).toBeUndefined();
    expect(platformToken({ ios: '' }, 'ios')).toBeUndefined();
    expect(platformToken('A-z_0.9', 'ios')).toBe('A-z_0.9');
  });

  it('refuses non-string and shell-unsafe values', () => {
    expect(() => platformToken({ ios: 7 as unknown as string }, 'ios')).toThrow('not a Bugsee app token');
    for (const bad of ["a'b", 'a b', 'a$b', 'a\nb', 'a"b']) {
      expect(() => platformToken(bad, 'android')).toThrow('the android appToken is not a Bugsee app token');
    }
  });
});
