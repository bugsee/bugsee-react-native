import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isPlaceholderToken as exampleIsPlaceholderToken } from '../../../../../examples/bare/endpoint';
import {
  BARE_BUNDLE_SCRIPT,
  UNRECOGNISED_BUNDLE_PHASE,
  rewriteBundlePhase,
  rewriteProjectBundlePhase,
} from '../bundle-phase';
import { decodePbxString, encodePbxString } from '../pbx-string';
import { bugseePropertiesText, isPlaceholderToken } from '../properties';
import {
  CANNOT_EDIT,
  applyUploadSourcemapsProperty,
  ensureAppAppliesPlugin,
  ensureGradlePluginDeclared,
  ensureMavenCentral,
  ensureSymbolUploads,
} from '../gradle';
import type { GradleProperty } from '../gradle';
import { insertDsymPostAction, removeDsymPostAction } from '../scheme';
import {
  DSYM_POST_ACTION_SCRIPT,
  RESOLVE_BUGSEE_CLI_PACKAGE,
  dsymPostActionScript,
  resolveNativeCliPackageSource,
} from '../dsym-script';
import { manifestAutoLaunchToken } from '../manifest';
import { loadNativeVersions } from '../native-versions';

const repoRoot = join(__dirname, '..', '..', '..', '..', '..');

