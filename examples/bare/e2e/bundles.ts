/**
 * Report bundles the SDK retained on the device, read back off it.
 *
 * Android. Retaining a bundle rather than letting it upload is workbook
 * 9.3.2: airplane mode, switched on before the app starts. A dead endpoint
 * would retain it too, but changes upload timing and so perturbs the very
 * report handler deadlines these tests measure. Everything goes through
 * `run-as`, which needs a debuggable package -- the release build case 6 uses
 * is built debuggable for exactly this reason (see android/app/build.gradle,
 * `bugseeE2eDebuggable`).
 *
 * iOS simulator. There is no airplane mode: the simulator shares the host's
 * network, and cutting that (a pf rule, Network Link Conditioner, a proxy)
 * needs root or takes the whole Mac offline. So the app launches against a
 * closed loopback port instead (`DEAD_ENDPOINT`, passed through the scenario
 * file). That is the dead endpoint the workbook warns about, but not the
 * kind that perturbs timing: loopback refuses a connection at once, as an
 * offline radio fails one at once -- nothing hangs waiting on a server. The
 * SDK says so itself (`Session not initialized. - Could not connect to the
 * server.`), and the test asserts that line as the retention precondition.
 * The simulator's data container is a host directory, so clearing and
 * pulling are plain file operations.
 *
 * iPhone (`E2E_IOS_TARGET=device`, allowlisted in device.ts). The same dead endpoint:
 * `127.0.0.1` is then the phone's own loopback, where nothing listens on
 * port 9, and airplane mode has no command-line switch. The data container
 * is reached through devicectl's file service
 * (`--domain-type appDataContainer`): `info files` lists, `copy from` pulls.
 * devicectl cannot delete a single path; its one removal,
 * `copy to --remove-existing-content true`, empties the whole container
 * whatever the destination (seen on the XS: a file in Documents/ and one in
 * Library/Preferences/ went too) and keeps only its standard directories. So
 * clearing an iPhone wipes the app's whole container -- the SDK's data and
 * the crash reporter's queue under Library/Caches, and the SDK's defaults
 * under Library/Preferences -- and then asserts both SDK directories are
 * gone. The Keychain (attributes, identifier) is not in the container and is
 * untouched.
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync, zstdDecompressSync } from 'node:zlib';

import {
  ADB,
  ANDROID_PACKAGE,
  ANDROID_SERIAL,
  IOS_BUNDLE_ID,
  IOS_SIMULATOR_ID,
  iosTarget,
} from './device';
import { adb, adbStatus, devicePidsOfApp, devicectl } from './scenario';

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
  /**
   * Raw text, keyed by manifest `type`, for every entry whose stored file
   * ends in `.json` (`log`, `events.user`, `traces.user`, ...).
   */
  readonly captures: ReadonlyMap<string, string>;
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
/** Every temp root a pull created in this test file, until removed. */
const pulledRoots: string[] = [];

/** A fresh temp root to pull bundles into, tracked for `removePulledBundles`. */
export function newPulledRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bugsee-bundles-'));
  pulledRoots.push(root);
  return root;
}

/**
 * Deletes every root pulled into, unless `E2E_KEEP_BUNDLES=1`. Call from a
 * suite's `afterAll`: a pulled bundle holds what the SDK wrote, and on iOS
 * beta3 that includes the app and access tokens (`log.internal.json`).
 */
export function removePulledBundles(): { removed: string[]; kept: string[] } {
  const roots = pulledRoots.splice(0);
  if (process.env.E2E_KEEP_BUNDLES === '1') {
    return { removed: [], kept: roots };
  }
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  return { removed: roots, kept: [] };
}

export async function pullAndroidBundles(): Promise<PulledBundle[]> {
  const root = newPulledRoot();
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
    bundles.push(parseBundle(file, dir));
  }
  return bundles;
}

/**
 * Reads a pulled bundle's directory: its request, its manifest, and every
 * JSON capture file the manifest names. Exported for the harness's own unit
 * tests (scripts/__tests__/e2e-capture-files.test.ts).
 */
