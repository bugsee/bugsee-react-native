/**
 * Report bundles the SDK retained on the handset, read back off it.
 *
 * Retaining a bundle rather than letting it upload is workbook 9.3.2:
 * airplane mode, switched on before the app starts. A dead endpoint would
 * retain it too, but changes upload timing and so perturbs the very report
 * handler deadlines these tests measure.
 *
 * Everything goes through `run-as`, which needs a debuggable package -- the
 * release build case 6 uses is built debuggable for exactly this reason
 * (see android/app/build.gradle, `bugseeE2eDebuggable`).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ADB, ANDROID_PACKAGE, ANDROID_SERIAL } from './device';
import { adb, adbStatus } from './scenario';

const execFileAsync = promisify(execFile);

const BUNDLES = 'files/bugsee_data/bundles';

export interface ManifestFile {
  readonly type: string;
  readonly name?: string;
  readonly filename?: string;
  readonly [key: string]: unknown;
}

export interface PulledBundle {
  readonly file: string;
  readonly dir: string;
  readonly request: Record<string, unknown>;
  readonly manifest: {
    files: ManifestFile[];
    attrs: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** The `type: "log"` file the manifest names, or undefined if none. */
  readonly log: string | undefined;
}

/** Everything the SDK keeps on disk: capture, pending reports, NDK state. */
const SDK_DATA = 'files/bugsee_data';

/**
 * Leaves the handset with no report of any earlier run: stops the app, then
 * deletes the SDK's whole data directory and asserts it is really gone
 * (9.1.3: assert the precondition you staged actually took).
 *
 * Wider than `bundles/` on purpose, and both halves were learned on the
 * device. A running app wrote a fresh bundle straight after the `rm`, so the
 * app is stopped first. And a report still pending when a run was cut short
 * (in `snapshots/`, or a native crash in `ndk/`) is bundled by the next
 * launch, whichever case that is -- so clearing `bundles/` alone does not
 * stop an earlier run's report landing in this one.
 */
export async function clearAndroidBundles(): Promise<void> {
  await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE);
  await adbStatus('shell', 'run-as', ANDROID_PACKAGE, 'rm', '-rf', SDK_DATA);
  const probe = await adbStatus('shell', 'run-as', ANDROID_PACKAGE, 'ls', SDK_DATA);
  if (!/No such file or directory/.test(probe.output)) {
    throw new Error(
      `clearAndroidBundles: ${SDK_DATA} is still there after rm -rf:\n${probe.output}`,
    );
  }
}

export async function listAndroidBundles(): Promise<string[]> {
  const { output } = await adbStatus('shell', 'run-as', ANDROID_PACKAGE, 'ls', BUNDLES);
  return output
    .split(/\s+/)
    .filter(name => name.endsWith('.bundle.zip'));
}

/** Pulls, unzips and parses every retained bundle. */
export async function pullAndroidBundles(): Promise<PulledBundle[]> {
  const root = mkdtempSync(join(tmpdir(), 'bugsee-bundles-'));
  const bundles: PulledBundle[] = [];
  for (const file of await listAndroidBundles()) {
    const zip = join(root, file);
    const { stdout } = await execFileAsync(
      ADB,
      ['-s', ANDROID_SERIAL, 'exec-out', 'run-as', ANDROID_PACKAGE, 'cat', `${BUNDLES}/${file}`],
      { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
    );
    writeFileSync(zip, stdout);
    const dir = join(root, file.replace(/\.bundle\.zip$/, ''));
    mkdirSync(dir);
    await execFileAsync('unzip', ['-q', '-o', zip, '-d', dir]);
    const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const logEntry = (manifest.files as ManifestFile[]).find(f => f.type === 'log');
    const logName = logEntry === undefined ? undefined : fileNameOf(logEntry);
    const log =
      logName !== undefined && readdirSync(dir).includes(logName)
        ? readFileSync(join(dir, logName), 'utf8')
        : undefined;
    bundles.push({ file, dir, request, manifest, log });
  }
  return bundles;
}

/** The stored file name a manifest entry points at. */
export function fileNameOf(entry: ManifestFile): string | undefined {
  const candidate = entry.filename ?? entry.file ?? entry.path;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** The display name a manifest entry carries (attachments have one). */
export function displayNameOf(entry: ManifestFile): string | undefined {
  const candidate = entry.name ?? (entry.attrs as Record<string, unknown> | undefined)?.name;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** Switches airplane mode and asserts the device reports the new state. */
export async function airplane(on: boolean): Promise<void> {
  const verb = on ? 'enable' : 'disable';
  const set = await adbStatus('shell', 'cmd', 'connectivity', 'airplane-mode', verb);
  if (set.code !== 0) {
    throw new Error(`airplane-mode ${verb} was refused (exit ${set.code}):\n${set.output}`);
  }
  const state = (await adb('shell', 'cmd', 'connectivity', 'airplane-mode')).trim();
  if (state !== (on ? 'enabled' : 'disabled')) {
    throw new Error(`airplane-mode ${verb} did not take: device reports "${state}"`);
  }
}
