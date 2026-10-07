/**
 * Campaign N-10: the app's life around the SDK, on every target (A, S, X).
 *
 *   [FLOW-31] cold start x5: the process is dead before each launch, the SDK
 *             reaches Launched within 10 s of the JS bundle running every time,
 *             once (one Launching, one Launched, one native start); p50/p95
 *             recorded (BLK-35: the XS figure is the one the plan asks for).
 *   [FLOW-40] no permission prompt at the first launch: Android after
 *             `pm clear` (runtime grants reset) the app's own activity is in
 *             front, and the dangerous permissions the package declares are
 *             recorded; iOS (simulator privacy reset; the iPhone after the
 *             container wipe) the screen OCR shows the app and no system alert.
 *   [FLOW-32] background then foreground, twice: the SDK stays Launched, the
 *             JS and the SDK are not started again, the lines logged after each
 *             resume land in the report, and the video goes on after the gap
 *             (the stage turns white only after the last resume, so the video
 *             must end bright having started on the dark app).
 *   [FLOW-33] five minutes in the background, then foreground: the same.
 *             `E2E_LONG_BACKGROUND_MS` may change the wait; the test title
 *             states the wait actually used.
 *   [FLOW-34] JS reload (`DevSettings.reload()`, Debug only): the second
 *             runtime's console line is captured once, through its own log
 *             filter only; its report handler labels its report and the first
 *             one's does not; the first runtime's secure rectangle no longer
 *             masks anything (the first report's screenshot, taken while it
 *             was set, is the control: masked there).
 *   [FLOW-22] a vh data request while the JS thread is busy completes
 *             `by=deadline` within its budget; one made with JS free
 *             completes `by=js` (control).
 *   [DES-16]  a live report handler holding a report for 3 s does not block
 *             the main thread: a ping to main (`blockMain(0)`, every 50 ms)
 *             never takes 500 ms, where a blockMain(1500) control shows a
 *             ping >= 1000 ms. (A JS interval is no witness: iOS runs JS
 *             timers off main, seen on the XS: 68 ms gap during a 1.5 s block.)
 *
 * Retention as every retaining suite: airplane mode on Android, the dead
 * endpoint on iOS (observe.ts `beginRetainingSuite`).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type PulledBundle, captureEvents } from './bundles';
import { ANDROID_COMPONENT, ANDROID_PACKAGE, IOS_BUNDLE_ID, IOS_SIMULATOR_ID, iosTarget, verifyIosDevice } from './device';
import { parseLongBackgroundMs, percentile } from './flow-config';
import { androidDangerousPermissions, androidRequestedPermissions } from './install';
import {
  ON_ANDROID,
  ON_IOS,
  type Run,
  TARGET_NAME,
  awaitBundles,
  bridgeLine,
  clearBundles,
  debugOnly,
  describeDevice,
  escape,
  must,
  report,
  startRun,
  stopApp,
} from './harness';
import { LUMA_BRIGHT_MIN, LUMA_DARK_MAX, frameLumas, imageSize, regionLuma } from './media';
import { androidTopActivity, beginRetainingSuite, captureScreen, endRetainingSuite, ocrLines } from './observe';
import { bundleBySummary } from './screen';
import { type DeviceLog, type LogLine, adb, devicePidsOfApp, pidOf } from './scenario';

const execFileAsync = promisify(execFile);

jest.setTimeout(20 * 60_000);

const ON_IPHONE = ON_IOS && iosTarget() === 'device';
const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';

/** API-01a / plan 4.1: the one timing that is a pass rule. */
const LAUNCHED_BUDGET_MS = 10_000;
const COLD_STARTS = 5;
const SHORT_BACKGROUND_MS = 5_000;

/** `E2E_LONG_BACKGROUND_MS`, default five minutes (FLOW-33). */
const LONG_BACKGROUND_MS = parseLongBackgroundMs(process.env.E2E_LONG_BACKGROUND_MS);

const SETTINGS_BUNDLE = 'com.apple.Preferences';

/** The time a line was written: the device's clock when it carries one, else when this host got it. */
function lineMs(line: LogLine): number {
  return Number.isFinite(line.deviceMs) ? line.deviceMs : line.hostMs ?? Number.NaN;
}

