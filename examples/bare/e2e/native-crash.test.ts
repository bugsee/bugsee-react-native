/**
 * Task 7.6b: a real native crash from JS reaches an Android report.
 *
 * `crashNative('segv'|'abort')` (examples/e2e-native) raises a signal in JNI
 * code. The Bugsee NDK path recovers it on the next launch as a retained
 * crash bundle. Task 3.4d's external `adb shell run-as … kill -11` stays in
 * place; this suite is the NDK path's own coverage.
 *
 * Preconditions (as report-handler.test.ts / 3.4d): the debug app is
 * installed on the handset in device.ts, Metro is reachable over
 * `adb reverse tcp:8081 tcp:<E2E_METRO_PORT>`, airplane mode is on before
 * the app starts, and bundles are cleared and the clear asserted.
 *
 * Markers, from scenarios/native.ts:
 *   BUGSEE_E2E native crashing kind=<kind>   after Launched, before the signal
 *   BUGSEE_E2E native after type=<type>      onAfterReportCreated (observe)
 *
 * Case 3 pins the NDK relaunch path: the SDK recovers on
 * `bugsee-report-handler-bounded`, so ReportHandlerBridge completes
 * `by=recovery` and never emits to JS. Task 3.4d's Java recovery was the
 * live `BugseeReportHandlerThread`; this NDK relaunch is not.
 *
 * crash.json fields asserted here are the ones the Android SDK writes
 * (ExceptionSerializer / BugseeDetectionCrashNdk.buildSignalInfo) and the
 * reporting-bundle spec names: `ndkCrash`, `exception_type`, `signal.name`,
 * `signal.number`.
 */
import { writeFileSync } from 'node:fs';

import {
  type PulledBundle,
  airplane,
  removePulledBundles,
} from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
  ON_ANDROID,
  type Run,
  awaitBundles,
  clearBundles,
  TARGET_NAME,
  describeDevice,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import {
  type DeviceLog,
  type LogLine,
  Logcat,
  adb,
  pidOf,
  resetScenario,
} from './scenario';

const itAndroid = ON_ANDROID ? it : it.skip;

jest.setTimeout(10 * 60_000);

let log: DeviceLog;

