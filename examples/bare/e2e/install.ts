/**
 * Installing a build over the app under test without touching its data: the
 * no-wipe half of the upgrade tests (campaign N-15, e2e/upgrade.test.ts).
 *
 *   Android   `adb install -r -d <apk>`: replace, keep data, allow the same
 *             or a lower versionCode (debuggable builds only), so the previous
 *             build can go back on before the next round.
 *   iPhone    `devicectl device install app <.app>` on the allowlisted,
 *             identity-checked XS: an install over the same bundle id keeps
 *             the data container (and the Keychain).
 *   simulator `simctl install <id> <.app>`, which keeps the container too.
 *
 * Every install is checked: the package must be the app under test, and on
 * Android the versionCode the device reports afterwards is returned so the
 * test can assert which build is on.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ANDROID_PACKAGE, IOS_BUNDLE_ID, IOS_SIMULATOR_ID, iosTarget } from './device';
import { adb, adbStatus, devicectl } from './scenario';

const execFileAsync = promisify(execFile);

/** What the device reports for the installed Android package. */
export interface AndroidPackageInfo {
  readonly versionCode: number;
  readonly versionName: string;
  readonly lastUpdateTime: string;
}

export async function androidPackageInfo(): Promise<AndroidPackageInfo | undefined> {
  const { output } = await adbStatus('shell', 'dumpsys', 'package', ANDROID_PACKAGE);
  const code = /versionCode=(\d+)/.exec(output);
  if (code === null) {
    return undefined;
  }
  return {
    versionCode: Number(code[1]),
    versionName: /versionName=(\S+)/.exec(output)?.[1] ?? '?',
    lastUpdateTime: /lastUpdateTime=([^\n]+)/.exec(output)?.[1]?.trim() ?? '?',
  };
}

/** The runtime permissions the installed Android package requests (`dumpsys package`). */
export async function androidRequestedPermissions(): Promise<string[]> {
  const { output } = await adbStatus('shell', 'dumpsys', 'package', ANDROID_PACKAGE);
  const block = /requested permissions:\n((?:\s+\S+\n)+)/.exec(output);
  if (block === null) {
    throw new Error(`dumpsys package ${ANDROID_PACKAGE} lists no requested permissions block:\n${output.slice(0, 2000)}`);
  }
  return block[1]!
    .split('\n')
    .map(line => line.trim().replace(/:.*$/, ''))
    .filter(line => line !== '');
}

/** Which of `names` the device classes as dangerous (runtime) permissions. */
export async function androidDangerousPermissions(names: readonly string[]): Promise<string[]> {
  const { output } = await adbStatus('shell', 'pm', 'list', 'permissions', '-g', '-d');
  const dangerous = new Set(
    output
      .split('\n')
      .map(line => /^\s*permission:(\S+)/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  return names.filter(name => dangerous.has(name));
}

/** The CFBundleIdentifier and versions of an `.app` on this Mac. */
export function iosAppInfo(app: string): { bundleId: string; shortVersion: string; build: string } {
  const plist = join(app, 'Info.plist');
  if (!existsSync(plist)) {
    throw new Error(`${app} is not an app bundle (no Info.plist)`);
  }
  const read = (key: string): string => {
    try {
      return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
    } catch {
      return '?';
    }
  };
  return { bundleId: read('CFBundleIdentifier'), shortVersion: read('CFBundleShortVersionString'), build: read('CFBundleVersion') };
}

/**
 * Installs `artifact` (an `.apk` on Android, an `.app` on iOS) over the app
 * under test, keeping its data. Throws if the artifact is missing or is not
 * the app under test.
 */
export async function installKeepingData(artifact: string, ios: boolean): Promise<void> {
  if (!existsSync(artifact)) {
    throw new Error(`install: ${artifact} does not exist`);
  }
  if (!ios) {
    if (!artifact.endsWith('.apk')) {
      throw new Error(`install: ${artifact} is not an .apk`);
    }
    const { stdout: badging } = await execFileAsync(aapt(), ['dump', 'badging', artifact], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const pkg = /package: name='([^']+)'/.exec(badging)?.[1];
    if (pkg !== ANDROID_PACKAGE) {
      throw new Error(`install: ${artifact} is package ${String(pkg)}, not the app under test ${ANDROID_PACKAGE}`);
    }
    const out = await adb('install', '-r', '-d', artifact);
    if (!/Success/.test(out)) {
      throw new Error(`adb install -r -d ${artifact} did not report Success:\n${out}`);
    }
    return;
  }
  const info = iosAppInfo(artifact);
  if (info.bundleId !== IOS_BUNDLE_ID) {
    throw new Error(`install: ${artifact} is ${info.bundleId}, not the app under test ${IOS_BUNDLE_ID}`);
  }
  if (iosTarget() === 'simulator') {
    await execFileAsync('xcrun', ['simctl', 'install', IOS_SIMULATOR_ID, artifact]);
    return;
  }
  await devicectl('install', 'app', artifact);
}

/** aapt from the newest build-tools this Mac has. */
function aapt(): string {
  const sdk = process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
  const tools = join(sdk, 'build-tools');
  const versions = readdirSync(tools)
    .filter(name => existsSync(join(tools, name, 'aapt')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const newest = versions[versions.length - 1];
  if (newest === undefined) {
    throw new Error(`no aapt under ${tools}`);
  }
  return join(tools, newest, 'aapt');
}

/** The SDK data an Android build left, file by file (relative to bugsee_data). */
export async function androidSdkFiles(): Promise<string[]> {
  const root = 'files/bugsee_data';
  const { output } = await adbStatus('shell', 'run-as', ANDROID_PACKAGE, 'find', root, '-type', 'f');
  if (/No such file or directory/.test(output)) {
    return [];
  }
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith(root))
    .map(line => line.slice(root.length + 1));
}

/** Every file a previous build left in the app's data directory (Android, any SDK generation). */
export async function androidDataFiles(): Promise<string[]> {
  const { output } = await adbStatus('shell', 'run-as', ANDROID_PACKAGE, 'find', '.', '-type', 'f');
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('./'))
    .map(line => line.slice(2));
}