export function parseBundle(file: string, dir: string): PulledBundle {
  const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const logEntry = (manifest.files as ManifestFile[]).find(f => f.type === 'log');
  const logName = logEntry === undefined ? undefined : fileNameOf(logEntry);
  const present = new Set(readdirSync(dir));
  const log =
    logName !== undefined && present.has(logName)
      ? readFileSync(join(dir, logName), 'utf8')
      : undefined;
  // A manifest entry whose file is not in the bundle is skipped, not an
  // error: the caller asserting on that capture is where its absence fails.
  const captures = new Map<string, string>();
  for (const entry of manifest.files as ManifestFile[]) {
    const name = fileNameOf(entry);
    if (name !== undefined && name.endsWith('.json') && present.has(name)) {
      captures.set(entry.type, readFileSync(join(dir, name), 'utf8'));
    }
  }
  return { file, dir, request, manifest, log, captures };
}

/**
 * The `events` array of the capture file of manifest `type` (`log`,
 * `events.user`, `traces.user`), or `[]` when the bundle has none.
 */
export function captureEvents(bundle: PulledBundle, type: string): Array<Record<string, unknown>> {
  const text = bundle.captures.get(type);
  if (text === undefined) {
    return [];
  }
  const document = JSON.parse(text) as { events?: unknown };
  if (!Array.isArray(document.events)) {
    throw new Error(`capture ${type} in ${bundle.file} has no events array: ${text.slice(0, 200)}`);
  }
  return document.events as Array<Record<string, unknown>>;
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

/**
 * The loopback port every iOS run launches against, so every report is
 * retained (see the top of this file). Port 9 (discard) is closed on a Mac
 * and on an iPhone, whose own loopback it is there. The app's own
 * placeholder-token rule uses the same one (endpoint.ts).
 */
export { DEAD_ENDPOINT } from '../endpoint';

/** Whether iOS means the iPhone; read when used, so Android never asks. */
function onDevice(): boolean {
  return iosTarget() === 'device';
}

/** The SDK's data directory, relative to the app's data container. */
const IOS_SDK_DATA = 'Library/Caches/com.bugsee.data';
/** PLCrashReporter's queue: a crash not yet turned into a report. */
const IOS_CRASH_QUEUE = 'Library/Caches/com.bugsee.crashreporter';
/** `<capture>/bundles/<requestId>.bundle.zip`, as the iOS SDK writes them. */
const IOS_BUNDLES = `${IOS_SDK_DATA}/capture/bundles`;

/** The simulator app's data container, a host directory. */
async function simulatorContainer(): Promise<string> {
  const { stdout } = await execFileAsync(
    'xcrun',
    ['simctl', 'get_app_container', IOS_SIMULATOR_ID, IOS_BUNDLE_ID, 'data'],
    { encoding: 'utf8' },
  );
  return stdout.trim();
}

const CONTAINER = ['--domain-type', 'appDataContainer', '--domain-identifier', IOS_BUNDLE_ID];

/**
 * The names directly under `subdirectory` of the iPhone app's container, or
 * undefined when it does not exist (devicectl then fails to list it).
 */
async function deviceEntries(subdirectory: string): Promise<string[] | undefined> {
  let result: Record<string, unknown>;
  try {
    result = await devicectl('info', 'files', ...CONTAINER, '--subdirectory', subdirectory, '--no-recurse');
  } catch (error) {
    if (/failed to get a list of files/.test(String(error))) {
      return undefined;
    }
    throw error;
  }
  const files = (result.files ?? []) as Array<{ name?: string; relativePath?: string }>;
  return files.map(f => f.name ?? f.relativePath ?? '').filter(name => name !== '' && !name.includes('/'));
}

/**
 * Stops the iOS app; not running is fine. On an iPhone, by pid through
 * devicectl, and then asserted: a live process would write straight after a
 * clear, as Android's did.
 */
export async function terminateIosApp(): Promise<void> {
  if (!onDevice()) {
    await execFileAsync('xcrun', ['simctl', 'terminate', IOS_SIMULATOR_ID, IOS_BUNDLE_ID]).catch(
      () => {},
    );
    return;
  }
  for (const pid of await devicePidsOfApp()) {
    await devicectl('process', 'terminate', '--pid', String(pid)).catch(() => {});
  }
  const deadline = Date.now() + 15_000;
  let left = await devicePidsOfApp();
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    left = await devicePidsOfApp();
  }
  if (left.length > 0) {
    throw new Error(`terminateIosApp: BareExample still running on the iPhone (pids ${left.join(', ')})`);
  }
}