function expoSdk57AppBuildGradle(): string {
  const tarball = join(repoRoot, 'examples/expo/node_modules/expo/template.tgz');
  const result = spawnSync('tar', ['-xOf', tarball, 'package/android/app/build.gradle'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(result.stderr || `could not read Expo SDK 57 app/build.gradle from ${tarball}`);
  }
  return result.stdout;
}

function buildTypeBody(source: string, name: string): string {
  const extentStart = source.indexOf('buildTypes {');
  if (extentStart < 0) {
    throw new Error('buildTypes missing');
  }
  const openBuild = source.indexOf('{', extentStart);
  let depth = 0;
  let buildEnd = -1;
  for (let i = openBuild; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        buildEnd = i;
        break;
      }
    }
  }
  const region = source.slice(openBuild + 1, buildEnd);
  const match = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*\\{`).exec(region);
  if (!match || match.index === undefined) {
    throw new Error(`${name} build type missing`);
  }
  const openRel = match.index + match[0].length - 1;
  let inner = 0;
  for (let i = openRel; i < region.length; i += 1) {
    if (region[i] === '{') {
      inner += 1;
    } else if (region[i] === '}') {
      inner -= 1;
      if (inner === 0) {
        return region.slice(openRel + 1, i);
      }
    }
  }
  throw new Error(`${name} build type unclosed`);
}
const barePbx = join(
  repoRoot,
  'examples/bare/ios/BareExample.xcodeproj/project.pbxproj',
);

function requireResolveCalls(script: string): string[] {
  const calls: string[] = [];
  const needle = 'require.resolve(';
  let from = 0;
  while (from < script.length) {
    const start = script.indexOf(needle, from);
    if (start < 0) break;
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < script.length; i++) {
      if (script[i] === '(') depth++;
      else if (script[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    calls.push(script.slice(start, i));
    from = i;
  }
  return calls;
}

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

const SOURCEMAPS_HOOK_TEXT = [
  '// bugsee-sourcemaps: debug ids and source-map upload for release bundles (@bugsee/react-native).',
  'apply from: new File(new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/bugsee-sourcemaps.gradle")',
].join('\n');

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

  it('resolves the CLI from the wrapper and the native package from the CLI', () => {
    expect(DSYM_POST_ACTION_SCRIPT).not.toContain(
      "require.resolve('@bugsee/cli/bin/bugsee-cli.js')",
    );
    expect(DSYM_POST_ACTION_SCRIPT).not.toMatch(
      /require\.resolve\(['"]@bugsee\/cli\/bin\/bugsee-cli\.js['"]\)/,
    );
    expect(DSYM_POST_ACTION_SCRIPT).not.toContain('packages/react-native/node_modules');
    expect(DSYM_POST_ACTION_SCRIPT).not.toContain(
      "require.resolve('@bugsee/cli/package.json', { paths: [appRoot] })",
    );
    expect(DSYM_POST_ACTION_SCRIPT).not.toContain(
      "require.resolve('@bugsee/cli/package.json', { paths: [process.argv[1]] })",
    );
    expect(DSYM_POST_ACTION_SCRIPT).toContain('APP_ROOT="${PROJECT_DIR}/.."');
    expect(DSYM_POST_ACTION_SCRIPT).toContain('uname -m');
    expect(DSYM_POST_ACTION_SCRIPT).toContain(".bin['bugsee-cli']");
    expect(RESOLVE_BUGSEE_CLI_PACKAGE).toContain(
      "require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] })",
    );
    expect(DSYM_POST_ACTION_SCRIPT).toContain(
      "require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] })",
    );
    expect(DSYM_POST_ACTION_SCRIPT).toContain(
      "require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] })",
    );
    expect(DSYM_POST_ACTION_SCRIPT).toContain(
      resolveNativeCliPackageSource('@bugsee/cli-darwin-x64/package.json'),
    );
    expect(DSYM_POST_ACTION_SCRIPT).toContain(
      resolveNativeCliPackageSource('@bugsee/cli-darwin-arm64/package.json'),
    );

    const calls = requireResolveCalls(DSYM_POST_ACTION_SCRIPT);
    expect(calls).toEqual([
      "require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] })",
      "require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] })",
      "require.resolve('@bugsee/cli-darwin-x64/package.json', { paths: [cliDir] })",
      "require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] })",
      "require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] })",
      "require.resolve('@bugsee/cli-darwin-arm64/package.json', { paths: [cliDir] })",
      "require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] })",
      "require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] })",
    ]);

    const printScripts = [...DSYM_POST_ACTION_SCRIPT.matchAll(/--print "([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(printScripts).toHaveLength(3);
    for (const src of printScripts) {
      expect(src).not.toContain('PROJECT_DIR');
      expect(src).not.toContain('APP_ROOT');
      expect(src).not.toContain('process.cwd');
    }
    expect(DSYM_POST_ACTION_SCRIPT.match(/--print "[^"]*" "\$APP_ROOT"/g)).toHaveLength(3);

    const nativeRun = DSYM_POST_ACTION_SCRIPT.indexOf('"$NATIVE_BIN" xcode post-action');
    const jsRun = DSYM_POST_ACTION_SCRIPT.indexOf('"$NODE_BINARY" "$CLI_JS" xcode post-action');
    const exitAt = DSYM_POST_ACTION_SCRIPT.lastIndexOf('exit 1');
    expect(nativeRun).toBeGreaterThan(-1);
    expect(jsRun).toBeGreaterThan(nativeRun);
    expect(exitAt).toBeGreaterThan(jsRun);
  });

  it('resolves a nested @bugsee/cli from the wrapper and a hoisted one from the app root', () => {
    expect(DSYM_POST_ACTION_SCRIPT).not.toContain(
      "require.resolve('@bugsee/cli/bin/bugsee-cli.js')",
    );

    const roots: string[] = [];
    function makeRoot(): string {
      const root = mkdtempSync(join(tmpdir(), 'bugsee-cli-resolve-'));
      roots.push(root);
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
      return root;
    }
    function writePackage(file: string, value: unknown): void {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(value));
    }
    function nodePrint(source: string, start: string): { status: number | null; stdout: string; stderr: string } {
      const result = spawnSync(process.execPath, ['--print', source, start], {
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
      });
      return {
        status: result.status,
        stdout: (result.stdout ?? '').trim(),
        stderr: result.stderr ?? '',
      };
    }

    try {
      const nested = makeRoot();
      writePackage(join(nested, 'node_modules/@bugsee/react-native/package.json'), {
        name: '@bugsee/react-native',
      });
      const nestedCli = join(
        nested,
        'node_modules/@bugsee/react-native/node_modules/@bugsee/cli/package.json',
      );
      writePackage(nestedCli, {
        name: '@bugsee/cli',
        bin: { 'bugsee-cli': 'bin/bugsee-cli.js' },
      });
      const nestedNative = join(
        dirname(nestedCli),
        'node_modules/@bugsee/cli-darwin-arm64/package.json',
      );
      writePackage(nestedNative, { name: '@bugsee/cli-darwin-arm64' });

      const nestedFromApp = nodePrint(
        "require.resolve('@bugsee/cli/package.json', { paths: [process.argv[1]] })",
        nested,
      );
      expect(nestedFromApp.status).not.toBe(0);
      expect(nestedFromApp.stderr).toMatch(/MODULE_NOT_FOUND|Cannot find module/);

      const wrapperPkg = nodePrint(
        "require.resolve('@bugsee/react-native/package.json', { paths: [process.argv[1]] })",
        nested,
      );
      expect(wrapperPkg.status).toBe(0);
      const nestedFromWrapper = nodePrint(
        "require.resolve('@bugsee/cli/package.json', { paths: [process.argv[1]] })",
        dirname(wrapperPkg.stdout),
      );
      expect(nestedFromWrapper.status).toBe(0);
      expect(nestedFromWrapper.stdout).toBe(realpathSync(nestedCli));

      const nestedViaScript = nodePrint(RESOLVE_BUGSEE_CLI_PACKAGE, nested);
      expect(nestedViaScript.status).toBe(0);
      expect(nestedViaScript.stdout).toBe(realpathSync(nestedCli));

      const nativeFromApp = nodePrint(
        "require.resolve('@bugsee/cli-darwin-arm64/package.json', { paths: [process.argv[1]] })",
        nested,
      );
      expect(nativeFromApp.status).not.toBe(0);
      const nativeViaScript = nodePrint(
        resolveNativeCliPackageSource('@bugsee/cli-darwin-arm64/package.json'),
        nested,
      );
      expect(nativeViaScript.status).toBe(0);
      expect(nativeViaScript.stdout).toBe(realpathSync(nestedNative));

      const hoisted = makeRoot();
      writePackage(join(hoisted, 'node_modules/@bugsee/react-native/package.json'), {
        name: '@bugsee/react-native',
      });
      const hoistedCli = join(hoisted, 'node_modules/@bugsee/cli/package.json');
      writePackage(hoistedCli, {
        name: '@bugsee/cli',
        bin: { 'bugsee-cli': 'bin/bugsee-cli.js' },
      });

      const hoistedFromApp = nodePrint(
        "require.resolve('@bugsee/cli/package.json', { paths: [process.argv[1]] })",
        hoisted,
      );
      expect(hoistedFromApp.status).toBe(0);
      expect(hoistedFromApp.stdout).toBe(realpathSync(hoistedCli));

      const hoistedViaScript = nodePrint(RESOLVE_BUGSEE_CLI_PACKAGE, hoisted);
      expect(hoistedViaScript.status).toBe(0);
      expect(hoistedViaScript.stdout).toBe(realpathSync(hoistedCli));
    } finally {
      for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
      }
    }
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
      'buildscript {',
      '    repositories { google(); mavenCentral() }',
      '}',
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

  it('drops a direct NDK implementation when native crash reporting is turned off', () => {
    const app = [
      'apply plugin: "com.android.application"',
      'apply plugin: "com.facebook.react"',
      '',
      'dependencies {',
      '    implementation("com.facebook.react:react-android")',
      '}',
      '',
    ].join('\n');
    const enabled = ensureAppAppliesPlugin(app, versions.sdk);
    expect(enabled).toContain(`implementation "com.bugsee:bugsee-android-ndk:${versions.sdk}"`);
    const next = ensureAppAppliesPlugin(enabled, null);
    expect(next).not.toMatch(/implementation\s+["']com\.bugsee:bugsee-android-ndk:/);
    expect(next).toContain("exclude group: 'com.bugsee', module: 'bugsee-android-ndk'");
    expect(next).toContain('implementation("com.facebook.react:react-android")');
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

  it('writes Expo SDK 57 symbol hooks, no symbol level, and drops the NDK when native crash reporting is off', () => {
    const template = expoSdk57AppBuildGradle();
    expect(template).toContain('hermes-compiler/package.json');
    expect(template).not.toContain('hermesc-preserve-js.sh');
    expect(template).not.toContain('SYMBOL_TABLE');

    const next = ensureAppAppliesPlugin(template, versions.sdk);
    expect(next).toContain('apply plugin: "com.bugsee.android.gradle"');
    expect(next).toContain(`implementation "com.bugsee:bugsee-android-ndk:${versions.sdk}"`);
    expect(next.match(/com\.bugsee\.android\.gradle/g)).toHaveLength(1);

    // Gradle plugin 4.0.8 reads the unstripped libraries: no level is written.
    expect(next).not.toContain('debugSymbolLevel');
    expect(next).not.toContain('bugsee-symbol-table:');
    expect(buildTypeBody(next, 'debug')).toBe(buildTypeBody(template, 'debug'));
    expect(buildTypeBody(next, 'release')).toBe(buildTypeBody(template, 'release'));

    const hermes = next.split('\n').filter((line) => /^\s*hermesCommand\s*=/.test(line));
    expect(hermes).toEqual([
      '    hermesCommand = new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/scripts/hermesc-preserve-js.sh"',
    ]);
    expect(hermes[0]).not.toContain('../../node_modules');
    expect(hermes[0]).not.toContain('hermes-compiler');
    expect(next).toContain('// hermesCommand = "$rootDir/my-custom-hermesc/bin/hermesc"');

    expect(next.endsWith(`\n\n${SOURCEMAPS_HOOK_TEXT}\n`)).toBe(true);
    expect(next.match(/bugsee-sourcemaps\.gradle/g)).toHaveLength(1);
    expect(next).not.toContain('afterEvaluate');
    // Resolved through node, so a hoisted or nested install works.
    expect(SOURCEMAPS_HOOK_TEXT).not.toContain('../../node_modules');
    expect(next).not.toContain('bugsee-cli');
    expect(next).not.toContain('debug-files');
    expect(ensureAppAppliesPlugin(next, versions.sdk)).toBe(next);

    const off = ensureAppAppliesPlugin(next, null);
    expect(off).not.toContain('bugsee-symbol-table:');
    expect(off).not.toContain('SYMBOL_TABLE');
    expect(off).not.toMatch(/implementation\s+["']com\.bugsee:bugsee-android-ndk:/);
    expect(off).toContain("exclude group: 'com.bugsee', module: 'bugsee-android-ndk'");
    expect(buildTypeBody(off, 'debug')).toContain('signingConfig signingConfigs.debug');
    expect(buildTypeBody(off, 'release')).toContain('minifyEnabled enableMinifyInReleaseBuilds');
    expect(buildTypeBody(off, 'debug')).not.toContain('ndk');
    expect(buildTypeBody(off, 'release')).not.toContain('ndk');
    expect(off).toContain('hermesc-preserve-js.sh');
    expect(off.match(/bugsee-sourcemaps\.gradle/g)).toHaveLength(1);
    expect(ensureAppAppliesPlugin(off, null)).toBe(off);
  });

  it('finds hermesc nested under react-native when the app sibling package is missing', () => {
    const app = mkdtempSync(join(tmpdir(), 'bugsee-hermesc-'));
    try {
      const osbin =
        process.platform === 'linux' ? 'linux64-bin' : process.platform === 'win32' ? 'win64-bin' : 'osx-bin';
      const bin = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
      const nested = join(app, 'node_modules/react-native/node_modules/hermes-compiler');
      mkdirSync(join(nested, 'hermesc', osbin), { recursive: true });
      writeFileSync(join(app, 'node_modules/react-native/package.json'), '{"name":"react-native"}\n');
      writeFileSync(join(nested, 'package.json'), '{"name":"hermes-compiler"}\n');
      const hermesc = join(nested, 'hermesc', osbin, bin);
      writeFileSync(hermesc, '#!/bin/sh\nexit 0\n');
      chmodSync(hermesc, 0o755);
      const shipped = join(app, 'node_modules/react-native/sdks/hermesc', osbin, bin);
      mkdirSync(join(app, 'node_modules/react-native/sdks/hermesc', osbin), { recursive: true });
      writeFileSync(shipped, '#!/bin/sh\nexit 0\n');
      chmodSync(shipped, 0o755);

      const sibling = join(app, 'node_modules/hermes-compiler/hermesc', osbin, bin);
      expect(existsSync(sibling)).toBe(false);
      expect(existsSync(join(app, 'node_modules/hermes-compiler'))).toBe(false);

      const jsDir = join(app, 'android/app/build/generated/assets/createBundleReleaseJsAndAssets');
      mkdirSync(jsDir, { recursive: true });
      const js = join(jsDir, 'index.android.bundle');
      writeFileSync(js, 'console.log("app");\n');

      const script = join(repoRoot, 'packages/react-native/scripts/hermesc-preserve-js.sh');
      const result = spawnSync('bash', [script, '-out', join(app, 'out.hbc'), js], {
        cwd: app,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr ?? '').not.toContain('hermesc binary not found');

      const note = join(
        app,
        'android/app/build/intermediates/bugsee-sourcemaps/createBundleReleaseJsAndAssets/index.android.bundle.bugsee-hermesc',
      );
      const found = readFileSync(note, 'utf8').trim();
      expect(existsSync(shipped)).toBe(true);
      expect(realpathSync(found)).toBe(realpathSync(hermesc));
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('finds the shipped sdks/hermesc binary when hermes-compiler is absent', () => {
    const app = mkdtempSync(join(tmpdir(), 'bugsee-hermesc-081-'));
    try {
      const osbin =
        process.platform === 'linux' ? 'linux64-bin' : process.platform === 'win32' ? 'win64-bin' : 'osx-bin';
      const bin = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
      const rn = join(app, 'node_modules/react-native');
      mkdirSync(join(rn, 'sdks/hermesc', osbin), { recursive: true });
      writeFileSync(join(rn, 'package.json'), '{"name":"react-native"}\n');
      const hermesc = join(rn, 'sdks/hermesc', osbin, bin);
      writeFileSync(hermesc, '#!/bin/sh\nexit 0\n');
      chmodSync(hermesc, 0o755);

      expect(existsSync(join(app, 'node_modules/hermes-compiler'))).toBe(false);
      expect(existsSync(join(rn, 'node_modules/hermes-compiler'))).toBe(false);

      const jsDir = join(app, 'android/app/build/generated/assets/createBundleReleaseJsAndAssets');
      mkdirSync(jsDir, { recursive: true });
      const js = join(jsDir, 'index.android.bundle');
      writeFileSync(js, 'console.log("app");\n');

      const script = join(repoRoot, 'packages/react-native/scripts/hermesc-preserve-js.sh');
      const result = spawnSync('bash', [script, '-out', join(app, 'out.hbc'), js], {
        cwd: app,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr ?? '').not.toContain('hermesc binary not found');

      const note = join(
        app,
        'android/app/build/intermediates/bugsee-sourcemaps/createBundleReleaseJsAndAssets/index.android.bundle.bugsee-hermesc',
      );
      expect(realpathSync(readFileSync(note, 'utf8').trim())).toBe(realpathSync(hermesc));
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('leaves a hand-written ndk block, on and off, and takes the old block an earlier prebuild wrote', () => {
    const template = expoSdk57AppBuildGradle().replace(
      '        debug {\n            signingConfig signingConfigs.debug\n        }',
      [
        '        debug {',
        '            signingConfig signingConfigs.debug',
        '            ndk {',
        "                debugSymbolLevel 'FULL'",
        '            }',
        '        }',
      ].join('\n'),
    );
    // An earlier prebuild wrote the old block into release (debug had the user's own ndk block).
    const oldBlock = [
      "            // bugsee-symbol-table: AGP defaults this to NONE, so the plugin's native upload finds",
      '            // nothing and skips. SYMBOL_TABLE emits symbols for code this app',
      '            // builds. Maven Hermes and libreactnative.so are pre-stripped;',
      '            // this level does not symbolicate those two.',
      '            ndk {',
      "                debugSymbolLevel 'SYMBOL_TABLE'",
      '            }',
    ].join('\n');
    const releaseBody = buildTypeBody(template, 'release');
    const closerLine = template.lastIndexOf('\n', template.indexOf(releaseBody) + releaseBody.length) + 1;
    const withOld = `${template.slice(0, closerLine)}${oldBlock}\n${template.slice(closerLine)}`;
    expect(buildTypeBody(withOld, 'release')).toContain(oldBlock);
    const enabled = ensureAppAppliesPlugin(withOld, versions.sdk);
    // Exactly what a prebuild of the file without the old block gives.
    expect(enabled).toBe(ensureAppAppliesPlugin(template, versions.sdk));
    expect(buildTypeBody(enabled, 'debug')).toContain("debugSymbolLevel 'FULL'");
    expect(enabled).not.toContain('SYMBOL_TABLE');

    const off = ensureAppAppliesPlugin(enabled, null);
    expect(buildTypeBody(off, 'debug')).toContain("debugSymbolLevel 'FULL'");
    expect(buildTypeBody(off, 'debug')).not.toContain('bugsee-symbol-table:');
    expect(off).not.toContain('SYMBOL_TABLE');
    expect(off).not.toContain('bugsee-symbol-table:');
    expect(off).not.toMatch(/implementation\s+["']com\.bugsee:bugsee-android-ndk:/);
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
    expect(next.match(/<PostActions>/g)).toHaveLength(1);
    expect(next.match(/<\/PostActions>/g)).toHaveLength(1);
    expect(next).toContain('title = "Upload dSYMs"');
    const encoded = next.match(/\bscriptText\s*=\s*"([^"]*)"/)?.[1];
    expect(encoded).toEqual(expect.any(String));
    expect(decodeXml(encoded ?? '')).toBe(DSYM_POST_ACTION_SCRIPT);
    expect(next).toContain('BlueprintName = "BugseeExpo"');
    expect(next).not.toContain('BareExample');
    expect(insertDsymPostAction(next, DSYM_POST_ACTION_SCRIPT)).toBe(next);
  });

  it('inserts the Bugsee action into an existing Archive PostActions element', () => {
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
      <PostActions>
         <ExecutionAction
            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">
            <ActionContent
               title = "Notify"
               scriptText = "echo archive-finished">
               <EnvironmentBuildable>
                  <BuildableReference
                     BuildableIdentifier = "primary"
                     BlueprintIdentifier = "13B07F861A680F5B00A75B9A"
                     BuildableName = "BugseeExpo.app"
                     BlueprintName = "BugseeExpo"
                     ReferencedContainer = "container:BugseeExpo.xcodeproj">
                  </BuildableReference>
               </EnvironmentBuildable>
            </ActionContent>
         </ExecutionAction>
      </PostActions>
   </ArchiveAction>
</Scheme>
`;
    const next = insertDsymPostAction(scheme, DSYM_POST_ACTION_SCRIPT);
    expect(next.match(/<PostActions>/g)).toHaveLength(1);
    expect(next.match(/<\/PostActions>/g)).toHaveLength(1);
    const archive = next.match(/<ArchiveAction\b[\s\S]*?<\/ArchiveAction>/)?.[0] ?? '';
    const open = archive.indexOf('<PostActions>');
    const close = archive.indexOf('</PostActions>');
    const inner = archive.slice(open, close);
    expect(inner.match(/<PostActions>/g)).toHaveLength(1);
    expect(inner).toContain('title = "Notify"');
    expect(inner).toContain('echo archive-finished');
    expect(inner).toContain('title = "Upload dSYMs"');
    expect(archive.match(/<ExecutionAction\b/g)).toHaveLength(2);
    expect(next).not.toContain('<PostActions>\n      <PostActions>');
    expect(insertDsymPostAction(next, DSYM_POST_ACTION_SCRIPT)).toBe(next);
  });

  it('removes the Bugsee action from an existing Archive PostActions element and keeps the sibling', () => {
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
      <PostActions>
         <ExecutionAction
            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">
            <ActionContent
               title = "Notify"
               scriptText = "echo archive-finished">
               <EnvironmentBuildable>
                  <BuildableReference
                     BuildableIdentifier = "primary"
                     BlueprintIdentifier = "13B07F861A680F5B00A75B9A"
                     BuildableName = "BugseeExpo.app"
                     BlueprintName = "BugseeExpo"
                     ReferencedContainer = "container:BugseeExpo.xcodeproj">
                  </BuildableReference>
               </EnvironmentBuildable>
            </ActionContent>
         </ExecutionAction>
      </PostActions>
   </ArchiveAction>
</Scheme>
`;
    const inserted = insertDsymPostAction(scheme, DSYM_POST_ACTION_SCRIPT);
    expect(inserted).toContain('title = "Upload dSYMs"');
    expect(inserted).toContain('xcode post-action');
    const next = removeDsymPostAction(inserted);
    expect(next).not.toContain('xcode post-action');
    expect(next).not.toContain('title = "Upload dSYMs"');
    expect(next).toContain('title = "Notify"');
    expect(next).toContain('echo archive-finished');
    const archive = next.match(/<ArchiveAction\b[\s\S]*?<\/ArchiveAction>/)?.[0] ?? '';
    expect(archive.match(/<PostActions>/g)).toHaveLength(1);
    expect(archive.match(/<\/PostActions>/g)).toHaveLength(1);
    expect(archive.match(/<ExecutionAction\b/g)).toHaveLength(1);
    expect(removeDsymPostAction(next)).toBe(next);
  });

  it('drops PostActions when the Bugsee action was the only child', () => {
    const inserted = insertDsymPostAction(scheme, DSYM_POST_ACTION_SCRIPT);
    expect(inserted).toContain('<PostActions>');
    expect(inserted).toContain('xcode post-action');
    const next = removeDsymPostAction(inserted);
    expect(next).not.toContain('xcode post-action');
    expect(next).not.toContain('Upload dSYMs');
    expect(next).not.toContain('<PostActions');
    expect(next).toContain('<ArchiveAction');
    expect(next).toContain('</ArchiveAction>');
    expect(next).toContain('BuildableName = "BugseeExpo.app"');
    expect(removeDsymPostAction(next)).toBe(next);
  });
});

describe('scheme post-action replacement', () => {
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

  it('replaces an earlier Bugsee action so a new token lands, once', () => {
    const first = insertDsymPostAction(scheme, dsymPostActionScript('tok-1'));
    const second = insertDsymPostAction(first, dsymPostActionScript('tok-2'));
    expect(second).toBe(insertDsymPostAction(scheme, dsymPostActionScript('tok-2')));
    expect(second).not.toContain('tok-1');
    expect(second.match(/xcode post-action/g)).toHaveLength(2);
    expect(second.match(/<ExecutionAction\b/g)).toHaveLength(1);
    expect(insertDsymPostAction(second, dsymPostActionScript('tok-2'))).toBe(second);
    expect(insertDsymPostAction(second)).toBe(insertDsymPostAction(scheme));
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

describe('source-map hook upgrade', () => {
  const versions = loadNativeVersions(join(__dirname, '..', '..', 'build'));
  const fixtures = join(__dirname, 'fixtures');
  const legacyMarker = '// After compose-source-maps.js. Release variants only; debug does not bundle.';

  function withoutHook(source: string): string {
    return source.slice(0, source.indexOf(SOURCEMAPS_HOOK_TEXT));
  }

  it('replaces the inline hooks earlier versions wrote with the apply line', () => {
    const template = expoSdk57AppBuildGradle();
    const fresh = ensureAppAppliesPlugin(template, versions.sdk);
    for (const fixture of ['finish-hook-0.0.0.gradle', 'finish-hook-13.6-r1.gradle']) {
      const oldHook = readFileSync(join(fixtures, fixture), 'utf8');
      expect(oldHook.startsWith(legacyMarker)).toBe(true);
      const stale = `${withoutHook(fresh)}${oldHook}`;
      const next = ensureAppAppliesPlugin(stale, versions.sdk);
      expect(next).toBe(fresh);
      expect(next).not.toContain('afterEvaluate');
      expect(next).not.toContain('defaultConfig.versionName');
      expect(ensureAppAppliesPlugin(next, versions.sdk)).toBe(next);
    }
  });

  it('keeps what follows the hook when replacing it', () => {
    const current = ensureAppAppliesPlugin(expoSdk57AppBuildGradle(), versions.sdk);
    const withTail = `${current}\n// user tail\ntask hello {}\n`;
    const next = ensureAppAppliesPlugin(withTail, versions.sdk);
    expect(next).toBe(withTail);
  });

  it('appends a fresh hook when a marker has no complete hook after it', () => {
    const currentMarker = SOURCEMAPS_HOOK_TEXT.split('\n')[0] as string;
    for (const broken of [`${legacyMarker}\n`, `${legacyMarker}\nafterEvaluate {\n}\n`, `${currentMarker}\n`]) {
      const next = ensureAppAppliesPlugin(`apply plugin: "com.facebook.react"\n${broken}`, versions.sdk);
      expect(next.match(/scripts\/bugsee-sourcemaps\.gradle/g)).toHaveLength(1);
      expect(next.endsWith(`\n\n${SOURCEMAPS_HOOK_TEXT}\n`)).toBe(true);
    }
  });

  it('replaces a current hook that ends the file without a newline', () => {
    const source = `apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\n\n${SOURCEMAPS_HOOK_TEXT}`;
    const next = ensureAppAppliesPlugin(source, null);
    expect(next.match(/scripts\/bugsee-sourcemaps\.gradle/g)).toHaveLength(1);
    expect(ensureAppAppliesPlugin(next, null)).toBe(next);
  });

  it('ships the Gradle script the apply line names', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/react-native/package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('scripts/bugsee-sourcemaps.gradle');
    expect(pkg.files).toContain('scripts/hermes-sourcemaps.js');
    expect(existsSync(join(repoRoot, 'packages/react-native/scripts/bugsee-sourcemaps.gradle'))).toBe(true);
  });
});

