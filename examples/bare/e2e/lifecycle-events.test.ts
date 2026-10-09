/**
 * N-09: the lifecycle events no other suite provokes (section 1.2).
 *
 *   EVT-07 RelaunchedAfterCrash  `api-crash` (testNativeCrash once Launched),
 *          then `api-after-crash`, subscribed before launch(): the event fires
 *          once at that relaunch. A and X (the simulator has no crash reporter).
 *   EVT-08/09 Before/AfterReportShown  `api-dialog-events` opens the report
 *          dialog. Both SDKs document AfterReportShown as dispatched when the
 *          reporting UI is shown, and fire it as it appears (Android
 *          BugReportingActivity.loadState, iOS BGSInterfaceManager), not when
 *          it is dismissed as plan EVT-09 assumed: asserted as documented, on
 *          A, S and X, with no tap.
 *   EVT-15 ReportUploadFailed / EVT-16 ReportUploadFailedWithFutureRetry
 *          `api-upload-events` uploads against the dead endpoint and waits.
 *          `E2E_UPLOAD_ONLINE=1` (Android) keeps airplane mode off for the
 *          run, so the upload is attempted against the closed loopback
 *          endpoint rather than refused for want of a network.
 *
 * EVT-18 (the wrapper's listener runs before the app's) is not here: the
 * example has no native app listener to order against, and the bridge does
 * not log its own delivery. Jest pins the order.
 */
import { airplane } from './bundles';
import { apiMarker, jsonAfter } from './api-markers';
import { ON_ANDROID, ON_IOS, TARGET_NAME, clearBundles, describeDevice, report, startRun, stopApp } from './harness';
import { iosTarget } from './device';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, adbStatus, pidOf } from './scenario';

jest.setTimeout(6 * 60_000);

const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';
const itCrash = ON_SIMULATOR ? it.skip : it;
const ONLINE = process.env.E2E_UPLOAD_ONLINE === '1';

async function waitForExit(timeoutMs: number): Promise<boolean> {
  if (ON_IOS) {
    // The console attachment ends with the process (harness IosLaunch).
    await new Promise(resolve => setTimeout(resolve, 6_000));
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await pidOf()) === undefined) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

describeDevice(`lifecycle events on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-09');
  });

  afterAll(() => endRetainingSuite(log));

  itCrash('[EVT-07] RelaunchedAfterCrash fires once at the launch after a crash', async () => {
    await clearBundles();
    const crash = await startRun('api-crash');
    await apiMarker(log!, 'crash crashing', crash.scenario.nonce, 20_000, crash.start);
    expect(await waitForExit(20_000)).toBe(true);
    await stopApp();
    const after = await startRun('api-after-crash');
    const summary = await apiMarker(log!, 'after-crash summary', after.scenario.nonce, 40_000, after.start);
    const events = jsonAfter<string[]>(summary.text, 'events');
    report('events after the crash', events);
    report(
      'scenario starts and RN loads since the crash run',
      log!.all(/BUGSEE_E2E scenario=|Running "BareExample"|BUGSEE_E2E api after-crash event/, crash.start).map(line => line.text.trim().slice(-160)),
    );
    expect(events.filter(e => e === 'RelaunchedAfterCrash')).toHaveLength(1);
    // At this launch: iOS sends it between Launching and Launched.
    expect(events).toEqual(expect.arrayContaining(['Launching', 'Launched']));
    await stopApp();
  });

  it('[EVT-08][EVT-09] BeforeReportShown, then AfterReportShown once the dialog is on screen', async () => {
    const run = await startRun('api-dialog-events');
    const nonce = run.scenario.nonce;
    const before = await apiMarker(log!, 'dialog-events event', `${nonce} name=BeforeReportShown`, 20_000, run.start);
    const after = await apiMarker(log!, 'dialog-events event', `${nonce} name=AfterReportShown`, 20_000, before.index, run.start);
    // Nothing dismissed the dialog: both SDKs document AfterReportShown as
    // "dispatched when reporting UI is shown" (Android LifecycleEvents,
    // iOS BugseeConstants.h), and fire it as the UI appears.
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const all = log!.all(new RegExp(`BUGSEE_E2E api dialog-events event nonce=${nonce} name=(Before|After)ReportShown`), run.start);
    report('report-shown events', all.map(line => line.text.trim()));
    expect(after.index).toBeGreaterThan(before.index);
    expect(all.filter(line => /name=AfterReportShown/.test(line.text))).toHaveLength(1);
    if (ON_ANDROID) {
      // The first Back hides the keyboard, the second closes the dialog.
      await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    }
    await stopApp();
  });

  it('[EVT-15][EVT-16] a failed upload is announced with the report id', async () => {
    await clearBundles();
    if (ON_ANDROID && ONLINE) {
      await airplane(false);
    }
    try {
      const run = await startRun('api-upload-events');
      const summary = await apiMarker(log!, 'upload-events summary', run.scenario.nonce, 70_000, run.start);
      const events = jsonAfter<string[]>(summary.text, 'events');
      report(`upload events (${ON_ANDROID ? (ONLINE ? 'online, dead endpoint' : 'airplane mode') : 'dead endpoint'})`, events);
      const assembled = events.find(e => e.startsWith('AfterReportAssembled:'));
      expect(assembled).toBeDefined();
      const id = assembled!.split(':')[1];
      const failed = events.filter(e => /^(ReportUploadFailed|ReportUploadFailedWithFutureRetry):/.test(e));
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every(e => e.endsWith(`:${id}`))).toBe(true);
    } finally {
      await stopApp();
      if (ON_ANDROID && ONLINE) {
        await airplane(true);
      }
    }
  });
});
