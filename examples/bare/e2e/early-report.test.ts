/**
 * G2 / https://github.com/bugsee/bugsee-cocoa/issues/227: a report made right
 * after `await launch()`, while the SDK is still Launching, must reach a
 * bundle.
 *
 * iOS 7.0.0-beta5 drops `logException` and `upload` while Launching, silently,
 * and `launch()` resolves before Launched. The bridge holds those calls and
 * replays them on Launched (`BGSRNLaunchHold`, a workaround until #227 is
 * fixed). Scenario `early-report` (scenarios/early-report.ts) launches, makes
 * both calls with nothing in between, then reads the status.
 *
 * An attempt counts only when both calls landed in the Launching window:
 * `status=1` right after them, or both logged `held until launched`. About
 * 1 cold launch in 3 on the XS reaches Launched first, so the test repeats
 * the cold launch (wipe, stop, launch) until one lands in the window, at
 * most MAX_WINDOW_ATTEMPTS times, logs how many it took, and asserts on that
 * attempt. Only when none lands does it fail, saying so.
 *
 * iPhone only (`E2E_IOS_TARGET=device`, Debug, `DEAD_ENDPOINT` retention): the
 * simulator SDK compiles `logException` out. Without the hold both bundles are
 * missing.
 */
import { writeFileSync } from 'node:fs';

import { type PulledBundle, crashOf, removePulledBundles, terminateIosApp } from './bundles';
import { iosTarget } from './device';
import {
  ON_IOS,
  type Run,
  awaitBundles,
  bridgeLine,
  clearBundles,
  debugOnly,
  must,
  report,
  startRun,
  TARGET_NAME,
  useLog,
} from './harness';
import { type DeviceLog, IosConsole, resetScenario } from './scenario';

const ON_IOS_DEVICE = ON_IOS && iosTarget() === 'device';
const describeIosDevice = debugOnly(
  ON_IOS_DEVICE ? describe : describe.skip,
  'Debug case (asserts a __DEV__ bundle)',
);

jest.setTimeout(20 * 60_000);

/**
 * Cold launches tried before the window counts as never reached. Misses come
 * in streaks (5 in a row once on the XS, about 3.5 s per attempt), so 10.
 */
const MAX_WINDOW_ATTEMPTS = 10;

/** The JS payload's `reason`, which the bridge sends as the exception reason. */
function payloadReason(bundle: PulledBundle): string | undefined {
  const exception = crashOf(bundle)?.exception as { reason?: unknown } | undefined;
  if (typeof exception?.reason !== 'string' || !exception.reason.startsWith('{')) {
    return undefined;
  }
  const reason = (JSON.parse(exception.reason) as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

describeIosDevice(`reports right after launch() on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run | undefined;
  let nonce: string;
  let attempts = 0;
  const missed: string[] = [];
  let bundles: PulledBundle[] = [];

  /**
   * Whether this attempt's two calls landed while the SDK was Launching:
   * `status=1` right after both, or (with the hold) both calls logged
   * `held until launched` -- a held call is replayed, so `getStatus()` can
   * already read 2.
   */
  function inWindow(attempt: Run, sentText: string): boolean {
    const statusLaunching = /early sent launched=true status=1 /.test(sentText);
    const heldBoth =
      log.all(bridgeLine('exception handled bytes=\\d+ held until launched'), attempt.start).length === 1 &&
      log.all(bridgeLine('upload held until launched'), attempt.start).length === 1;
    return statusLaunching || heldBoth;
  }

  // About 1 cold launch in 3 on the XS reaches Launched before the JS
  // continuation reaches native, and such a run proves nothing about the
  // window. So the cycle -- wipe and stop the app, cold-launch the scenario --
  // repeats until an attempt lands in the window, at most
  // MAX_WINDOW_ATTEMPTS times, and the cases below assert on that attempt.
  beforeAll(async () => {
    log = IosConsole.start();
    useLog(log, 'G2');
    while (attempts < MAX_WINDOW_ATTEMPTS) {
      attempts += 1;
      await clearBundles();
      const attempt = await startRun('early-report');
      report(`attempt ${attempts} banner`, attempt.banner.text.trim());
      expect(attempt.dev).toBe(true);
      const sentText = must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E early sent .*nonce=${attempt.scenario.nonce}`),
          30_000,
          attempt.start,
        ),
        'the early-sent marker',
        attempt.start,
      ).text.trim();
      if (inWindow(attempt, sentText)) {
        run = attempt;
        nonce = attempt.scenario.nonce;
        report('early sent', sentText);
        break;
      }
      missed.push(sentText);
      report(`attempt ${attempts} missed the Launching window`, sentText);
    }
    report('attempts to land in the Launching window', { attempts, inWindow: run !== undefined });
    if (run === undefined) {
      return;
    }
    bundles = await awaitBundles(2, 60_000);
    report(
      'bundles',
      bundles.map(b => ({ file: b.file, type: b.request.type, summary: b.request.summary })),
    );
  });

  afterAll(async () => {
    try {
      await terminateIosApp().catch(() => {});
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        removePulledBundles();
      } finally {
        if (log !== undefined) {
          log.stop();
          const dump = process.env.E2E_LOGCAT_DUMP;
          if (dump) {
            writeFileSync(dump, log.lines.map(line => line.text).join('\n'));
          }
        }
        resetScenario();
      }
    }
  });

  /** The in-window attempt, or the clear reason there is none. */
  function windowRun(): Run {
    if (run === undefined) {
      throw new Error(
        `none of ${attempts} cold launches made both calls while the SDK was Launching ` +
          `(Launched always came first), so nothing here is proven:\n${missed.join('\n')}`,
      );
    }
    return run;
  }

  it('lands an attempt in the Launching window', () => {
    expect(windowRun().scenario.nonce).toBe(nonce);
  });

  it('files the handled exception', () => {
    windowRun();
    const found = bundles.filter(b => payloadReason(b) === `early-exc-${nonce}`);
    expect(found).toHaveLength(1);
  });

  it('files the upload', () => {
    windowRun();
    const found = bundles.filter(b => b.request.summary === `early-up-${nonce}`);
    expect(found).toHaveLength(1);
  });

  it('logs held until launched, then sent, for the exception', () => {
    const held = log.all(bridgeLine('exception handled bytes=\\d+ held until launched'), windowRun().start);
    const sent = log.all(bridgeLine('exception handled sent bytes='), windowRun().start);
    expect(held).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(held[0]!.index).toBeLessThan(sent[0]!.index);
    expect(log.all(bridgeLine('upload held until launched'), windowRun().start)).toHaveLength(1);
    expect(log.all(bridgeLine('upload sent'), windowRun().start)).toHaveLength(1);
  });
});