describe('hook leftovers never cost user code', () => {
  const versions = loadNativeVersions(join(__dirname, '..', '..', 'build'));
  const currentMarker = SOURCEMAPS_HOOK_TEXT.split('\n')[0] as string;
  const applyLine = SOURCEMAPS_HOOK_TEXT.split('\n')[1] as string;
  const legacyMarker = '// After compose-source-maps.js. Release variants only; debug does not bundle.';
  const legacyHook = readFileSync(join(__dirname, 'fixtures', 'finish-hook-13.6-r1.gradle'), 'utf8').trimEnd();
  const userDeps = 'dependencies {\n    implementation("com.example:kept:1.0")\n}';

  function hookCount(text: string): number {
    return text.split('\n').filter((line) => line === currentMarker).length;
  }

  it('keeps the user block after an orphaned marker across two --no-clean prebuilds', () => {
    // The user deleted the apply line and kept the marker.
    const source = `apply plugin: "com.facebook.react"\n\n${currentMarker}\n${userDeps}\n`;
    const once = ensureAppAppliesPlugin(source, versions.sdk);
    const twice = ensureAppAppliesPlugin(once, versions.sdk);
    for (const text of [once, twice]) {
      expect(text).toContain('implementation("com.example:kept:1.0")');
      expect(hookCount(text)).toBe(1);
      expect(text).toContain(`${currentMarker}\n${applyLine}`);
    }
    expect(twice).toBe(once);
  });

  it('takes a legacy marker as a hook only with its def bugseeHermesSourcemaps line', () => {
    const userAfter = 'afterEvaluate {\n    println("mine")\n}';
    for (const between of ['android { }\n', '', '// mine\n// also mine\n', 'def bugseeMyFlag = true\n']) {
      const source = `apply plugin: "com.facebook.react"\n${legacyMarker}\n${between}${userAfter}\n`;
      const next = ensureAppAppliesPlugin(source, versions.sdk);
      expect(next).not.toContain(legacyMarker);
      expect(next).toContain(`apply plugin: "com.facebook.react"\napply plugin: "com.bugsee.android.gradle"\n${between}${userAfter}\n`);
      expect(ensureAppAppliesPlugin(next, versions.sdk)).toBe(next);
    }
  });

  it('never closes a legacy hook on a brace that is not its own', () => {
    const fingerprint = 'def bugseeHermesSourcemaps = "x"';
    // Unclosed afterEvaluate: the user's dependencies block must not become its end. Refused, never cut.
    const unclosed = `apply plugin: "com.facebook.react"\n${legacyMarker}\n${fingerprint}\nafterEvaluate {\n${userDeps}\n`;
    expect(() => ensureAppAppliesPlugin(unclosed, versions.sdk)).toThrow(
      `${CANNOT_EDIT} android/app/build.gradle: line 4: a brace opened on this line never closes`,
    );
    // A matching brace that is indented is not the hook's either: only the marker goes.
    const indented = `apply plugin: "com.facebook.react"\n${legacyMarker}\n${fingerprint}\nafterEvaluate {\n    x()\n  }\n${userDeps}\n`;
    const kept = ensureAppAppliesPlugin(indented, versions.sdk);
    expect(kept).toContain(`${fingerprint}\nafterEvaluate {\n    x()\n  }\n`);
    expect(kept).toContain('implementation("com.example:kept:1.0")');
    expect(kept).not.toContain(legacyMarker);
    // A brace inside a string does not count, so the real one closes the hook.
    const quoted = `apply plugin: "com.facebook.react"\n${legacyMarker}\n${fingerprint}\nafterEvaluate {\n    def s = "{"\n}\n${userDeps}\n`;
    const replaced = ensureAppAppliesPlugin(quoted, versions.sdk);
    expect(replaced).not.toContain(fingerprint);
    expect(replaced).toContain(`${SOURCEMAPS_HOOK_TEXT}\ndependencies {\n`);
    expect(replaced).toContain('implementation("com.example:kept:1.0")');
  });

  it('removes every combination of leftovers and nothing else', () => {
    const leftovers: Record<string, string> = {
      orphanCurrent: currentMarker,
      currentHook: `${currentMarker}\n${applyLine}`,
      orphanLegacy: legacyMarker,
      legacyHook,
      strayApply: applyLine,
    };
    const names = Object.keys(leftovers);
    const userParts = [
      'apply plugin: "com.facebook.react"',
      'android {\n    namespace "com.example"\n}',
      userDeps,
      'task hello {\n    doLast { println("hi") }\n}',
      '// a user comment',
    ];
    const plain = ensureAppAppliesPlugin(`${userParts.join('\n')}\n`, versions.sdk);
    const withoutHook = (text: string): string =>
      text
        .split('\n')
        .filter((line) => line !== currentMarker && line !== applyLine)
        .join('\n')
        .replace(/\s*$/, '');
    for (let mask = 1; mask < 1 << names.length; mask += 1) {
      const parts: string[] = [];
      userParts.forEach((part, i) => {
        parts.push(part);
        const name = names[i];
        if (name !== undefined && mask & (1 << i)) {
          parts.push(leftovers[name] as string);
        }
      });
      const next = ensureAppAppliesPlugin(`${parts.join('\n')}\n`, versions.sdk);
      expect([mask, withoutHook(next)]).toEqual([mask, withoutHook(plain)]);
      expect([mask, hookCount(next)]).toEqual([mask, 1]);
      expect([mask, next.split('\n').filter((line) => line === applyLine).length]).toEqual([mask, 1]);
      expect([mask, next.includes(`${currentMarker}\n${applyLine}\n`)]).toEqual([mask, true]);
      expect([mask, next.includes(legacyMarker)]).toEqual([mask, false]);
      expect([mask, ensureAppAppliesPlugin(next, versions.sdk)]).toEqual([mask, next]);
    }
  });
});

