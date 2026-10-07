/**
 * The device half of the e2e: launch the already-installed example app on a
 * real handset and watch its log for an ordered sequence of markers.
 *
 * Deliberately not Detox. What Task 1.5 has to prove is that the native
 * plumbing links, loads and launches on hardware — a question answered by the
 * device's own log, not by a JS-side view hierarchy. A driver that injected
 * itself into the app would be testing the driver.
 *
 * Both platforms stream the app's stdout/stderr:
 *   Android  `adb logcat`, where RN's console.log arrives tagged ReactNativeJS.
 *   iOS      `devicectl device process launch --console`, which attaches to
 *            the launched process's stdout/stderr — RN's default log function
 *            writes there as well as to os_log.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Platform = 'android' | 'ios';

// The hardware Phase 1 is verified against, overridable so the same test can
// be pointed at another handset without editing it.
export const ANDROID_SERIAL =
  process.env.ANDROID_SERIAL ?? 'AMRJCP4718402860'; // WOD_LX1

/**
 * The only iPhones the e2e may drive, by CoreDevice id. The iOS harness
 * terminates the app and wipes its whole data container (bundles.ts), so the
 * pin fails closed: `IOS_DEVICE_ID` can only choose among these, and widening
 * the list is a code change, never an environment variable. Each entry names
 * the model and UDID `devicectl list devices` must report for that id.
 */
export const IOS_DEVICE_ALLOWLIST: Readonly<
  Record<string, { readonly productType: string; readonly udid: string; readonly name: string }>
> = {
  '345BA7FE-2C29-5722-892A-BFCB1FD34D0C': {
    productType: 'iPhone11,2',
    udid: '00008020-000554DC2641002E',
    name: 'KRSFT, iPhone XS',
  },
};

/** A device the e2e must never touch, whatever the allowlist says. */
const IOS_DEVICE_REFUSED = /^D027034D/i; // the iPhone 16 Pro paired on this Mac

const DEFAULT_IOS_DEVICE_ID = '345BA7FE-2C29-5722-892A-BFCB1FD34D0C';

/**
 * The iPhone to drive: `raw` (IOS_DEVICE_ID) or the XS, and only if it is on
 * the allowlist. Throws otherwise.
 */
export function resolveIosDeviceId(raw: string | undefined): string {
  const id = (raw ?? DEFAULT_IOS_DEVICE_ID).trim().toUpperCase();
  if (IOS_DEVICE_REFUSED.test(id)) {
    throw new Error(`IOS_DEVICE_ID=${raw}: this device is refused outright; the e2e never touches it`);
  }
  if (!Object.prototype.hasOwnProperty.call(IOS_DEVICE_ALLOWLIST, id)) {
    throw new Error(
      `IOS_DEVICE_ID=${raw} is not on the e2e allowlist (${Object.keys(IOS_DEVICE_ALLOWLIST).join(', ')}); ` +
        'add it to IOS_DEVICE_ALLOWLIST in e2e/device.ts to drive it',
    );
  }
  return id;
}

export type IosTarget = 'simulator' | 'device';

/**
 * Which iOS target to drive: exactly `simulator` or `device`, stated. A
 * simulator is not a substitute for the handset -- it cannot catch a
 * code-signing or embedding fault, and its CPU is the host's -- but it is the
 * only iOS target CI has, and it does run the real SDK. Anything else,
 * including unset or a typo, throws: a misspelt `simulator` must not select
 * hardware.
 */
export function parseIosTarget(raw: string | undefined): IosTarget {
  if (raw === 'simulator' || raw === 'device') {
    return raw;
  }
  throw new Error(
    `E2E_IOS_TARGET must be "simulator" or "device", got ${JSON.stringify(raw)}`,
  );
}

/** The configured iOS target (`E2E_IOS_TARGET`), validated on every read. */
export function iosTarget(): IosTarget {
  return parseIosTarget(process.env.E2E_IOS_TARGET);
}

/** The configured iPhone (`IOS_DEVICE_ID`, allowlisted), validated on every read. */
export function iosDeviceId(): string {
  return resolveIosDeviceId(process.env.IOS_DEVICE_ID);
}

interface ListedDevice {
  readonly identifier?: string;
  readonly hardwareProperties?: { readonly productType?: string; readonly udid?: string };
}

/**
 * Asserts `devicectl list devices` (its `--json-output` result) shows `id`
 * as the allowlisted model and UDID. Throws otherwise.
 */