/** Sends the app to the background: Home on Android, Settings in front on iOS. */
async function background(): Promise<void> {
  if (ON_ANDROID) {
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  } else if (ON_SIMULATOR) {
    await execFileAsync('xcrun', ['simctl', 'launch', IOS_SIMULATOR_ID, SETTINGS_BUNDLE]);
  } else {
    await iphoneLaunch(SETTINGS_BUNDLE);
  }
}

/**
 * `devicectl device process launch --device <the XS> <bundle>`: without
 * `--terminate-existing`, a running app is brought to the front, not started
 * again. (scenario.ts `devicectl` puts `--device` last, which `process
 * launch` refuses before its positional bundle id.)
 */
async function iphoneLaunch(bundle: string): Promise<void> {
  const device = await verifyIosDevice();
  await execFileAsync('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device, bundle]);
}

/** Brings the running app back to the front without starting it again. */
async function foreground(): Promise<void> {
  if (ON_ANDROID) {
    // No data URI and no force-stop: the existing task comes to the front.
    await adb('shell', 'am', 'start', '-n', ANDROID_COMPONENT);
  } else if (ON_SIMULATOR) {
    await execFileAsync('xcrun', ['simctl', 'launch', IOS_SIMULATOR_ID, IOS_BUNDLE_ID]);
  } else {
    await iphoneLaunch(IOS_BUNDLE_ID);
  }
}

/** The pids of the app under test now (empty when it is not running). */
async function appPids(): Promise<number[]> {
  if (ON_ANDROID) {
    const pid = await pidOf();
    return pid === undefined ? [] : pid.split(/\s+/).map(Number);
  }
  if (ON_IPHONE) {
    return devicePidsOfApp();
  }
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'spawn', IOS_SIMULATOR_ID, 'launchctl', 'list']).catch(
    () => ({ stdout: '' }),
  );
  return stdout
    .split('\n')
    .filter(line => line.includes(`UIKitApplication:${IOS_BUNDLE_ID}`))
    .map(line => Number(line.trim().split(/\s+/)[0]))
    .filter(pid => Number.isInteger(pid) && pid > 0);
}

/** The SDK's own start line, once per native launch. */
const NATIVE_START = ON_IOS ? /Bugsee IOS SDK ver:/ : /Bugsee Android SDK \S+ \[[0-9a-f]+\]/;

function countFrom(log: DeviceLog, pattern: RegExp, from: number): number {
  return log.all(pattern, from).length;
}

function logMessages(bundle: PulledBundle): string[] {
  return captureEvents(bundle, 'log').map(event => (typeof event.message === 'string' ? event.message : ''));
}