describe('native pins after a wrapper bump (--no-clean)', () => {
  it('rewrites the declared Gradle plugin version in place', () => {
    const project = [
      'buildscript {',
      '}',
      '',
      'plugins {',
      "    id 'com.bugsee.android.gradle' version '4.0.7' apply false",
      '}',
      '',
    ].join('\n');
    const next = ensureGradlePluginDeclared(project, '4.0.8');
    expect(next).toBe(project.replace("version '4.0.7'", "version '4.0.8'"));
    expect(ensureGradlePluginDeclared(next, '4.0.8')).toBe(next);
    const kotlinStyle = 'plugins {\n    id("com.bugsee.android.gradle") version "4.0.7" apply false\n}\n';
    expect(ensureGradlePluginDeclared(kotlinStyle, '4.0.9')).toBe(
      'plugins {\n    id("com.bugsee.android.gradle") version "4.0.9" apply false\n}\n',
    );
    const classpathOnly = 'buildscript { dependencies { classpath "com.bugsee.android.gradle:x:1" } }\n';
    expect(ensureGradlePluginDeclared(classpathOnly, '4.0.9')).toBe(classpathOnly);
  });

  it('rewrites its own marked bugsee-android-ndk line in place, and never a user one', () => {
    const app = [
      'apply plugin: "com.facebook.react"',
      'apply plugin: "com.bugsee.android.gradle"',
      '',
      'dependencies {',
      '    implementation "com.bugsee:bugsee-android-ndk:7.3.0" // bugsee:ndk',
      '}',
      '',
    ].join('\n');
    const next = ensureAppAppliesPlugin(app, '7.4.0');
    expect(next).toContain('    implementation "com.bugsee:bugsee-android-ndk:7.4.0" // bugsee:ndk');
    expect(next).not.toContain('7.3.0');
    expect(next.match(/bugsee-android-ndk:/g)).toHaveLength(1);
    // A line without the marker, in either quoting, is the user's: left as is, and no second line is added.
    for (const user of [app.replace(' // bugsee:ndk', ''), app.replace(/"com\.bugsee:bugsee-android-ndk:7\.3\.0" \/\/ bugsee:ndk/, "'com.bugsee:bugsee-android-ndk:7.3.0'")]) {
      const log = jest.fn();
      const kept = ensureAppAppliesPlugin(user, '7.4.0', log);
      expect(kept).toContain('bugsee-android-ndk:7.3.0');
      expect(kept).not.toContain('7.4.0');
      expect(kept.match(/bugsee-android-ndk:/g)).toHaveLength(1);
      expect(log).toHaveBeenCalledTimes(1);
    }
    expect(() => ensureAppAppliesPlugin(app, '7.4.0"; evil')).toThrow(`${CANNOT_EDIT} android/app/build.gradle: the NDK artifact version`);
  });
});