/** crash.json from a pulled bundle (manifest type `crash`). */
function crashOf(bundle: PulledBundle): Record<string, unknown> {
  const text = bundle.captures.get('crash');
  if (text === undefined) {
    throw new Error(
      `bundle ${bundle.file} has no crash capture; files=${JSON.stringify(bundle.manifest.files)}`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function signalOf(crash: Record<string, unknown>): Record<string, unknown> {
  const signal = crash.signal;
  if (signal === null || typeof signal !== 'object') {
    throw new Error(`crash.json has no signal object: ${JSON.stringify(crash)}`);
  }
  return signal as Record<string, unknown>;
}

/**
 * Waits until `pidof com.bareexample` is empty, or `timeoutMs` elapses.
 * Returns whether it went empty.
 */
async function awaitProcessGone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await pidOf()) === undefined) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

interface KindRun {
  readonly crashRun: Run;
  readonly crashing: LogLine;
  readonly fatal: LogLine;
  readonly gone: boolean;
  readonly observe: Run;
  /** Bounded early-recovery completions in the observe run. */
  readonly recoveryLines: readonly LogLine[];
  readonly crash: Record<string, unknown>;
  readonly signal: Record<string, unknown>;
}

/**
 * Crash with `kind`, relaunch observe, pull the retained crash bundle.
 * Waits for the NDK bounded recovery completion (`by=recovery`); case 3
 * asserts that path and that JS never saw the report.
 */
async function runKind(
  kind: 'segv' | 'abort',
  fatalPattern: RegExp,
  fatalLabel: string,
): Promise<KindRun> {
  await clearBundles();
  const crashRun = await startRun(`native-crash-${kind}`);
  report('banner', crashRun.banner.text.trim());
  expect(crashRun.dev).toBe(true);

  const crashing = must(
    await log.waitFor(
      new RegExp(`BUGSEE_E2E native crashing kind=${kind}`),
      15_000,
      crashRun.launched.index,
    ),
    `the ${kind} crashing marker`,
    crashRun.start,
  );
  report(`${kind} crashing`, crashing.text.trim());

  const fatal = must(
    await log.waitFor(fatalPattern, 20_000, crashing.index),
    fatalLabel,
    crashRun.start,
  );
  report(`${kind} fatal`, fatal.text.trim());
  const gone = await awaitProcessGone(10_000);
  report(`${kind} pid gone`, gone);

  const observe = await startRun('native-crash-observe');
  // NDK recovery: bounded thread, completed natively — wait for that, not JS.
  must(
    await log.waitFor(
      /report handler - completed by=recovery phase=after/,
      30_000,
      observe.start,
    ),
    'report handler - completed by=recovery phase=after',
    observe.start,
  );
  // A short beat so a late live dispatch (which must not happen) would land.
  await new Promise(resolve => setTimeout(resolve, 2_000));
  const recoveryLines = log.all(/report handler - completed by=recovery/, observe.start);
  report(
    `${kind} recovery`,
    recoveryLines.map(line => line.text.trim()),
  );
  report(
    `${kind} after markers`,
    log.all(/BUGSEE_E2E native after type=crash/, observe.start).map(line => line.text.trim()),
  );

  const bundles = await awaitBundles(1);
  const crashes = bundles.filter(b => b.request.type === 'crash');
  expect(crashes).toHaveLength(1);
  const crash = crashOf(crashes[0]!);
  const signal = signalOf(crash);
  report(`${kind} crash.json signal`, signal);
  report(`${kind} crash.json ndkCrash`, crash.ndkCrash);
  report(`${kind} crash.json exception_type`, crash.exception_type);

  return { crashRun, crashing, fatal, gone, observe, recoveryLines, crash, signal };
}

describeDevice(`native crash on ${TARGET_NAME}`, () => {
  beforeAll(async () => {
    if (!ON_ANDROID) {
      return;
    }
    log = await Logcat.start();
    useLog(log, '7.6b');
    await airplane(true);
  });

  afterAll(async () => {
    if (!ON_ANDROID) {
      return;
    }
    try {
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        await airplane(false);
      } finally {
        try {
          const { removed, kept } = removePulledBundles();
          report('pulled bundle roots', { removed: removed.length, kept });
        } finally {
          try {
            if (log !== undefined) {
              log.stop();
              const dump = process.env.E2E_LOGCAT_DUMP;
              if (dump) {
                writeFileSync(dump, log.lines.map(line => line.text).join('\n'));
              }
            }
          } finally {
            resetScenario();
          }
        }
      }
    }
  });

  describe('segv', () => {
    let run: KindRun;

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      run = await runKind('segv', /Fatal signal 11 \(SIGSEGV\)/, 'Fatal signal 11 (SIGSEGV)');
    });

    itAndroid("crashNative('segv') kills the process with SIGSEGV", () => {
      expect(run.fatal.text).toMatch(/Fatal signal 11 \(SIGSEGV\)/);
      expect(run.gone).toBe(true);
    });

    itAndroid('the relaunch recovers it as a native crash', () => {
      expect(run.crash.ndkCrash).toBe(true);
      expect(run.crash.exception_type).toBe('native');
      expect(run.signal.name).toBe('SIGSEGV');
      expect(run.signal.number).toBe(11);
    });

    itAndroid('the NDK relaunch recovers on the bounded path, not JS', () => {
      // Pins this path only: recovery completion present, JS after absent.
      // A live-thread delivery (by=js + after marker) would fail both halves.
      const recoveryTexts = run.recoveryLines.map(line => line.text);
      expect(recoveryTexts.some(text => /completed by=recovery phase=after/.test(text))).toBe(
        true,
      );
      report('case 3 recovery lines', recoveryTexts.map(text => text.trim()));
      expect(
        log.all(/BUGSEE_E2E native after type=crash/, run.observe.start).map(line => line.text),
      ).toEqual([]);
      expect(
        log.all(/report handler .* completed by=js/, run.observe.start).map(line => line.text),
      ).toEqual([]);
    });
  });

  describe('abort', () => {
    let run: KindRun;

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      run = await runKind('abort', /Fatal signal 6 \(SIGABRT\)/, 'Fatal signal 6 (SIGABRT)');
    });

    itAndroid("crashNative('abort') is SIGABRT", () => {
      expect(run.fatal.text).toMatch(/Fatal signal 6 \(SIGABRT\)/);
      expect(run.gone).toBe(true);
      expect(run.crash.ndkCrash).toBe(true);
      expect(run.crash.exception_type).toBe('native');
      expect(run.signal.name).toBe('SIGABRT');
      expect(run.signal.number).toBe(6);
    });
  });
});
