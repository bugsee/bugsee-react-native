import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isPlaceholderToken as exampleIsPlaceholderToken } from '../../../../../examples/bare/endpoint';
import { rewriteBundlePhase, BARE_BUNDLE_SCRIPT } from '../bundle-phase';
import { decodePbxString, encodePbxString } from '../pbx-string';
import { bugseePropertiesText, isPlaceholderToken } from '../properties';
import { ensureAppAppliesPlugin, ensureGradlePluginDeclared, ensureMavenCentral } from '../gradle';
import { insertDsymPostAction, removeDsymPostAction } from '../scheme';
import {
  DSYM_POST_ACTION_SCRIPT,
  RESOLVE_BUGSEE_CLI_PACKAGE,
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

  it('writes Expo SDK 57 symbol hooks and drops them when native crash reporting is off', () => {
    const template = expoSdk57AppBuildGradle();
    expect(template).toContain('hermes-compiler/package.json');
    expect(template).not.toContain('hermesc-preserve-js.sh');
    expect(template).not.toContain('SYMBOL_TABLE');

    const next = ensureAppAppliesPlugin(template, versions.sdk);
    expect(next).toContain('apply plugin: "com.bugsee.android.gradle"');
    expect(next).toContain(`implementation "com.bugsee:bugsee-android-ndk:${versions.sdk}"`);
    expect(next.match(/com\.bugsee\.android\.gradle/g)).toHaveLength(1);

    const debug = buildTypeBody(next, 'debug');
    const release = buildTypeBody(next, 'release');
    for (const body of [debug, release]) {
      expect(body.match(/debugSymbolLevel 'SYMBOL_TABLE'/g)).toHaveLength(1);
      expect(body.match(/\bndk\s*\{/g)).toHaveLength(1);
      expect(body).toContain('bugsee-symbol-table:');
      expect(body).toContain('AGP defaults this to NONE');
      expect(body).toContain('Maven Hermes and libreactnative.so are pre-stripped');
      expect(body).toContain('this level does not symbolicate those two');
    }
    expect(next.match(/debugSymbolLevel 'SYMBOL_TABLE'/g)).toHaveLength(2);

    const hermes = next.split('\n').filter((line) => /^\s*hermesCommand\s*=/.test(line));
    expect(hermes).toEqual([
      '    hermesCommand = new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/scripts/hermesc-preserve-js.sh"',
    ]);
    expect(hermes[0]).not.toContain('../../node_modules');
    expect(hermes[0]).not.toContain('hermes-compiler');
    expect(next).toContain('// hermesCommand = "$rootDir/my-custom-hermesc/bin/hermesc"');

    const hook = next.slice(next.lastIndexOf('// After compose-source-maps.js'));
    expect(next.match(/afterEvaluate/g)).toHaveLength(1);
    expect(hook).toContain(
      'def bugseeHermesSourcemaps = new File(new File(["node", "--print", "require.resolve(\'@bugsee/react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/hermes-sourcemaps.js")',
    );
    expect(hook).toContain(
      'def bugseeComposeSourceMaps = new File(new File(["node", "--print", "require.resolve(\'react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile(), "scripts/compose-source-maps.js")',
    );
    expect(hook).toContain('hook.absolutePath, "finish"');
    expect(hook).toContain('Bugsee preserve directory is the packaged asset directory');
    expect(hook).toContain('/intermediates/bugsee-sourcemaps/');
    expect(hook).toContain('Upload is not invoked.');
    expect(hook).toContain('bundleTask.services.get(org.gradle.process.ExecOperations).exec');
    expect(hook).not.toContain('project.exec');
    expect(hook).not.toContain('../../node_modules');
    expect(hook).not.toContain('bugsee-cli');
    expect(hook).not.toContain('debug-files');
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
    expect(off).toContain('Bugsee preserve directory is the packaged asset directory');
    expect(off.match(/afterEvaluate/g)).toHaveLength(1);
    expect(ensureAppAppliesPlugin(off, null)).toBe(off);
  });

  it('rewrites a finish hook that still calls project.exec', () => {
    const current = ensureAppAppliesPlugin(expoSdk57AppBuildGradle(), versions.sdk);
    const stale = current
      .replace(
        'bundleTask.services.get(org.gradle.process.ExecOperations).exec {',
        'project.exec {',
      )
      .replace(
        'apply plugin: "com.facebook.react"',
        'apply plugin: "com.facebook.react"\nproject.exec {\n    commandLine "other"\n}',
      );
    expect(stale).toContain('Bugsee preserve directory is the packaged asset directory');
    expect(stale).toContain('project.exec {');

    const next = ensureAppAppliesPlugin(stale, versions.sdk);
    const hook = next.slice(next.lastIndexOf('// After compose-source-maps.js'));
    expect(hook).toContain('bundleTask.services.get(org.gradle.process.ExecOperations).exec {');
    expect(hook).not.toContain('project.exec');
    expect(next).toContain('project.exec {\n    commandLine "other"\n}');
    expect(ensureAppAppliesPlugin(next, versions.sdk)).toBe(next);
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

  it('leaves a hand-written ndk block when native crash reporting is off', () => {
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
    const enabled = ensureAppAppliesPlugin(template, versions.sdk);
    expect(buildTypeBody(enabled, 'debug')).toContain("debugSymbolLevel 'FULL'");
    expect(buildTypeBody(enabled, 'debug')).not.toContain('SYMBOL_TABLE');
    expect(buildTypeBody(enabled, 'debug')).not.toContain('bugsee-symbol-table:');
    expect(buildTypeBody(enabled, 'release')).toContain("debugSymbolLevel 'SYMBOL_TABLE'");
    expect(buildTypeBody(enabled, 'release').match(/\bndk\s*\{/g)).toHaveLength(1);

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

describe('manifest auto-launch', () => {
  it('writes the meta-data value only when autoLaunch is set and the token is real', () => {
    expect(manifestAutoLaunchToken({ appToken: REAL_TOKEN, autoLaunch: true })).toBe(REAL_TOKEN);
    expect(manifestAutoLaunchToken({ appToken: REAL_TOKEN })).toBeNull();
    expect(manifestAutoLaunchToken({ appToken: PLACEHOLDER, autoLaunch: true })).toBeNull();
    expect(manifestAutoLaunchToken({ appToken: '', autoLaunch: true })).toBeNull();
  });
});