describe('Android symbol uploads switch', () => {
  const app = 'apply plugin: "com.facebook.react"\n\ndependencies {\n}\n';
  const line = "tasks.matching { it.name.startsWith('uploadBugsee') }.configureEach { enabled = false }";

  it('disables every uploadBugsee task inside a marked block and removes it again', () => {
    const off = ensureSymbolUploads(app, false);
    expect(off).toContain(line);
    expect(off).toContain('// bugsee-upload-symbols-off: uploadSymbols is false in the Expo config.');
    expect(off.startsWith(app.trimEnd())).toBe(true);
    expect(off.endsWith(`${line}\n`)).toBe(true);
    expect(ensureSymbolUploads(off, false)).toBe(off);
    expect(ensureSymbolUploads(off, true)).toBe(app);
    expect(ensureSymbolUploads(app, true)).toBe(app);
  });

  it('removes the block from the middle of a file without joining its neighbours', () => {
    const off = `${ensureSymbolUploads(app, false)}\n// after\n`;
    // The blank line after the block was never the plugin's.
    expect(ensureSymbolUploads(off, true)).toBe(`${app}\n// after\n`);
  });
});

describe('uploadSourcemaps gradle property', () => {
  it('writes bugseeUploadSourcemaps=false only when off, and removes it when on', () => {
    const base: GradleProperty[] = [
      { type: 'comment', value: 'x' },
      { type: 'property', key: 'hermesEnabled', value: 'true' },
    ];
    const off = applyUploadSourcemapsProperty(base, false);
    expect(off).toEqual([...base, { type: 'property', key: 'bugseeUploadSourcemaps', value: 'false' }]);
    expect(applyUploadSourcemapsProperty(off, false)).toEqual(off);
    expect(applyUploadSourcemapsProperty(off, true)).toEqual(base);
    expect(applyUploadSourcemapsProperty(base, true)).toEqual(base);
    const comment: GradleProperty[] = [{ type: 'comment', value: 'bugseeUploadSourcemaps=false' }];
    expect(applyUploadSourcemapsProperty(comment, true)).toEqual(comment);
  });
});

