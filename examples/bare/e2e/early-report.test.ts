/**
 * G2 / https://github.com/bugsee/bugsee-cocoa/issues/227: a report made right
 * after `await launch()`, while the SDK is still Launching, must reach a
 * bundle.
 *
 * iOS 7.0.0-beta5 drops `logException` and `upload` while Launching, silently,
 * and `launch()` resolves before Launched. The bridge holds those calls and
 * replays them on Launched (`BGSRNLaunchHold`, a workaround until #227 is
 * fixed). Scenario `early-report` (scenarios/early-report.ts) launches, makes
 * both calls with nothing in between, then reads the status: `status=1` proves
 * the calls landed in the Launching window, so a pass is not a call that
 * merely came late.
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

jest.setTimeout(10 * 60_000);

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
  let run: Run;
  let nonce: string;
  let sentText: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    log = IosConsole.start();
    useLog(log, 'G2');
    await clearBundles();
    run = await startRun('early-report');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    expect(run.dev).toBe(true);
    sentText = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E early sent .*nonce=${nonce}`), 30_000, run.start),
      'the early-sent marker',
      run.start,
    ).text;
    report('early sent', sentText.trim());
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

  // The window proof: `status=1` right after both calls, or (with the hold)
  // both calls logged `held until launched` -- a held call is replayed, so
  // `getStatus()` can already read 2. A run with neither (seen about 1 in 3
  // on the XS) proves nothing about the window and fails here as
  // inconclusive rather than passing the cases below for the wrong reason.
  it('makes both calls while the SDK is Launching (else the run is inconclusive)', () => {
    const statusLaunching = /early sent launched=true status=1 /.test(sentText);
    const heldBoth =
      log.all(bridgeLine('exception handled bytes=\\d+ held until launched'), run.start).length === 1 &&
      log.all(bridgeLine('upload held until launched'), run.start).length === 1;
    // The whole object on failure: which proof was missing, and the marker.
    expect({ sentText, statusLaunching, heldBoth, inWindow: statusLaunching || heldBoth }).toMatchObject({
      inWindow: true,
    });
  });

  it('files the handled exception', () => {
    const found = bundles.filter(b => payloadReason(b) === `early-exc-${nonce}`);
    expect(found).toHaveLength(1);
  });

  it('files the upload', () => {
    const found = bundles.filter(b => b.request.summary === `early-up-${nonce}`);
    expect(found).toHaveLength(1);
  });

  it('logs held until launched, then sent, for the exception', () => {
    const held = log.all(bridgeLine('exception handled bytes=\\d+ held until launched'), run.start);
    const sent = log.all(bridgeLine('exception handled sent bytes='), run.start);
    expect(held).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(held[0]!.index).toBeLessThan(sent[0]!.index);
    expect(log.all(bridgeLine('upload held until launched'), run.start)).toHaveLength(1);
    expect(log.all(bridgeLine('upload sent'), run.start)).toHaveLength(1);
  });
});
