/**
 * Task 3.4d: the report handler on Android hardware.
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
 * Preconditions, as for launch.test.ts: the app is installed on the handset
 * named in device.ts, and for a debug build Metro is running with
 * `adb reverse tcp:8081 tcp:8081`. Cases 1-5 run on a debug build. Case 6
 * needs a build without dev support -- a debug build routes the exception to
 * DevSupportManager (a red box) and the process lives: `./gradlew
 * :app:assembleRelease -PbugseeE2eDebuggable=true` (the flag keeps `run-as`
 * working), and `-t terminating` to run just that case. All six pass on that
 * build too. `E2E_LOGCAT_DUMP=<file>` saves the whole captured log.
 *
 * Log lines matched, from ReportHandlerBridge (tag BugseeRN):
 *   report handler <handle> phase=<p> deadline=<ms>       a dispatch to JS
 *   report handler <handle> completed by=<by>              that handle's end
 *   report handler - completed by=<by> phase=<p> report=<id>   never reached JS
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkAndroidBanner } from '../../../scripts/sdk-banner';
import { readNativeVersions } from '../../../scripts/native-versions';
import {
  type PulledBundle,
  airplane,
  clearAndroidBundles,
  displayNameOf,
  fileNameOf,
  listAndroidBundles,
  pullAndroidBundles,
} from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
  type LogLine,
  Logcat,
  type Scenario,
  adb,
  launchScenario,
  pidOf,
  resetScenario,
  writeScenario,
} from './scenario';

const ON_ANDROID = process.env.E2E_PLATFORM === 'android';
const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(10 * 60_000);

let log: Logcat;

/** Fails with the captured log, so a miss can be read rather than guessed. */
function must(line: LogLine | undefined, what: string, from = 0): LogLine {
  if (line === undefined) {
    throw new Error(`never saw ${what}.\nLog since the run started:\n${log.tail(from)}`);
  }
  return line;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Run {
  readonly scenario: Scenario;
  /** Log index the run started at. */
  readonly start: number;
  readonly banner: LogLine;
  readonly launched: LogLine;
  /** Whether the JS bundle was built with __DEV__, as the app reports it. */
  readonly dev: boolean;
}

/**
 * Starts the app on `name` and asserts the per-run preconditions: the app
 * really ran this scenario (the nonce round-trips), the SDK build is the
 * pinned one, and the SDK reached Launched with the device offline.
 */
async function startRun(name: string): Promise<Run> {
  const scenario = writeScenario(name);
  const start = log.mark();
  await launchScenario(scenario);

  const ran = must(
    await log.waitFor(
      new RegExp(`BUGSEE_E2E scenario=${name} nonce=${scenario.nonce} `),
      120_000,
      start,
    ),
    `the app starting scenario ${name} (nonce ${scenario.nonce})`,
    start,
  );
  const banner = must(
    await log.waitFor(/Bugsee Android SDK \S+ \[[0-9a-f]+\]/, 15_000, start),
    'the SDK build banner',
    start,
  );
  const bannerCheck = checkAndroidBanner(banner.text, readNativeVersions());
  if (!bannerCheck.ok) {
    throw new Error(`SDK build banner does not match the pin: ${bannerCheck.reason}`);
  }
  const launched = must(
    await log.waitFor(/BUGSEE_E2E status=2/, 20_000, ran.index),
    'Status.Launched with the device offline',
    start,
  );
  return { scenario, start, banner, launched, dev: / dev=true/.test(ran.text) };
}

/** The retained bundles, once at least `count` exist (or the wait runs out). */
async function awaitBundles(count: number, timeoutMs = 60_000): Promise<PulledBundle[]> {
  const deadline = Date.now() + timeoutMs;
  while ((await listAndroidBundles()).length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return pullAndroidBundles();
}

const DISPATCH = (phase: string) =>
  new RegExp(`BugseeRN.*report handler (rh-\\d+) phase=${phase} deadline=(\\d+)`);

/** Any handle's completion -- minted handles log `<id> completed by=`. */
function completionOf(handle: string): RegExp {
  return new RegExp(`report handler ${escape(handle)} completed by=(\\S+)`);
}

interface Dispatch {
  readonly handle: string;
  readonly deadlineMs: number;
  readonly dispatched: LogLine;
  readonly completed: LogLine;
  readonly by: string;
  readonly elapsedMs: number;
}

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
  const [, handle, deadline] = DISPATCH(phase).exec(dispatched.text)!;
  const completed = must(
    await log.waitFor(completionOf(handle!), completionTimeoutMs, dispatched.index),
    `${handle}'s completion`,
    from,
  );
  return {
    handle: handle!,
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

/** Evidence the report is committed, surfaced for the commit body. */
function report(label: string, value: unknown): void {
  console.log(`[3.4d] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

describeAndroid('report handler on an Android handset', () => {
  beforeAll(async () => {
    log = await Logcat.start();
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
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await clearAndroidBundles().catch(() => {});
    } finally {
      await airplane(false);
      resetScenario();
      if (log !== undefined) {
        log.stop();
        const dump = process.env.E2E_LOGCAT_DUMP;
        if (dump) {
          writeFileSync(dump, log.lines.map(line => line.text).join('\n'));
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
      await clearAndroidBundles();
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
    await clearAndroidBundles();
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
    await clearAndroidBundles();
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

  it('terminating: an uncaught Java exception never reaches JS; onAfter does, next launch', async () => {
    await clearAndroidBundles();
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
});