describe('bundle phase settings and refusals', () => {
  const expo = [
    'export PROJECT_ROOT="$PROJECT_DIR"/..',
    '`"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"`',
    '',
  ].join('\n');

  it('refuses a phase it does not recognise instead of guessing', () => {
    expect(UNRECOGNISED_BUNDLE_PHASE).toContain('Run bugsee-xcode.sh from that phase yourself');
    for (const odd of [
      '../node_modules/react-native/scripts/react-native-xcode.sh\n',
      'echo bundling elsewhere\n',
      '',
    ]) {
      expect(() => rewriteBundlePhase(odd)).toThrow(UNRECOGNISED_BUNDLE_PHASE);
    }
  });

  it('prepends one settings block for the token and the off switch, and replaces it on the next run', () => {
    const plain = rewriteBundlePhase(expo);
    expect(plain).not.toContain('bugsee settings');
    expect(rewriteBundlePhase(expo, { uploadSourcemaps: true })).toBe(plain);

    const set = rewriteBundlePhase(expo, { uploadSourcemaps: false, iosAppToken: 'tok-1' });
    expect(set).toBe(
      [
        '# >>> bugsee settings, written by the @bugsee/react-native config plugin',
        'export BUGSEE_UPLOAD_SOURCEMAPS=false',
        "export BUGSEE_PLUGIN_APP_TOKEN='tok-1'",
        '# <<< bugsee settings',
        plain,
      ].join('\n'),
    );
    expect(rewriteBundlePhase(set, { uploadSourcemaps: false, iosAppToken: 'tok-1' })).toBe(set);

    const changed = rewriteBundlePhase(set, { iosAppToken: 'tok-2' });
    expect(changed).toBe(
      [
        '# >>> bugsee settings, written by the @bugsee/react-native config plugin',
        "export BUGSEE_PLUGIN_APP_TOKEN='tok-2'",
        '# <<< bugsee settings',
        plain,
      ].join('\n'),
    );
    expect(rewriteBundlePhase(changed, {})).toBe(plain);
  });

  it('leaves a lone begin marker alone rather than cutting the script', () => {
    const odd = `# >>> bugsee settings, written by the @bugsee/react-native config plugin\n${rewriteBundlePhase(expo)}`;
    expect(rewriteBundlePhase(odd)).toBe(odd);
  });

  it('rewrites every bundle phase of a project and refuses a project without one', () => {
    const project = {
      hash: {
        project: {
          objects: {
            PBXShellScriptBuildPhase: {
              A: { isa: 'PBXShellScriptBuildPhase', name: '"Bundle React Native code and images"', shellScript: encodePbxString(expo) },
              A_comment: 'Bundle React Native code and images',
              B: { isa: 'PBXShellScriptBuildPhase', name: 'Other', shellScript: 'echo other' },
              C: undefined,
            },
          },
        },
      },
    };
    rewriteProjectBundlePhase(project, { iosAppToken: 'tok' });
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase;
    expect(decodePbxString(phases.A.shellScript)).toBe(rewriteBundlePhase(expo, { iosAppToken: 'tok' }));
    expect(phases.B.shellScript).toBe('echo other');

    const unquoted = {
      hash: { project: { objects: { PBXShellScriptBuildPhase: { A: { name: 'Bundle React Native code and images', shellScript: expo } } } } },
    };
    rewriteProjectBundlePhase(unquoted);
    expect(unquoted.hash.project.objects.PBXShellScriptBuildPhase.A.shellScript).toBe(rewriteBundlePhase(expo));

    expect(() => rewriteProjectBundlePhase({})).toThrow('PBXShellScriptBuildPhase is missing from the Xcode project');
    expect(() =>
      rewriteProjectBundlePhase({ hash: { project: { objects: { PBXShellScriptBuildPhase: { B: { name: 'Other' } } } } } }),
    ).toThrow('Bundle React Native code and images build phase not found');
    expect(() =>
      rewriteProjectBundlePhase({
        hash: { project: { objects: { PBXShellScriptBuildPhase: { A: { name: 'Bundle React Native code and images' } } } } },
      }),
    ).toThrow('Bundle React Native code and images has no shellScript');
  });
});