describeDevice(`app state around the SDK on ${TARGET_NAME} (N-10)`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-10');
  });

  afterAll(() => endRetainingSuite(log));

  it(`[N-10][FLOW-31][BLK-35] cold start x${COLD_STARTS}: the process is dead before each launch and Launched comes within ${LAUNCHED_BUDGET_MS / 1000} s of the JS bundle, once`, async () => {
    const jsToLaunched: number[] = [];
    const commandToLaunched: number[] = [];
    for (let i = 1; i <= COLD_STARTS; i += 1) {
      await stopApp();
      await clearBundles();
      expect(await appPids()).toEqual([]);
      const issued = Date.now();
      const run = await startRun('flow-cold');
      const nonce = run.scenario.nonce;
      const js = must(
        await log!.waitFor(new RegExp(`BUGSEE_E2E scenario=flow-cold nonce=${nonce} `), 1_000, run.start),
        'the scenario line',
        run.start,
      );
      must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow cold launched nonce=${nonce}`), 15_000, run.start), 'the cold marker', run.start);
      const ms = lineMs(run.launched) - lineMs(js);
      jsToLaunched.push(ms);
      commandToLaunched.push((run.launched.hostMs ?? Date.now()) - issued);
      const counts = {
        launching: countFrom(log!, new RegExp(`BUGSEE_E2E flow event name=Launching id=- nonce=${nonce}`), run.start),
        launched: countFrom(log!, new RegExp(`BUGSEE_E2E flow event name=Launched id=- nonce=${nonce}`), run.start),
        nativeStarts: countFrom(log!, NATIVE_START, run.start),
        jsStarts: countFrom(log!, new RegExp(`BUGSEE_E2E scenario=flow-cold nonce=${nonce} `), run.start),
      };
      report(`cold start ${i}`, { nonce, jsToLaunchedMs: ms, commandToLaunchedMs: commandToLaunched.at(-1), ...counts });
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeLessThan(LAUNCHED_BUDGET_MS);
      expect(counts).toEqual({ launching: 1, launched: 1, nativeStarts: 1, jsStarts: 1 });
    }
    report('cold start timings (INFO)', {
      jsToLaunched: { p50: percentile(jsToLaunched, 50), p95: percentile(jsToLaunched, 95), all: jsToLaunched },
      commandToLaunched: { p50: percentile(commandToLaunched, 50), p95: percentile(commandToLaunched, 95), all: commandToLaunched },
    });
  });

  it('[N-10][FLOW-40] the first launch shows no permission prompt', async () => {
    await stopApp();
    await clearBundles();
    if (ON_ANDROID) {
      // First-launch state: data and runtime grants reset.
      await adb('shell', 'pm', 'clear', ANDROID_PACKAGE);
      const requested = await androidRequestedPermissions();
      report('declared permissions', requested);
      report('declared dangerous (runtime) permissions', await androidDangerousPermissions(requested));
    } else if (ON_SIMULATOR) {
      await execFileAsync('xcrun', ['simctl', 'privacy', IOS_SIMULATOR_ID, 'reset', 'all', IOS_BUNDLE_ID]);
    }
    const run = await startRun('flow-cold');
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow cold launched nonce=${run.scenario.nonce}`), 15_000, run.start), 'the cold marker', run.start);
    // A prompt the SDK asked for would be up by now.
    await new Promise(resolve => setTimeout(resolve, 4_000));
    if (ON_ANDROID) {
      const top = await androidTopActivity();
      report('top activity', top);
      expect(top).toBe(`${ANDROID_PACKAGE}/${ANDROID_COMPONENT.split('/')[1]}`);
    } else {
      const lines = await ocrLines(await captureScreen('flow-first-launch'));
      report('screen text', lines);
      // The app itself is on screen, so the OCR saw it.
      expect(lines.some(line => /Bugsee React Native/.test(line))).toBe(true);
      expect(lines.filter(line => /Would Like to|Don.t Allow|^Allow\b|Allow While Using|Not Now/i.test(line))).toEqual([]);
    }
  });

  async function backgroundRounds(run: Run, rounds: number, awayMs: number): Promise<number[]> {
    const nonce = run.scenario.nonce;
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow resume ready resumes=${rounds} nonce=${nonce}`), 15_000, run.start), 'the resume scenario ready', run.start);
    const pidsBefore = await appPids();
    const pidsAfter: number[] = [];
    for (let k = 1; k <= rounds; k += 1) {
      const from = log!.mark();
      await background();
      must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow background k=${k} nonce=${nonce}`), 15_000, from), `the app going to the background (${k})`, run.start);
      await new Promise(resolve => setTimeout(resolve, awayMs));
      await foreground();
      must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow resumed k=${k} status=\\d+ nonce=${nonce}`), 30_000, from), `the app resuming (${k})`, run.start);
      pidsAfter.push(...(await appPids()));
    }
    report('pids', { before: pidsBefore, after: pidsAfter });
    expect(pidsBefore).toHaveLength(1);
    expect(new Set(pidsAfter)).toEqual(new Set(pidsBefore));
    return pidsBefore;
  }

  async function assertResumed(run: Run, rounds: number, label: string): Promise<void> {
    const nonce = run.scenario.nonce;
    const summary = `${label}-${nonce}`;
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow uploaded summary=${escape(summary)} nonce=${nonce}`), 30_000, run.start), 'the upload after the last resume', run.start);
    const statuses = log!
      .all(new RegExp(`BUGSEE_E2E flow resumed k=\\d+ status=(\\d+) nonce=${nonce}`), run.start)
      .map(line => Number(/status=(\d+)/.exec(line.text)![1]));
    const counts = {
      launching: countFrom(log!, new RegExp(`BUGSEE_E2E flow event name=Launching id=- nonce=${nonce}`), run.start),
      nativeStarts: countFrom(log!, NATIVE_START, run.start),
      jsStarts: countFrom(log!, new RegExp(`BUGSEE_E2E scenario=${run.scenario.scenario} nonce=${nonce} `), run.start),
    };
    report(`${label} after resume`, { statuses, ...counts });
    expect(statuses).toEqual(Array.from({ length: rounds }, () => 2));
    expect(counts).toEqual({ launching: 1, nativeStarts: 1, jsStarts: 1 });

    const bundle = bundleBySummary(await awaitBundles(1, 90_000), summary);
    const messages = logMessages(bundle);
    const wanted = [`pre-${label}-${nonce}`, ...Array.from({ length: rounds }, (_, i) => `resume-${i + 1}-${nonce}`), `post-resume-${nonce}`];
    report(`${label} log lines`, wanted.map(text => ({ text, found: messages.filter(m => m.includes(text)).length })));
    for (const text of wanted) {
      expect(messages.filter(message => message.includes(text))).toHaveLength(1);
    }
    const videos = bundle.binaries.get('video') ?? [];
    expect(videos).toHaveLength(1);
    const lumas = await frameLumas(videos[0]!);
    const last = lumas[lumas.length - 1]!;
    const firstBright = lumas.findIndex(frame => frame.luma >= LUMA_BRIGHT_MIN);
    report(`${label} video`, { frames: lumas.length, first: lumas[0], last, firstBright: lumas[firstBright] });
    // Capture went on after the gap: the white stage, painted only after the
    // last resume, is in the video, after frames of the dark app.
    expect(last.luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    expect(lumas.slice(0, Math.max(firstBright, 0)).some(frame => frame.luma <= LUMA_DARK_MAX)).toBe(true);
  }

  it(`[N-10][FLOW-32] background then foreground twice (${SHORT_BACKGROUND_MS / 1000} s away): still Launched, not started again, logs after resume land, video continues`, async () => {
    await clearBundles();
    const run = await startRun('flow-resume');
    await backgroundRounds(run, 2, SHORT_BACKGROUND_MS);
    await assertResumed(run, 2, 'flow-resume');
  });

  it('[N-10][FLOW-22] a vh request while the JS thread is busy completes by=deadline; with JS free, by=js', async () => {
    await clearBundles();
    const run = await startRun('flow-vh-deadline');
    const nonce = run.scenario.nonce;
    const start = must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow vh blocking start nonce=${nonce}`), 20_000, run.start), 'the busy loop starting', run.start);
    const end = must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow vh blocking end spins=\\d+ nonce=${nonce}`), 20_000, start.index), 'the busy loop ending', run.start);
    const free = must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow vh free capture nonce=${nonce}`), 20_000, end.index), 'the free capture', run.start);
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow vh uploaded nonce=${nonce}`), 20_000, free.index), 'the upload', run.start);
    const busyRequest = must(await log!.waitFor(bridgeLine('data request (dr-\\d+) type=vh '), 5_000, start.index), 'the vh request made while JS was busy', run.start);
    const busyId = /data request (dr-\d+) /.exec(busyRequest.text)![1]!;
    const busyDone = must(await log!.waitFor(bridgeLine(`data request ${busyId} completed `), 10_000, busyRequest.index), `${busyId} completing`, run.start);
    const freeRequest = must(await log!.waitFor(bridgeLine('data request (dr-\\d+) type=vh '), 10_000, free.index), 'the vh request made with JS free', run.start);
    const freeId = /data request (dr-\d+) /.exec(freeRequest.text)![1]!;
    const freeDone = must(await log!.waitFor(bridgeLine(`data request ${freeId} completed `), 10_000, freeRequest.index), `${freeId} completing`, run.start);
    report('vh outcomes', { busy: busyDone.text.trim(), free: freeDone.text.trim() });
    expect(busyRequest.index).toBeLessThan(end.index);
    expect(busyDone.text).toMatch(/completed by=deadline bytes=null ms=\d+/);
    const ms = Number(/ ms=(\d+)/.exec(busyDone.text)![1]);
    expect(ms).toBeGreaterThanOrEqual(400);
    expect(ms).toBeLessThan(1_500);
    expect(freeDone.text).toMatch(/completed by=js bytes=\d+ ms=\d+/);
  });

  it('[N-10][DES-16] the main thread stays responsive while a live report handler holds the report', async () => {
    await clearBundles();
    const run = await startRun('flow-main-responsive');
    const nonce = run.scenario.nonce;
    const control = must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow main control maxPing=(\\d+) pings=\\d+ nonce=${nonce}`), 30_000, run.start), 'the blockMain control', run.start);
    const window = must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow main handler window ms=\\d+ maxPing=(\\d+) pings=(\\d+) nonce=${nonce}`), 60_000, control.index), 'the handler window', run.start);
    const blockedPing = Number(/maxPing=(\d+)/.exec(control.text)![1]);
    const heldPing = Number(/maxPing=(\d+)/.exec(window.text)![1]);
    const heldPings = Number(/pings=(\d+)/.exec(window.text)![1]);
    report('main thread witness', { blockedPing, heldPing, heldPings });
    // The witness can see a blocked main thread...
    expect(blockedPing).toBeGreaterThanOrEqual(1_000);
    // ...and saw none while the handler held the report.
    expect(heldPing).toBeLessThan(500);
    expect(heldPings).toBeGreaterThanOrEqual(20);
    const bundle = bundleBySummary(await awaitBundles(1, 60_000), `flow-main-${nonce}`);
    expect(bundle.request.labels).toEqual(expect.arrayContaining([`held-${nonce}`]));
  });

  const itReload = debugOnly(it, 'DevSettings.reload() reloads only a Debug (Metro) build');

  itReload('[N-10][FLOW-34] JS reload: one console capture through the new filter, the new handler only, no stale secure rectangle', async () => {
    await clearBundles();
    const run = await startRun('flow-reload');
    const nonce = run.scenario.nonce;
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow reload generation=1 nonce=${nonce}`), 20_000, run.start), 'generation 1', run.start);
    const reloading = must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow reload reloading nonce=${nonce}`), 30_000, run.start), 'the reload', run.start);
    const gen2 = must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow reload generation=2 nonce=${nonce}`), 90_000, reloading.index), 'generation 2 after the reload', run.start);
    must(await log!.waitFor(/BUGSEE_E2E status=2/, 20_000, reloading.index), 'Launched after the reload', run.start);
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow reload uploaded gen=2 nonce=${nonce}`), 30_000, gen2.index), 'the second upload', run.start);
    const bundles = await awaitBundles(2, 90_000);
    const g1 = bundleBySummary(bundles, `flow-reload-g1-${nonce}`);
    const g2 = bundleBySummary(bundles, `flow-reload-g2-${nonce}`);

    const nativeStarts = countFrom(log!, NATIVE_START, run.start);
    const g1Lines = logMessages(g1).filter(message => message.includes(`rl-gen1-${nonce}`));
    const g2Lines = logMessages(g2).filter(message => message.includes(`rl-gen2-${nonce}`));
    report('reload', { nativeStarts, g1Lines, g2Lines, g1Labels: g1.request.labels, g2Labels: g2.request.labels });
    // Recorded only: whether a second launch() after a reload restarts the
    // native session is API-01d's question (N-03), not this flow's.
    // Control: generation 1's filter rewrote its own line.
    expect(g1Lines).toEqual([`g1:rl-gen1-${nonce}`]);
    // One capture, through the new filter alone.
    expect(g2Lines).toEqual([`g2:rl-gen2-${nonce}`]);
    expect(g1.request.labels).toEqual(expect.arrayContaining([`g1-${nonce}`]));
    expect(g2.request.labels).toEqual(expect.arrayContaining([`g2-${nonce}`]));
    expect(g2.request.labels).not.toEqual(expect.arrayContaining([`g1-${nonce}`]));

    // The first runtime's rectangle: masked in its own report, gone after.
    const lumaOf = async (bundle: PulledBundle): Promise<number> => {
      const shots = bundle.binaries.get('screenshot') ?? [];
      expect(shots.length).toBeGreaterThan(0);
      const size = await imageSize(shots[0]!);
      // The inner half of the masked rectangle (RELOAD_SECURE_FRACTION in
      // scenarios/flows.tsx: x 0.1-0.5, y 0.3-0.55 of the window), so the
      // window-vs-display offset cannot move it off the mask.
      return regionLuma(shots[0]!, {
        x: Math.round(size.width * 0.2),
        y: Math.round(size.height * 0.36),
        w: Math.round(size.width * 0.2),
        h: Math.round(size.height * 0.12),
      });
    };
    const g1Luma = await lumaOf(g1);
    const g2Luma = await lumaOf(g2);
    report('secure region luma', { g1: g1Luma, g2: g2Luma });
    expect(g1Luma).toBeLessThanOrEqual(LUMA_DARK_MAX);
    expect(g2Luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
  });

  it(`[N-10][FLOW-33] ${Math.round(LONG_BACKGROUND_MS / 1000)} s in the background, then foreground: still Launched, not started again, logs land, video continues`, async () => {
    await clearBundles();
    const run = await startRun('flow-long');
    await backgroundRounds(run, 1, LONG_BACKGROUND_MS);
    await assertResumed(run, 1, 'flow-long');
  });
});
