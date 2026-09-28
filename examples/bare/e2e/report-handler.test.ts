/**
 * Tasks 3.4d and 3.4f: the report handler on an Android handset
 * (`E2E_PLATFORM=android`) and on iOS (`E2E_PLATFORM=ios`, simulator only:
 * `E2E_IOS_TARGET=simulator`).
 *
 * Unit tests pin the bridge's logic against fakes; what only a device can
 * show is that the SDK really calls it on the thread we think, that JS edits
 * really land in the bundle the SDK writes, and that the deadlines hold
 * against the SDK's own caps. Each run asserts its experiment before its
 * result (workbook 9.1): the SDK build that launched, that the bundle
 * directory really was emptied, that the device really was offline, that the
 * SDK really reached Launched, and -- for the crash -- that the process really
 * died of it.
 *
 * Android preconditions, as for launch.test.ts: the app is installed on the
 * handset named in device.ts, and for a debug build Metro is running with
 * `adb reverse tcp:8081 tcp:8081`. Cases 1-5 run on a debug build. Case 6
 * needs a build without dev support -- a debug build routes the exception to
 * DevSupportManager (a red box) and the process lives: `./gradlew
 * :app:assembleRelease -PbugseeE2eDebuggable=true` (the flag keeps `run-as`
 * working), and `-t terminating` to run just that case. All six pass on that
 * build too. `E2E_LOGCAT_DUMP=<file>` saves the whole captured log.
 *
 * iOS preconditions: the Debug app is installed on the booted simulator
 * (IOS_SIMULATOR_ID) and Metro is running. Reports are retained by launching
 * against a closed loopback port (bundles.ts, DEAD_ENDPOINT), since the
 * simulator has no airplane mode. iOS prints no commit banner; the SDK's
 * `Bugsee IOS SDK ver:<v> build:<b>` line and every bundle's
 * `environment.sdk.version` are checked against the pin instead.
 *
 * Log lines matched, from the report handler bridge (ReportHandlerBridge on
 * Android, tag BugseeRN; BGSRNReportHandlerBridge's NSLog on iOS, prefixed
 * `BugseeRN`):
 *   report handler <handle> phase=<p> deadline=<ms>       a dispatch to JS
 *   report handler <handle> completed by=<by>              that handle's end
 *   report handler - completed by=<by> phase=<p> report=<id>   never reached JS
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type PulledBundle,
  airplane,
  removePulledBundles,
  displayNameOf,
  fileNameOf,
  terminateIosApp,
} from './bundles';
import { ANDROID_PACKAGE, IOS_SIMULATOR_ID } from './device';
import {
  ON_ANDROID,
  ON_IOS,
  type Run,
  awaitBundles,
  clearBundles,
  describeDevice,
  escape,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import {
  type DeviceLog,
  type LogLine,
  Logcat,
  SimulatorConsole,
  adb,
  hostProcessAlive,
  pidOf,
  resetScenario,
} from './scenario';

const itAndroid = ON_ANDROID ? it : it.skip;
/**
 * Case 6 on iOS needs a crash reporter, and the simulator slice of the iOS SDK
 * has none: 7.0.0-beta3's `ios-arm64_x86_64-simulator` binary carries no
 * BGSCrashManager or PLCrashReporter symbols (the SDK compiles crash hooks
 * out under TARGET_OS_SIMULATOR), so a crash there is never recovered and the
 * case fails at its first recovery assertion (Task 3.4f report). It runs only
 * when asked for, `E2E_IOS_RECOVERY=1`, until an iPhone is attached.
 */
const itIosRecovery = ON_IOS && process.env.E2E_IOS_RECOVERY === '1' ? it : it.skip;

jest.setTimeout(10 * 60_000);

let log: DeviceLog;

/**
 * iOS: the thread an `NSLog` line came from, `BareExample[<pid>:<tid>]`. The
 * SDK logs its version line from `launchWithToken:` on the main thread, so
 * that line's tid is main's -- the witness for which thread a dispatch was on.
 */
function threadOf(line: LogLine): string | undefined {
  return /BareExample\[\d+:(\d+)\]/.exec(line.text)?.[1];
}

const DISPATCH = (phase: string) =>
  new RegExp(`BugseeRN.*report handler (rh-\\d+) phase=(${phase}) deadline=(\\d+)`);