/**
 * The iOS counterpart of `clearAndroidBundles`, and as wide, for the same
 * reasons: stop the app first, then remove the SDK's whole data directory
 * (pending reports and crash state included), and assert it is gone. On an
 * iPhone that means the whole container (see the top of this file), and
 * the crash reporter's queue is asserted gone too: an earlier run's crash
 * still queued there would be recovered into this one.
 */
export async function clearIosBundles(): Promise<void> {
  await terminateIosApp();
  if (!onDevice()) {
    const data = join(await simulatorContainer(), IOS_SDK_DATA);
    rmSync(data, { recursive: true, force: true });
    if (existsSync(data)) {
      throw new Error(`clearIosBundles: ${data} is still there after removing it`);
    }
    return;
  }
  const empty = mkdtempSync(join(tmpdir(), 'bugsee-empty-'));
  try {
    // The destination only has to exist after the wipe: `tmp` always does.
    await devicectl('copy', 'to', ...CONTAINER, '--source', empty, '--destination', 'tmp', '--remove-existing-content', 'true');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const caches = await deviceEntries('Library/Caches');
  const left = (caches ?? []).filter(name => [IOS_SDK_DATA, IOS_CRASH_QUEUE].some(path => path.endsWith(`/${name}`)));
  if (left.length > 0) {
    throw new Error(`clearIosBundles: still on the iPhone after the wipe: Library/Caches/{${left.join(',')}}`);
  }
}

export async function listIosBundles(): Promise<string[]> {
  if (onDevice()) {
    return ((await deviceEntries(IOS_BUNDLES)) ?? []).filter(name => name.endsWith('.bundle.zip'));
  }
  const dir = join(await simulatorContainer(), IOS_BUNDLES);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter(name => name.endsWith('.bundle.zip'));
}

/** Copies (an iPhone: `devicectl copy from`), unzips and parses every retained bundle. */
export async function pullIosBundles(): Promise<PulledBundle[]> {
  const root = newPulledRoot();
  const bundles: PulledBundle[] = [];
  const container = onDevice() ? undefined : await simulatorContainer();
  for (const file of await listIosBundles()) {
    const zip = join(root, file);
    if (container === undefined) {
      await devicectl('copy', 'from', ...CONTAINER, '--source', `${IOS_BUNDLES}/${file}`, '--destination', zip);
    } else {
      copyFileSync(join(container, IOS_BUNDLES, file), zip);
    }
    const dir = join(root, file.replace(/\.bundle\.zip$/, ''));
    mkdirSync(dir);
    extractZip(readFileSync(zip), dir);
    bundles.push(parseBundle(file, dir));
  }
  return bundles;
}

/**
 * A minimal zip reader. The iOS SDK stores most entries with zstd (method
 * 93), which neither macOS's `unzip` nor its `bsdtar` can read; Node's zlib
 * can. Sizes come from the central directory, since entries are written with
 * data descriptors (flag bit 3) and zero sizes in their local headers.
 */
export function extractZip(zip: Buffer, dir: string): void {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) {
    end -= 1;
  }
  if (end < 0) {
    throw new Error('extractZip: no end-of-central-directory record');
  }
  const count = zip.readUInt16LE(end + 10);
  let entry = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(entry) !== 0x02014b50) {
      throw new Error(`extractZip: bad central directory entry ${i}`);
    }
    const method = zip.readUInt16LE(entry + 10);
    const packed = zip.readUInt32LE(entry + 20);
    const nameLength = zip.readUInt16LE(entry + 28);
    const extraLength = zip.readUInt16LE(entry + 30);
    const commentLength = zip.readUInt16LE(entry + 32);
    const local = zip.readUInt32LE(entry + 42);
    const name = zip.toString('utf8', entry + 46, entry + 46 + nameLength);
    entry += 46 + nameLength + extraLength + commentLength;

    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + packed);
    let bytes: Buffer;
    switch (method) {
      case 0:
        bytes = data;
        break;
      case 8:
        bytes = inflateRawSync(data);
        break;
      case 93:
        bytes = zstdDecompressSync(data);
        break;
      default:
        throw new Error(`extractZip: ${name} uses unsupported method ${method}`);
    }
    if (name.includes('..') || name.startsWith('/')) {
      throw new Error(`extractZip: refusing entry path ${name}`);
    }
    // A directory entry (`logs/`) is not a file to write; a nested entry
    // (`logs/log.json`) needs its directories first.
    if (name.endsWith('/')) {
      continue;
    }
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}