describe('baked iOS token in the Archive post-action', () => {
  it('is the same script as before without a token', () => {
    expect(dsymPostActionScript()).toBe(DSYM_POST_ACTION_SCRIPT);
    expect(dsymPostActionScript('')).toBe(DSYM_POST_ACTION_SCRIPT);
    expect(DSYM_POST_ACTION_SCRIPT.split('\n').slice(0, 2)).toEqual([
      'CREDS="${PROJECT_DIR}/../credentials.json"',
      'TOKEN="$BUGSEE_APP_TOKEN"',
    ]);
  });

  it('puts the baked token first and keeps the env and credentials fallbacks after it', () => {
    const script = dsymPostActionScript('tok-ios');
    expect(script.split('\n').slice(0, 9)).toEqual([
      'CREDS="${PROJECT_DIR}/../credentials.json"',
      "TOKEN='tok-ios'",
      'if [ -z "$TOKEN" ]; then',
      '  TOKEN="$BUGSEE_APP_TOKEN"',
      'fi',
      'if [ -z "$TOKEN" ]; then',
      '  TOKEN="$BUGSEE_TOKEN_IOS"',
      'fi',
      'if [ -z "$TOKEN" ] && [ -f "$CREDS" ]; then',
    ]);
    expect(script.slice(script.indexOf('if [ -n "$TOKEN" ]; then'))).toBe(
      DSYM_POST_ACTION_SCRIPT.slice(DSYM_POST_ACTION_SCRIPT.indexOf('if [ -n "$TOKEN" ]; then')),
    );
  });

  it('exports the baked token to bugsee-cli when the script runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-dsym-token-'));
    try {
      const bin = join(dir, 'node_modules/@bugsee/react-native');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'package.json'), '{"name":"@bugsee/react-native"}');
      const cliDir = join(dir, 'node_modules/@bugsee/cli');
      mkdirSync(join(cliDir, 'bin'), { recursive: true });
      writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: '@bugsee/cli', bin: { 'bugsee-cli': 'bin/cli.js' } }));
      const seen = join(dir, 'seen');
      writeFileSync(
        join(cliDir, 'bin', 'cli.js'),
        `require('fs').writeFileSync(${JSON.stringify(seen)}, process.env.BUGSEE_APP_TOKEN + ' ' + process.argv.slice(2).join(' '));`,
      );
      mkdirSync(join(dir, 'ios'));
      const run = (script: string, extra: Record<string, string> = {}) =>
        spawnSync('/bin/sh', ['-c', script], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', BUGSEE_ENDPOINT: 'http://127.0.0.1:9', PROJECT_DIR: join(dir, 'ios'), NODE_BINARY: process.execPath, ...extra },
        });
      expect(run(dsymPostActionScript('tok-baked'), { BUGSEE_APP_TOKEN: 'from-env' }).status).toBe(0);
      expect(readFileSync(seen, 'utf8')).toBe('tok-baked xcode post-action');
      expect(run(DSYM_POST_ACTION_SCRIPT, { BUGSEE_APP_TOKEN: 'from-env' }).status).toBe(0);
      expect(readFileSync(seen, 'utf8')).toBe('from-env xcode post-action');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