/** Any handle's completion -- minted handles log `<id> completed by=`. */
function completionOf(handle: string): RegExp {
  return new RegExp(`report handler ${escape(handle)} completed by=(\\S+)`);
}

interface Dispatch {
  readonly handle: string;
  readonly phase: string;
  readonly deadlineMs: number;
  readonly dispatched: LogLine;
  readonly completed: LogLine;
  readonly by: string;
  readonly elapsedMs: number;
}

/** `phase` is a pattern: `before`, `after`, or `before|after`. */
async function awaitDispatch(
  phase: string,
  from: number,
  completionTimeoutMs: number,
): Promise<Dispatch> {
  const dispatched = must(
    await log.waitFor(DISPATCH(phase), 30_000, from),
    `a ${phase} dispatch to JS`,
    from,
  );
  const [, handle, actualPhase, deadline] = DISPATCH(phase).exec(dispatched.text)!;
  const completed = must(
    await log.waitFor(completionOf(handle!), completionTimeoutMs, dispatched.index),
    `${handle}'s completion`,
    from,
  );
  return {
    handle: handle!,
    phase: actualPhase!,
    deadlineMs: Number(deadline),
    dispatched,
    completed,
    by: completionOf(handle!).exec(completed.text)![1]!,
    elapsedMs: completed.deviceMs - dispatched.deviceMs,
  };
}

/** The request.json fields the cases assert on, without the environment dump. */
function pick(request: Record<string, unknown>): Record<string, unknown> {
  const { type, summary, description, severity, labels, source, created_on } = request;
  return { type, summary, description, severity, labels, source, created_on };
}

/**
 * The simulator's own crash report for `pid`, which macOS writes to the
 * host's DiagnosticReports: the process-death evidence on iOS, with the
 * signal that ended it.
 */