export function checkIosDeviceIdentity(result: { devices?: readonly ListedDevice[] }, id: string): void {
  const expected = IOS_DEVICE_ALLOWLIST[id];
  if (expected === undefined) {
    throw new Error(`device ${id} is not on the e2e allowlist`);
  }
  const found = (result.devices ?? []).filter(device => device.identifier?.toUpperCase() === id);
  if (found.length !== 1) {
    throw new Error(`devicectl list devices shows ${found.length} device(s) with id ${id}; expected the ${expected.name}`);
  }
  const actual = found[0]!.hardwareProperties ?? {};
  if (actual.productType !== expected.productType || actual.udid !== expected.udid) {
    throw new Error(
      `device ${id} is ${String(actual.productType)} (UDID ${String(actual.udid)}), ` +
        `not the allowlisted ${expected.productType} (UDID ${expected.udid})`,
    );
  }
}

let verified: Promise<string> | undefined;
let verifiedId: string | undefined;

/**
 * Checks, once per process and before any other devicectl command, that the
 * configured iPhone is really there and really the allowlisted model. Every
 * devicectl caller awaits this or `requireVerifiedIosDevice()`.
 */
export function verifyIosDevice(): Promise<string> {
  if (verified !== undefined) {
    return verified;
  }
  const check = (async () => {
    const id = iosDeviceId();
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-devicectl-list-'));
    const out = join(dir, 'devices.json');
    try {
      await execFileAsync('xcrun', ['devicectl', 'list', 'devices', '--quiet', '--json-output', out]);
      const parsed = JSON.parse(readFileSync(out, 'utf8')) as { result?: { devices?: ListedDevice[] } };
      checkIosDeviceIdentity(parsed.result ?? {}, id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    verifiedId = id;
    return id;
  })();
  verified = check;
  // A failed check is not cached, and is retried on the next call.
  check.catch(() => {
    if (verified === check) {
      verified = undefined;
    }
  });
  return check;
}

/**
 * The verified iPhone's id, for a caller that cannot await (a synchronous
 * spawn). Throws unless `verifyIosDevice()` has succeeded for the id now
 * configured.
 */
export function requireVerifiedIosDevice(): string {
  const id = iosDeviceId();
  if (verifiedId !== id) {
    throw new Error(`the iPhone ${id} has not been verified: await verifyIosDevice() before any devicectl command`);
  }
  return id;
}

/** Booted simulator to drive; `booted` is whichever one is already running. */
export const IOS_SIMULATOR_ID = process.env.IOS_SIMULATOR_ID ?? 'booted';

/**
 * The app under test (campaign N-01). examples/bare by default; a generated
 * app (another RN version, an Expo app, a packed-tarball install) is named
 * through the environment, so every suite runs against it unchanged:
 *
 *   E2E_APP_ID            Android application id      (com.bareexample)
 *   E2E_ANDROID_ACTIVITY  launch activity, `.X` or FQN (.MainActivity)
 *   E2E_IOS_BUNDLE_ID     iOS bundle id               (org.reactjs.native.example.BareExample)
 *   E2E_IOS_EXECUTABLE    iOS executable / NSLog name (BareExample)
 *   E2E_APP_DIR           the app's root on this Mac: where e2e-scenario.json
 *                         and credentials.json live, and whose node_modules
 *                         name the React Native version (examples/bare)
 *
 * Each is validated when this module loads: a typo fails the run at once
 * rather than as a launch of nothing.
 */
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const EXECUTABLE = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}$/;
const ACTIVITY = /^(\.|[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*\.)[A-Za-z_][A-Za-z0-9_$]*$/;

function checked(name: string, raw: string | undefined, fallback: string, rule: RegExp): string {
  if (raw === undefined) {
    return fallback;
  }
  if (!rule.test(raw)) {
    throw new Error(`${name} is not a valid value: ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function parseAndroidAppId(raw: string | undefined): string {
  return checked('E2E_APP_ID', raw, 'com.bareexample', APP_ID);
}

export function parseAndroidActivity(raw: string | undefined): string {
  return checked('E2E_ANDROID_ACTIVITY', raw, '.MainActivity', ACTIVITY);
}

export function parseIosBundleId(raw: string | undefined): string {
  return checked('E2E_IOS_BUNDLE_ID', raw, 'org.reactjs.native.example.BareExample', BUNDLE_ID);
}

export function parseIosExecutable(raw: string | undefined): string {
  return checked('E2E_IOS_EXECUTABLE', raw, 'BareExample', EXECUTABLE);
}

/** `E2E_APP_DIR`, absolute, or examples/bare. Must hold a package.json. */
export function parseAppDir(raw: string | undefined, fallback = join(__dirname, '..')): string {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const dir = resolvePath(raw);
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`E2E_APP_DIR=${raw}: no package.json at ${dir}`);
  }
  return dir;
}

export const ANDROID_PACKAGE = parseAndroidAppId(process.env.E2E_APP_ID);
export const ANDROID_ACTIVITY = parseAndroidActivity(process.env.E2E_ANDROID_ACTIVITY);
/** `<package>/<activity>`, as `am start -n` takes it. */
export const ANDROID_COMPONENT = `${ANDROID_PACKAGE}/${ANDROID_ACTIVITY}`;
export const IOS_BUNDLE_ID = parseIosBundleId(process.env.E2E_IOS_BUNDLE_ID);
export const IOS_EXECUTABLE = parseIosExecutable(process.env.E2E_IOS_EXECUTABLE);
export const APP_DIR = parseAppDir(process.env.E2E_APP_DIR);

/** `text` with every regex metacharacter escaped. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The `<executable>[<pid>:<tid>]` prefix of the app's NSLog lines; group 1 is the pid, 2 the tid. */
export const IOS_PID_TID = new RegExp(`${literal(IOS_EXECUTABLE)}\\[(\\d+):(\\d+)\\]`);

/** devicectl's executable path for the app: `.../<executable>.app/<executable>`. */
export const IOS_EXECUTABLE_PATH = new RegExp(`/${literal(IOS_EXECUTABLE)}\\.app/${literal(IOS_EXECUTABLE)}$`);

const ANDROID_HOME =
  process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
export const ADB = `${ANDROID_HOME}/platform-tools/adb`;

/** One thing to wait for, and how long to wait for it once its turn comes. */
export interface Step {
  readonly name: string;
  readonly pattern: RegExp;
  readonly timeoutMs: number;
}

export interface StepResult {
  readonly name: string;
  /** The matching line, or undefined if this step timed out or never ran. */
  readonly matched?: string;
  /** Milliseconds from the previous step matching (or from launch). */
  readonly elapsedMs?: number;
}

export interface SequenceResult {
  readonly steps: readonly StepResult[];
  /** Every captured line, so a failure can be read rather than guessed at. */
  readonly lines: readonly string[];
}

export function platformUnderTest(): Platform {
  const raw = process.env.E2E_PLATFORM;
  if (raw !== 'android' && raw !== 'ios') {
    throw new Error(
      `E2E_PLATFORM must be "android" or "ios", got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * How long a simulator console may stay completely silent before the launch
 * is abandoned. A live app prints before the bundle is fetched; a
 * `simctl launch --console-pty` that stays at zero bytes for this long has
 * not attached, and waiting out the step budget does not make it attach.
 */
const SIMULATOR_CONSOLE_SILENCE_MS = 20_000;

/**
 * Launches the app and matches `steps` against its log in order, each step
 * timed from the moment the one before it matched. Never rejects on a miss:
 * the caller asserts on the result, so the captured log is reportable.
 *
 * The per-step clock is the point. A single deadline from process start would
 * fold the debug bundle download into the SDK's launch time, and a cold Metro
 * would fail a test about Bugsee.
 */
export async function launchAndWaitForSequence(
  platform: Platform,
  steps: readonly Step[],
  androidUri?: string,
  iosArgs: readonly string[] = [],
): Promise<SequenceResult> {
  if (platform === 'android') {
    return collect(await spawnAndroid(androidUri), steps);
  }
  if (iosTarget() !== 'simulator') {
    return collect(await spawnIos(iosArgs), steps);
  }
  const first = await collect(await spawnIos(iosArgs), steps, SIMULATOR_CONSOLE_SILENCE_MS);
  if (first.sawOutput) {
    return first;
  }
  // The console attach is flaky on a freshly erased simulator: the process
  // stays up and writes nothing, so the app's own log never arrives. Kill
  // it and attach once more. A second silent console is a real failure.
  console.error(
    'simctl console produced no output; terminating the app and launching once more',
  );
  await run('xcrun', ['simctl', 'terminate', IOS_SIMULATOR_ID, IOS_BUNDLE_ID]);
  return collect(await spawnIos(iosArgs), steps);
}

/**
 * `uri`, when given, is the launch intent's data: the app's per-launch
 * scenario channel (scenario.ts), which a debug build reads without waiting
 * on Metro and a release build reads at all.
 */
async function spawnAndroid(uri?: string): Promise<ChildProcess> {
  await run(ADB, ['-s', ANDROID_SERIAL, 'logcat', '-c']);
  const logcat = spawn(ADB, [
    '-s',
    ANDROID_SERIAL,
    'logcat',
    '-v',
    'time',
    'ReactNativeJS:V',
    'Bugsee:V',
    'BugseeRN:V',
    '*:S',
  ]);
  // force-stop first: `am start` on an already-running app resumes it without
  // re-running JS, which would make a stale marker look like a pass.
  await run(ADB, [
    '-s',
    ANDROID_SERIAL,
    'shell',
    'am',
    'force-stop',
    ANDROID_PACKAGE,
  ]);
  await run(ADB, [
    '-s',
    ANDROID_SERIAL,
    'shell',
    'am',
    'start',
    '-n',
    ANDROID_COMPONENT,
    ...(uri === undefined ? [] : ['-a', 'android.intent.action.VIEW', '-d', `'${uri}'`]),
  ]);
  return logcat;
}

/**
 * `args` are the app's launch arguments (scenario.ts, `scenarioArgs`): the
 * iOS per-launch scenario channel.
 */
async function spawnIos(args: readonly string[]): Promise<ChildProcess> {
  if (iosTarget() === 'simulator') {
    // --console-pty, not --console: simctl only streams the app's stdout when
    // it allocates a pty, and RN's console.log goes to stdout. With --console
    // the process launches and the log never arrives, which reads exactly
    // like the SDK failing to start.
    return spawn('xcrun', [
      'simctl',
      'launch',
      '--console-pty',
      '--terminate-running-process',
      IOS_SIMULATOR_ID,
      IOS_BUNDLE_ID,
      ...args,
    ]);
  }
  // `--` ends devicectl's own options, so the app's `-bugseeE2e...`
  // arguments reach the app.
  const device = await verifyIosDevice();
  return spawn('xcrun', [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    device,
    '--console',
    '--terminate-existing',
    IOS_BUNDLE_ID,
    '--',
    ...args,
  ]);
}

interface CollectResult extends SequenceResult {
  /** False when the process exited, or the silence budget ran out, with no bytes. */
  readonly sawOutput: boolean;
}

function collect(
  child: ChildProcess,
  steps: readonly Step[],
  silenceMs?: number,
): Promise<CollectResult> {
  return new Promise(resolve => {
    const lines: string[] = [];
    const results: StepResult[] = [];
    // stdout and stderr are separate pipes. One shared buffer splices a
    // line from one into a partial line from the other, and the marker the
    // test is waiting on is no longer a contiguous string.
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let index = 0;
    let since = Date.now();
    let settled = false;
    let sawOutput = false;
    let timer: NodeJS.Timeout;
    let silenceTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(silenceTimer);
      child.kill('SIGKILL');
      for (let i = index; i < steps.length; i += 1) {
        results.push({ name: steps[i]!.name });
      }
      resolve({ steps: results, lines, sawOutput });
    };

    const arm = () => {
      clearTimeout(timer);
      const step = steps[index];
      if (step === undefined) {
        finish();
        return;
      }
      timer = setTimeout(finish, step.timeoutMs);
    };

    const take = (buffer: string, chunk: Buffer): string => {
      if (settled) {
        return buffer;
      }
      if (chunk.length > 0) {
        sawOutput = true;
        clearTimeout(silenceTimer);
      }
      const parts = (buffer + chunk.toString('utf8')).split('\n');
      const rest = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        const step = steps[index];
        if (step !== undefined && step.pattern.test(line)) {
          const now = Date.now();
          results.push({ name: step.name, matched: line, elapsedMs: now - since });
          since = now;
          index += 1;
          if (index === steps.length) {
            finish();
            return rest;
          }
          arm();
        }
      }
      return rest;
    };

    arm();
    if (silenceMs !== undefined) {
      silenceTimer = setTimeout(() => {
        if (!sawOutput) {
          finish();
        }
      }, silenceMs);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer = take(stdoutBuffer, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer = take(stderrBuffer, chunk);
    });
    child.on('error', error => {
      lines.push(`spawn error: ${String(error)}`);
      finish();
    });
    child.on('close', finish);
  });
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
}
