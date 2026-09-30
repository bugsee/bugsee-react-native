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
): Promise<SequenceResult> {
  if (platform === 'android') {
    return collect(await spawnAndroid(androidUri), steps);
  }
  if (IOS_TARGET !== 'simulator') {
    return collect(spawnIos(), steps);
  }
  const first = await collect(spawnIos(), steps, SIMULATOR_CONSOLE_SILENCE_MS);
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
  return collect(spawnIos(), steps);
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
    `${ANDROID_PACKAGE}/.MainActivity`,
    ...(uri === undefined ? [] : ['-a', 'android.intent.action.VIEW', '-d', `'${uri}'`]),
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
