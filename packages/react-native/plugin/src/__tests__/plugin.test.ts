import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPlaceholderToken as exampleIsPlaceholderToken } from '../../../../../examples/bare/endpoint';
import { rewriteBundlePhase, BARE_BUNDLE_SCRIPT } from '../bundle-phase';
import { decodePbxString, encodePbxString } from '../pbx-string';
import { bugseePropertiesText, isPlaceholderToken } from '../properties';
import { ensureAppAppliesPlugin, ensureGradlePluginDeclared, ensureMavenCentral } from '../gradle';
import { insertDsymPostAction } from '../scheme';
import { DSYM_POST_ACTION_SCRIPT } from '../dsym-script';
import { manifestAutoLaunchToken } from '../manifest';
import { loadNativeVersions } from '../native-versions';

const repoRoot = join(__dirname, '..', '..', '..', '..', '..');
const barePbx = join(
  repoRoot,
  'examples/bare/ios/BareExample.xcodeproj/project.pbxproj',
);

function decodeXml(value: string): string {
  return value
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function bareBundleScript(): string {
  const pbx = readFileSync(barePbx, 'utf8');
  const line = pbx.split('\n').find((entry) => entry.includes('shellScript') && entry.includes('bugsee-xcode.sh'));
  if (!line) {
    throw new Error('bare bundle phase missing');
  }
  const quoted = line.trim().replace(/^shellScript = /, '').replace(/;$/, '');
  return decodePbxString(quoted);
}

const REAL_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

describe('bugsee.properties', () => {
  it('writes app_token and enables NDK upload for a real token', () => {
    const text = bugseePropertiesText({ appToken: REAL_TOKEN });
    expect(text).toContain(`app_token=${REAL_TOKEN}`);
    expect(text).toContain('plugin.ndk.enabled=true');
    expect(text).not.toContain('plugin.appToken');
  });

  it('does not enable NDK upload for the placeholder UUID', () => {
    const text = bugseePropertiesText({ appToken: PLACEHOLDER });
    expect(text).not.toContain('plugin.ndk.enabled');
    expect(text).not.toContain('plugin.appToken');
    expect(isPlaceholderToken(PLACEHOLDER)).toBe(true);
  });

  it('omits the NDK upload flag when native crash reporting is off', () => {
    const text = bugseePropertiesText({ appToken: REAL_TOKEN, nativeCrashReporting: false });
    expect(text).toContain(`app_token=${REAL_TOKEN}`);
    expect(text).not.toContain('plugin.ndk.enabled');
  });

  it('omits both lines when the token is empty', () => {
    const text = bugseePropertiesText({ appToken: '' });
    expect(text).not.toContain('app_token=');
    expect(text).not.toContain('plugin.ndk.enabled');
    expect(text).not.toContain('plugin.endpoint');
    expect(text).not.toContain('plugin.appToken');
  });

  it('uses the same placeholder rule as the bare example', () => {
    const samples = [
      PLACEHOLDER,
      '00000000-0000-0000-0000-000000000000',
      '00000000000040008000000000000000',
      REAL_TOKEN,
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000000',
      '',
    ];
    for (const sample of samples) {
      expect(isPlaceholderToken(sample)).toBe(exampleIsPlaceholderToken(sample));
    }
  });
});

describe('settled iOS hooks', () => {
  it('copies the bare bundle phase script', () => {
    expect(BARE_BUNDLE_SCRIPT).toBe(bareBundleScript());
    expect(BARE_BUNDLE_SCRIPT).toContain('bugsee-xcode.sh');
    expect(BARE_BUNDLE_SCRIPT).not.toContain('react-native-xcode.sh');
  });

  it('keeps the Archive post-action upload guards', () => {
    expect(DSYM_POST_ACTION_SCRIPT).toContain('xcode post-action');
    expect(DSYM_POST_ACTION_SCRIPT).not.toContain('xcode upload-dsyms');
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(/\.bin\/bugsee-cli/);
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(/with-environment\.sh/);
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(/\/v2/);
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(/https?:\/\//);
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(/--force-foreground/);
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(/BUGSEE_BUILD_INFO_ALL_ACTIONS/);
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(/BUGSEE_BUILD_INFO_ALL_CONFIGURATIONS/);
    expect(DSYM_POST_ACTION_SCRIPT).toContain('if [ -n "$TOKEN" ]; then');
    expect(DSYM_POST_ACTION_SCRIPT).toContain('export BUGSEE_APP_TOKEN="$TOKEN"');
    expect(DSYM_POST_ACTION_SCRIPT).toContain('if [ -n "$ENDPOINT" ]; then');
    expect(DSYM_POST_ACTION_SCRIPT).toContain('export BUGSEE_ENDPOINT="$ENDPOINT"');
  });

  it('resolves bugsee-cli from the package graph', () => {
    expect(DSYM_POST_ACTION_SCRIPT).toContain("require.resolve('@bugsee/cli");
    expect(DSYM_POST_ACTION_SCRIPT).not.toContain('packages/react-native/node_modules');
    const resolveAt = DSYM_POST_ACTION_SCRIPT.indexOf("require.resolve('@bugsee/cli");
    const exitAt = DSYM_POST_ACTION_SCRIPT.lastIndexOf('exit 1');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(resolveAt);
  });

  it('replaces a classic bundle phase with the bare hook', () => {
    const classic = [
      'set -e',
      '',
      'WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"',
      'REACT_NATIVE_XCODE="$REACT_NATIVE_PATH/scripts/react-native-xcode.sh"',
      '/bin/sh -c "$WITH_ENVIRONMENT $REACT_NATIVE_XCODE"',
      '',
    ].join('\n');
    expect(rewriteBundlePhase(classic)).toBe(BARE_BUNDLE_SCRIPT);
  });

  it('points the Expo bundle phase at bugsee-xcode.sh without a second script', () => {
    const expo = [
      'export PROJECT_ROOT="$PROJECT_DIR"/..',
      'export CLI_PATH="$("$NODE_BINARY" --print "require.resolve(\'@expo/cli\', { paths: [require.resolve(\'expo/package.json\')] })")"',
      'export BUNDLE_COMMAND="export:embed"',
      'export ENTRY_FILE="$("$NODE_BINARY" -e "require(\'expo/scripts/resolveAppEntry\')" "$PROJECT_ROOT" ios absolute | tail -n 1)"',
      '`"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"`',
      '',
    ].join('\n');
    const rewritten = rewriteBundlePhase(expo);
    expect(rewritten).toContain('bugsee-xcode.sh');
    expect(rewritten).toContain('export:embed');
    expect(rewritten).toContain('resolveAppEntry');
    expect(rewritten).toContain('CLI_PATH');
    expect(rewritten).toContain('ENTRY_FILE');
    expect(rewritten).not.toContain('react-native-xcode.sh');
    expect(rewritten).toContain('REACT_NATIVE_PATH');
    expect(rewritten).toContain(
      'BUGSEE_XCODE="$("$NODE_BINARY" --print "require(\'path\').join(require(\'path\').dirname(require.resolve(\'@bugsee/react-native/package.json\')), \'scripts/bugsee-xcode.sh\')")"',
    );
    expect(rewritten).toContain('/bin/bash "$BUGSEE_XCODE"');
    expect(rewritten).not.toContain('${SRCROOT}/../node_modules');
    expect(rewritten.match(/\/bin\/bash/g)).toHaveLength(1);
  });

  it('round-trips a pbxproj shell script', () => {
    expect(decodePbxString(encodePbxString(BARE_BUNDLE_SCRIPT))).toBe(BARE_BUNDLE_SCRIPT);
  });
});

describe('Android Gradle edits', () => {
  const versions = loadNativeVersions(join(__dirname, '..', '..', 'build'));

  const settings = [
    'pluginManagement {',
    '  includeBuild(reactNativeGradlePlugin)',
    '}',
    '',
    'plugins { id("com.facebook.react.settings") }',
    '',
  ].join('\n');

  it('adds mavenCentral inside pluginManagement', () => {
    const next = ensureMavenCentral(settings);
    const block = next.slice(next.indexOf('pluginManagement'), next.indexOf('plugins {'));
    expect(block).toContain('mavenCentral()');
    expect(block).toContain('gradlePluginPortal()');
    expect(ensureMavenCentral(next)).toBe(next);
  });

  it('declares the Gradle plugin version from native-versions.json', () => {
    const project = [
      'buildscript { repositories { google(); mavenCentral() } }',
      'apply plugin: "com.facebook.react.rootproject"',
      '',
    ].join('\n');
    const next = ensureGradlePluginDeclared(project, versions.gradlePlugin);
    expect(next).toContain(
      `id 'com.bugsee.android.gradle' version '${versions.gradlePlugin}' apply false`,
    );
    expect(next).not.toContain("id 'com.bugsee.android.gradle' version '9.9.9'");
    const overridden = ensureGradlePluginDeclared(project, '9.9.9');
    expect(overridden).toContain("version '9.9.9'");
    expect(overridden).not.toContain(`version '${versions.gradlePlugin}'`);
  });

  it('applies the plugin on the app module and adds the NDK artifact', () => {
    const app = [
      'apply plugin: "com.android.application"',
      'apply plugin: "com.facebook.react"',
      '',
      'dependencies {',
      '    implementation("com.facebook.react:react-android")',
      '}',
      '',
    ].join('\n');
    const next = ensureAppAppliesPlugin(app, versions.sdk);
    expect(next).toContain('apply plugin: "com.bugsee.android.gradle"');
    expect(next).toContain(`implementation "com.bugsee:bugsee-android-ndk:${versions.sdk}"`);
    expect(next).not.toContain("exclude group: 'com.bugsee', module: 'bugsee-android-ndk'");
    expect(ensureAppAppliesPlugin(next, versions.sdk)).toBe(next);
  });

  it('excludes the NDK artifact when native crash reporting is off', () => {
    const app = 'apply plugin: "com.facebook.react"\n\ndependencies {\n}\n';
    const next = ensureAppAppliesPlugin(app, null);
    expect(next).toContain('apply plugin: "com.bugsee.android.gradle"');
    expect(next).toContain("exclude group: 'com.bugsee', module: 'bugsee-android-ndk'");
    expect(next).not.toMatch(/implementation\s+["']com\.bugsee:bugsee-android-ndk:/);
    expect(ensureAppAppliesPlugin(next, null)).toBe(next);
  });

  it('removes a previous NDK exclude when native crash reporting is on', () => {
    const app = [
      'apply plugin: "com.facebook.react"',
      'apply plugin: "com.bugsee.android.gradle"',
      '',
      'dependencies {',
      '}',
      '',
      'configurations.configureEach {',
      "    exclude group: 'com.bugsee', module: 'bugsee-android-ndk'",
      '}',
      '',
    ].join('\n');
    const next = ensureAppAppliesPlugin(app, versions.sdk);
    expect(next).not.toContain('configurations.configureEach');
    expect(next).not.toContain("exclude group: 'com.bugsee', module: 'bugsee-android-ndk'");
    expect(next).toContain(`implementation "com.bugsee:bugsee-android-ndk:${versions.sdk}"`);
    expect(ensureAppAppliesPlugin(next, versions.sdk)).toBe(next);
  });
});

describe('published native versions', () => {
  it('loads baked versions from a tree that has only the published plugin files', () => {
    const source = JSON.parse(readFileSync(join(repoRoot, 'native-versions.json'), 'utf8')) as {
      android: { sdk: string; gradlePlugin: string };
    };
    const temp = mkdtempSync(join(tmpdir(), 'bugsee-published-'));
    try {
      const build = join(temp, 'plugin', 'build');
      cpSync(join(__dirname, '..', '..', 'build'), build, { recursive: true });
      expect(existsSync(join(temp, 'native-versions.json'))).toBe(false);
      expect(existsSync(join(temp, 'plugin', 'native-versions.json'))).toBe(false);
      const loaded = createRequire(join(build, 'native-versions.js'))(
        join(build, 'native-versions.js'),
      ) as { loadNativeVersions: () => { sdk: string; gradlePlugin: string } };
      expect(loaded.loadNativeVersions()).toEqual({
        sdk: source.android.sdk,
        gradlePlugin: source.android.gradlePlugin,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('scheme post-action', () => {
  const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version = "1.3">
   <BuildAction>
      <BuildActionEntries>
         <BuildActionEntry>
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "13B07F861A680F5B00A75B9A"
               BuildableName = "BugseeExpo.app"
               BlueprintName = "BugseeExpo"
               ReferencedContainer = "container:BugseeExpo.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;

  it('inserts the copied script on Archive and keeps the app target', () => {
    const next = insertDsymPostAction(scheme, DSYM_POST_ACTION_SCRIPT);
    expect(next).toContain('<PostActions>');
    expect(next).toContain('title = "Upload dSYMs"');
    const encoded = next.match(/\bscriptText\s*=\s*"([^"]*)"/)?.[1];
    expect(encoded).toEqual(expect.any(String));
    expect(decodeXml(encoded ?? '')).toBe(DSYM_POST_ACTION_SCRIPT);
    expect(next).toContain('BlueprintName = "BugseeExpo"');
    expect(next).not.toContain('BareExample');
    expect(insertDsymPostAction(next, DSYM_POST_ACTION_SCRIPT)).toBe(next);
  });
});

describe('manifest auto-launch', () => {
  it('writes the meta-data value only when autoLaunch is set and the token is real', () => {
    expect(manifestAutoLaunchToken({ appToken: REAL_TOKEN, autoLaunch: true })).toBe(REAL_TOKEN);
    expect(manifestAutoLaunchToken({ appToken: REAL_TOKEN })).toBeNull();
    expect(manifestAutoLaunchToken({ appToken: PLACEHOLDER, autoLaunch: true })).toBeNull();
    expect(manifestAutoLaunchToken({ appToken: '', autoLaunch: true })).toBeNull();
  });
});
