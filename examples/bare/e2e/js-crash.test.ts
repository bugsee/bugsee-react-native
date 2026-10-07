/**
 * API-10 testJsCrash, and the Android crash-priority enum option.
 *
 * Scenario `cov-jscrash` (scenarios/coverage.ts) launches with
 * `reporting.defaults.crash-priority` = IssueSeverity.Medium (2) -- an
 * ordinal lookup would give values()[2], High (3), and the SDK default is
 * neither -- and calls `Bugsee.testJsCrash()` on its own turn, outside any
 * try, so only the global handler sees it.
 *
 * Android files the crash at once (the process lives on under the Debug red
 * box). iOS stores a JS fatal and files it at the next launch, so the iOS
 * case relaunches and looks then. The iOS simulator slice compiles the
 * exception reporter out (exceptions.test.ts), so the case is device-only.
 */
import { type PulledBundle, crashOf } from './bundles';
import { iosTarget } from './device';
import { ON_IOS, type Run, TARGET_NAME, awaitBundles, bridgeLine, describeDevice, must, report, startRun, stopApp } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog } from './scenario';

jest.setTimeout(6 * 60_000);

/** The iOS simulator slice has no exception reporter: device-only there. */
const itDevice = ON_IOS && iosTarget() === 'simulator' ? it.skip : it;
/**
 * iOS 7.0.0-beta4 recovers the JS fatal at the next launch (beta3 lost it,
 * api-device-coverage.md R2) but files it at Blocker (5), not the
 * `reporting.defaults.crash-priority` of 2 it was launched with (XS, run
 * 2026-10-06). Android files it at 2.
 * Filed: https://github.com/bugsee/bugsee-cocoa/issues/198
 */
const itSeverity = ON_IOS ? (iosTarget() === 'simulator' ? it.skip : it.failing) : it;

describeDevice(`testJsCrash() on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let crashes: PulledBundle[] = [];

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-jscrash');
    if (ON_IOS && iosTarget() === 'simulator') {
      return;
    }
    run = await startRun('cov-jscrash');
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E cov jscrash throwing nonce=${run.scenario.nonce}`), 20_000, run.start),
      'the scenario throwing',
      run.start,
    );
    if (ON_IOS) {
      // Stored first: the bridge says when the SDK has the fatal on disk
      // (exceptions.test.ts exc-fatal), and only then is the app stopped.
      must(
        await log.waitFor(bridgeLine('exception unhandled completed'), 20_000, run.launched.index),
        'the JS fatal stored (exception unhandled completed)',
        run.start,
      );
      await stopApp();
      // The next launch is what sends a stored JS fatal on iOS.
      await startRun('cov-identity');
    }
    // iOS: the relaunch's own upload and the recovered crash.
    const bundles = await awaitBundles(ON_IOS ? 2 : 1, 60_000);
    report('bundles', bundles.map(b => ({ type: b.request.type, severity: b.request.severity, summary: b.request.summary })));
    crashes = bundles.filter(b => b.request.type === 'crash');
  });

  afterAll(() => endRetainingSuite(log));

  itDevice('is reported as one crash: the JS error, unhandled', () => {
    expect(crashes).toHaveLength(1);
    const crash = crashOf(crashes[0]!)!;
    const exception = crash.exception as { name?: string; reason?: string };
    report('crash exception', { name: exception.name, reason: exception.reason?.slice(0, 200), handled: crash.handled });
    expect(exception.name).toMatch(/ReactNativeWebException$/);
    const payload = JSON.parse(exception.reason!) as { name?: string; reason?: string };
    expect(payload.name).toBe('Error');
    expect(payload.reason).toBe('Bugsee test JS crash');
    expect(crash.handled).toBe(false);
  });

  itSeverity('is filed at the default crash priority it was launched with', () => {
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.request.severity).toBe(2);
  });
});
