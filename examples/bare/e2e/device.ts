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
import { type ChildProcess, spawn } from 'node:child_process';

export type Platform = 'android' | 'ios';

// The hardware Phase 1 is verified against, overridable so the same test can
// be pointed at another handset without editing it.
export const ANDROID_SERIAL =
  process.env.ANDROID_SERIAL ?? 'AMRJCP4718402860'; // WOD_LX1
export const IOS_DEVICE_ID =
  process.env.IOS_DEVICE_ID ?? '345BA7FE-2C29-5722-892A-BFCB1FD34D0C'; // KRSFT, iPhone XS

/**
 * Which iOS target to drive. A simulator is not a substitute for the handset
 * -- it cannot catch a code-signing or embedding fault, and its CPU is the
 * host's -- but it is the only iOS target CI has, and it does run the real
 * SDK. Without it every CI job proves the framework is *present* and none
 * proves it *runs*: gutting `launch` to `resolve(@YES)` keeps them all green.
 */
export const IOS_TARGET =
  process.env.E2E_IOS_TARGET === 'simulator' ? 'simulator' : 'device';

/** Booted simulator to drive; `booted` is whichever one is already running. */
export const IOS_SIMULATOR_ID = process.env.IOS_SIMULATOR_ID ?? 'booted';
export const ANDROID_PACKAGE = 'com.bareexample';
export const IOS_BUNDLE_ID = 'org.reactjs.native.example.BareExample';

const ANDROID_HOME =
  process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
const ADB = `${ANDROID_HOME}/platform-tools/adb`;

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
): Promise<SequenceResult> {
  const child =
    platform === 'android' ? await spawnAndroid() : spawnIos();
  return collect(child, steps);
}

async function spawnAndroid(): Promise<ChildProcess> {
  await run(ADB, ['-s', ANDROID_SERIAL, 'logcat', '-c']);
  const logcat = spawn(ADB, [
    '-s',
    ANDROID_SERIAL,
    'logcat',
    '-v',
    'time',
    'ReactNativeJS:V',
    'Bugsee:V',
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
    `${ANDROID_PACKAGE}/.MainActivity`,
  ]);
  return logcat;
}

function spawnIos(): ChildProcess {
  if (IOS_TARGET === 'simulator') {
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
    ]);
  }
  return spawn('xcrun', [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    IOS_DEVICE_ID,
    '--console',
    '--terminate-existing',
    IOS_BUNDLE_ID,
  ]);
}

function collect(
  child: ChildProcess,
  steps: readonly Step[],
): Promise<SequenceResult> {
  return new Promise(resolve => {
    const lines: string[] = [];
    const results: StepResult[] = [];
    let buffer = '';
    let index = 0;
    let since = Date.now();
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      for (let i = index; i < steps.length; i += 1) {
        results.push({ name: steps[i]!.name });
      }
      resolve({ steps: results, lines });
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

    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
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
            return;
          }
          arm();
        }
      }
    };

    arm();
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
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