async function awaitHostCrashReport(
  pid: number,
  timeoutMs = 60_000,
): Promise<{ file: string; type: string; signal: string }> {
  const dir = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const file of readdirSync(dir).filter(name => /^BareExample.*\.ips$/.test(name))) {
      const text = readFileSync(join(dir, file), 'utf8');
      const body = text.slice(text.indexOf('\n') + 1);
      try {
        const parsed = JSON.parse(body) as { pid?: number; exception?: { type?: string; signal?: string } };
        if (parsed.pid === pid) {
          return { file, type: parsed.exception?.type ?? '?', signal: parsed.exception?.signal ?? '?' };
        }
      } catch {
        // Still being written, or not ours.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no DiagnosticReports crash report for pid ${pid} within ${timeoutMs} ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

describeDevice(`report handler on ${ON_IOS ? `the iOS simulator (${IOS_SIMULATOR_ID})` : 'an Android handset'}`, () => {
  beforeAll(async () => {
    if (ON_IOS) {
      // No network switch to throw: every iOS launch carries DEAD_ENDPOINT
      // (startIosRun), which is what retains its reports.
      log = SimulatorConsole.start();
      useLog(log, '3.4f');
      return;
    }
    log = await Logcat.start();
    useLog(log, '3.4d');
    // 9.3.2: offline before the app starts, and for the whole file, so every
    // report is retained where the test can read it.
    await airplane(true);
  });

  afterAll(async () => {
    // Always, and in this order: stop the app, drop what it retained (so a
    // later launch online does not upload test reports), then bring the
    // network back -- the handset is shared, and a test that leaves it
    // offline breaks the next thing anyone does with it.
    try {
      if (ON_IOS) {
        await terminateIosApp();
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
      await clearBundles().catch(() => {});
    } finally {
      // airplane(false) can throw (it shells out to adb/simctl); the bundle
      // cleanup and log stop below must run regardless, so they get their
      // own finally rather than sitting after it in the same block.
      try {
        if (!ON_IOS) {
          await airplane(false);
        }
      } finally {
        resetScenario();
        // Pulled bundles carry credentials on iOS beta3; E2E_KEEP_BUNDLES=1
        // keeps them for inspection.
        const { removed, kept } = removePulledBundles();
        report('pulled bundle roots', { removed: removed.length, kept });
        if (log !== undefined) {
          log.stop();
          const dump = process.env.E2E_LOGCAT_DUMP;
          if (dump) {
            writeFileSync(dump, log.lines.map(line => line.text).join('\n'));
          }
        }
      }
    }
  });

  describe('live: rh-live', () => {
    let run: Run;
    let before: Dispatch;
    let after: Dispatch;
    let bundles: PulledBundle[];
    let nonce: string;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('rh-live');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());
      const upload = must(
        await log.waitFor(new RegExp(`BUGSEE_E2E rh upload nonce=${nonce}`), 15_000, run.start),
        'the app calling upload()',
        run.start,
      );
      before = await awaitDispatch('before', upload.index, 30_000);
      after = await awaitDispatch('after', before.completed.index, 30_000);
      must(
        await log.waitFor(new RegExp(`BUGSEE_E2E rh dead-handle code=\\S+ nonce=${nonce}`), 15_000, after.dispatched.index),
        'the dead-handle probe',
        run.start,
      );
      bundles = await awaitBundles(1);
      report('case 1 before dispatch', before.dispatched.text.trim());
      report('case 1 before completion', `${before.completed.text.trim()} (+${before.elapsedMs}ms)`);
      report('case 1 after completion', `${after.completed.text.trim()} (+${after.elapsedMs}ms)`);
    });

    it("live: the handler's edits reach the retained bundle", async () => {
      // The live path, detected by its deadline: only the SDK's
      // BugseeReportHandlerThread is given 25 s.
      expect(before.deadlineMs).toBe(25_000);
      expect(before.by).toBe('js');
      expect(after.by).toBe('js');
      if (ON_IOS) {
        // And on main, not merely given main's deadline.
        expect(threadOf(run.banner)).toBeDefined();
        expect(threadOf(before.dispatched)).toBe(threadOf(run.banner));
        expect(threadOf(after.dispatched)).toBe(threadOf(run.banner));
      }
      must(
        log.all(new RegExp(`BUGSEE_E2E rh before type=bug id=\\S+ nonce=${nonce}`), run.start)[0],
        'rh before type=bug',
        run.start,
      );
      const afterMarker = must(
        log.all(new RegExp(`BUGSEE_E2E rh after type=bug severity=4 .*nonce=${nonce}`), run.start)[0],
        'rh after type=bug severity=4',
        run.start,
      );
      expect(afterMarker.text).toContain(`labels=["e2e","${nonce}"]`);
      report('case 1 after marker', afterMarker.text.trim());

      expect(bundles).toHaveLength(1);
      const [bundle] = bundles as [PulledBundle];
      report('case 1 request.json', pick(bundle.request));
      expect(bundle.request.type).toBe('bug');
      expect(bundle.request.summary).toBe(`e2e-${nonce}`);
      expect(bundle.request.description).toBe(`d-${nonce}`);
      expect(bundle.request.severity).toBe(4);
      expect(bundle.request.labels).toEqual(expect.arrayContaining([nonce]));
      expect(bundle.manifest.attrs.nonce).toBe(nonce);

      // Exactly one: onAfter is at-least-once, and the handler adds the
      // attachment only in onBefore, so a second copy would mean a delivery
      // replayed an edit it should not have.
      const attachments = bundle.manifest.files.filter(f => f.type === 'attachment');
      report('case 1 manifest attachments', attachments);
      expect(attachments.map(displayNameOf)).toEqual([`e2e-${nonce}.txt`]);
      // And it is the bytes JS sent, base64-decoded natively.
      const stored = fileNameOf(attachments[0]!);
      expect(readFileSync(join(bundle.dir, stored!), 'utf8')).toBe(`hello ${nonce}`);
    });

    it('live: a dead handle rejects with E_REPORT_HANDLE_DEAD', () => {
      must(
        log.all(new RegExp(`BUGSEE_E2E rh dead-handle code=E_REPORT_HANDLE_DEAD nonce=${nonce}`), run.start)[0],
        'rh dead-handle code=E_REPORT_HANDLE_DEAD',
        run.start,
      );
      expect(bundles[0]!.request.summary).toBe(`e2e-${nonce}`);
    });

    it('live: a refused attachment surfaces E_REPORT_ATTACHMENT_REJECTED', () => {
      must(
        log.all(
          new RegExp(`BUGSEE_E2E rh attach-refused code=E_REPORT_ATTACHMENT_REJECTED nonce=${nonce}`),
          run.start,
        )[0],
        'rh attach-refused code=E_REPORT_ATTACHMENT_REJECTED',
        run.start,
      );
      const names = bundles[0]!.manifest.files.map(displayNameOf);
      expect(names).not.toContain('x');
    });
  });

  it('timeout: a handler that never settles is completed at the deadline and the report still ships', async () => {
    await clearBundles();
    const run = await startRun('rh-hang');
    const { nonce } = run.scenario;
    const before = await awaitDispatch('before', run.launched.index, 40_000);
    // Assert the experiment: the JS handler really ran, and really hung.
    must(
      log.all(new RegExp(`BUGSEE_E2E rh before type=bug id=\\S+ nonce=${nonce}`), run.start)[0],
      'the hanging handler starting',
      run.start,
    );
    report('case 4 dispatch', before.dispatched.text.trim());
    report('case 4 completion', `${before.completed.text.trim()} (+${before.elapsedMs}ms)`);
    expect(before.by).toBe('deadline');
    // Our deadline, not the SDK's 30 s cap: completing after 30 s would mean
    // the SDK had already given up on the handler and moved on without it.
    //
    // "Under 30 s" alone does not pin that. The bridge clamps the live
    // deadline to the SDK option minus 1 s (30 s by default, so 29 s): a
    // LIVE_DEADLINE_MS pushed past the cap still completes at 29 s and would
    // pass. What holds the 5 s margin is the deadline itself being 25 s, and
    // the completion landing on it (1 s for scheduling), not merely before
    // the SDK's cap.
    expect(before.deadlineMs).toBe(25_000);
    expect(before.elapsedMs).toBeGreaterThanOrEqual(25_000);
    expect(before.elapsedMs).toBeLessThan(26_000);

    const bundles = await awaitBundles(1);
    expect(bundles.map(b => b.request.summary)).toEqual([`upload-${nonce}`]);
  });

  it('throw: a throwing handler still ships the report', async () => {
    await clearBundles();
    const run = await startRun('rh-throw');
    const { nonce } = run.scenario;
    const before = await awaitDispatch('before', run.launched.index, 10_000);
    must(
      log.all(new RegExp(`BUGSEE_E2E rh before type=bug id=\\S+ nonce=${nonce}`), run.start)[0],
      'the throwing handler starting',
      run.start,
    );
    report('case 5 completion', `${before.completed.text.trim()} (+${before.elapsedMs}ms)`);
    expect(before.by).toBe('js');
    expect(before.elapsedMs).toBeLessThanOrEqual(5_000);

    const bundles = await awaitBundles(1);
    expect(bundles.map(b => b.request.summary)).toEqual([`upload-${nonce}`]);
  });

  itAndroid('terminating: an uncaught Java exception never reaches JS; onAfter does, next launch', async () => {
    await clearBundles();
    const crash = await startRun('rh-crash');
    // A debug build's red box catches the exception before it can kill the
    // process, which would make every assertion below vacuous.
    if (crash.dev) {
      throw new Error(
        'case 6 needs a JS bundle without __DEV__: build with ' +
          '`./gradlew :app:assembleRelease -PbugseeE2eDebuggable=true` and install it.',
      );
    }
    const crashNonce = crash.scenario.nonce;
    const crashing = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E rh crashing nonce=${crashNonce}`), 15_000, crash.start),
      'the app calling testNativeCrash()',
      crash.start,
    );
    const pid = /^\s*\S+\s+(\d+)\s/.exec(crashing.text)?.[1];

    // 9.1.4: the process really died of this exception.
    must(
      await log.waitFor(/FATAL EXCEPTION/, 20_000, crashing.index),
      'FATAL EXCEPTION',
      crash.start,
    );
    must(
      await log.waitFor(/java\.lang\.RuntimeException: Test crash/, 20_000, crashing.index),
      'java.lang.RuntimeException: Test crash',
      crash.start,
    );
    const terminating = must(
      await log.waitFor(/report handler - completed by=terminating phase=\S+ report=(\S+)/, 20_000, crashing.index),
      'report handler - completed by=terminating',
      crash.start,
    );
    const died = must(
      await log.waitFor(
        new RegExp(`Process ${escape(ANDROID_PACKAGE)} \\(pid ${pid}\\) has died|Killing ${pid}:${escape(ANDROID_PACKAGE)}`),
        20_000,
        crashing.index,
      ),
      `process ${pid} dying`,
      crash.start,
    );
    expect(await pidOf()).not.toBe(pid);
    const crashEnd = log.mark();
    report('case 6 terminating', terminating.text.trim());
    report('case 6 died', died.text.trim());
    expect(log.all(/BUGSEE_E2E rh before/, crash.start, crashEnd)).toEqual([]);
    const crashedReport = /report=(\S+)/.exec(terminating.text)![1]!;

    // Relaunch, still offline. The app launches the SDK from JS, and on that
    // path the SDK recovers the crash on its live BugseeReportHandlerThread:
    // JS gets a real onAfter, with the live 25 s deadline, and its edits
    // reach the crash bundle. Observed on the WOD_LX1 and ruled the expected
    // outcome (controller, Task 3.4d). The bridge's `completed by=recovery`
    // short-circuit is only for the SDK's bounded early-recovery path (the
    // `bugsee-report-handler-bounded` thread, Callback.NOOP), which cannot be
    // staged by hand; ReportHandlerBridgeTest's
    // aNonLiveThreadCompletesAtOnceAndNeverReachesJs covers it. So here a
    // `by=recovery` line for this report is a failure, not an alternative.
    const observe = await startRun('rh-observe');
    const observeNonce = observe.scenario.nonce;
    must(
      log.all(new RegExp(`BUGSEE_E2E rh handler installed scenario=rh-observe nonce=${observeNonce}`), observe.start)[0],
      'the rh-observe handler being installed',
      observe.start,
    );
    const after = await awaitDispatch('after', observe.start, 30_000);
    report('case 6 after dispatch', after.dispatched.text.trim());
    report('case 6 after completion', `${after.completed.text.trim()} (+${after.elapsedMs}ms)`);
    expect(after.deadlineMs).toBe(25_000);
    expect(after.by).toBe('js');
    const marker = must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E rh after type=crash id=${escape(crashedReport)} labels-set nonce=${observeNonce}`),
        15_000,
        observe.start,
      ),
      'rh after type=crash carrying the crashed report id',
      observe.start,
    );
    report('case 6 after marker', marker.text.trim());
    // onBefore is at-most-once: the crash already spent it, terminating.
    expect(log.all(/BUGSEE_E2E rh before/, observe.start)).toEqual([]);

    const bundles = await awaitBundles(1);
    report('case 6 bundles', bundles.map(b => ({ file: b.file, request: pick(b.request) })));
    const crashes = bundles.filter(b => b.request.type === 'crash');
    expect(crashes.map(b => b.file)).toEqual([`${crashedReport}.bundle.zip`]);
    expect(crashes[0]!.request.labels).toEqual(expect.arrayContaining([observeNonce]));
    // Checked last, after the bundle exists, so the window covers the whole
    // recovery rather than only the moment the dispatch arrived.
    expect(log.all(/report handler - completed by=recovery/, observe.start)).toEqual([]);

    // Controller ruling: the NDK's 4th library, the Crashpad handler, only
    // execs at a native crash (StartJavaHandlerAtCrash). The Java exception
    // above goes through the JVM's uncaught handler, never Crashpad, so stage
    // a native one too (workbook 9.3.1) and count across both crashes and the
    // relaunches.
    const pid2 = await pidOf();
    if (pid2 === undefined) {
      throw new Error('the relaunched app has no process to crash');
    }
    const nativeStart = log.mark();
    await adb('shell', 'run-as', ANDROID_PACKAGE, 'kill', '-11', pid2);
    must(
      await log.waitFor(new RegExp(`Fatal signal 11 \\(SIGSEGV\\).*pid ${pid2}`), 20_000, nativeStart),
      `Fatal signal 11 in pid ${pid2}`,
      nativeStart,
    );
    const nativeDied = must(
      await log.waitFor(new RegExp(`Process ${escape(ANDROID_PACKAGE)} \\(pid ${pid2}\\) has died`), 30_000, nativeStart),
      `process ${pid2} dying of SIGSEGV`,
      nativeStart,
    );
    report('case 6 native crash died', nativeDied.text.trim());
    // The relaunch picks the native crash up, so no pending crash is left
    // for the next run to trip over.
    await startRun('rh-observe');
    const nativeBundles = await awaitBundles(2);
    report('case 6 bundles after the native crash', nativeBundles.map(b => ({
      file: b.file,
      request: pick(b.request),
      files: b.manifest.files.map(f => f.type),
    })));
    expect(nativeBundles.filter(b => b.request.type === 'crash')).toHaveLength(2);
    // Let anything the relaunch loads reach the log before counting.
    await new Promise(resolve => setTimeout(resolve, 5_000));

    const libraries = [
      ...new Set(
        log
          .all(/libbugsee[a-z-]*\.so/, crash.start)
          .flatMap(line => line.text.match(/libbugsee[a-z-]*\.so/g) ?? []),
      ),
    ].sort();
    report('case 6 libbugsee .so', libraries);
    for (const line of log.all(/libbugsee-crashpad-handler\.so/, crash.start).slice(0, 3)) {
      report('case 6 crashpad handler line', line.text.trim());
    }
    expect(libraries).toHaveLength(4);
    expect(libraries).toContain('libbugsee-crashpad-handler.so');
  });

  // iOS has no terminating dispatch: the SDK's crash handler runs no report
  // handlers and never passes isTerminating = YES, so the whole crash reaches
  // JS at the next launch. The bridge's terminating branch is covered only by
  // BGSRNReportHandlerBridgeTests' testTerminatingCompletesSynchronouslyAndNeverReachesJs.
  itIosRecovery('recovery: a crash recovered at the next launch reaches JS off main with deadline=2500', async () => {
    await clearBundles();
    const crash = await startRun('rh-crash');
    const crashNonce = crash.scenario.nonce;
    const crashing = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E rh crashing nonce=${crashNonce}`), 15_000, crash.start),
      'the app calling testNativeCrash()',
      crash.start,
    );
    const pid = Number(/BareExample\[(\d+):/.exec(crash.banner.text)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);

    // 9.1.4: the process really died of it. testNativeCrash on iOS is
    // +[Bugsee testCrash], an uncaught NSException that aborts the process.
    const thrown = must(
      await log.waitFor(/Terminating app due to uncaught exception 'NSGenericException'/, 20_000, crashing.index),
      "the uncaught NSException",
      crash.start,
    );
    const code = await Promise.race([
      crash.launch!.ended,
      new Promise<'still attached'>(resolve => setTimeout(() => resolve('still attached'), 20_000)),
    ]);
    expect(code).not.toBe('still attached');
    expect(hostProcessAlive(pid)).toBe(false);
    const died = await awaitHostCrashReport(pid);
    report('case 6 thrown', thrown.text.trim());
    report('case 6 died', { pid, consoleExit: code, ...died });
    expect(died.type).toBe('EXC_CRASH');
    expect(died.signal).toBe('SIGABRT');
    const crashEnd = log.mark();
    report('case 6 dispatches in the crash run', log.all(/report handler/, crash.start, crashEnd).map(l => l.text.trim()));

    // Relaunch, still against the dead endpoint. The handler is registered
    // before launch(), so JS is attached when the SDK recovers the crash --
    // off main, so with the recovery deadline.
    const observe = await startRun('rh-observe');
    const observeNonce = observe.scenario.nonce;
    must(
      log.all(new RegExp(`BUGSEE_E2E rh handler installed scenario=rh-observe nonce=${observeNonce}`), observe.start)[0],
      'the rh-observe handler being installed',
      observe.start,
    );
    const recovered = await awaitDispatch('before|after', observe.start, 10_000);
    report('case 6 recovery dispatch', recovered.dispatched.text.trim());
    report('case 6 recovery completion', `${recovered.completed.text.trim()} (+${recovered.elapsedMs}ms)`);
    expect(recovered.deadlineMs).toBe(2_500);
    expect(threadOf(recovered.dispatched)).not.toBe(threadOf(observe.banner));
    expect(recovered.by).toBe('js');
    const marker = must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E rh ${recovered.phase} type=crash id=(\\S+) .*nonce=${observeNonce}`),
        15_000,
        observe.start,
      ),
      `rh ${recovered.phase} type=crash`,
      observe.start,
    );
    report('case 6 JS marker', marker.text.trim());
    const crashedReport = /id=(\S+)/.exec(marker.text)![1]!;
    expect(log.all(/report handler - completed by=no-handler/, observe.start)).toEqual([]);

    const bundles = await awaitBundles(1);
    report('case 6 bundles', bundles.map(b => ({ file: b.file, request: pick(b.request) })));
    const crashes = bundles.filter(b => b.request.type === 'crash');
    expect(crashes.map(b => b.file)).toEqual([`${crashedReport}.bundle.zip`]);
  });
});
