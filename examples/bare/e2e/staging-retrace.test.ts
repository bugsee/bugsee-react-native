/**
 * Campaign S-4 (F7): an Android Java crash from an R8-obfuscated build, so the
 * dashboard's frames come from retrace with the uploaded mapping.
 *
 * Why its own file and its own build: AGP turns every R8 optimisation and all
 * obfuscation off for a debuggable build ("BuildType 'release' is both
 * debuggable and has 'isMinifyEnabled' set to true"). The debuggable Release
 * that staging.test.ts runs on (`-PbugseeE2eDebuggable=true`, for `run-as`)
 * therefore ships readable frames (`BugseeModule.java:493`), and its Java
 * crash case never exercises retrace. This case needs the NON-debuggable
 * minified Release:
 *
 *   (cd examples/bare/android && ./gradlew :app:assembleRelease \
 *      -PbugseeE2eMinify=true -PreactNativeArchitectures=arm64-v8a)
 *   adb -s <serial> install -r examples/bare/android/app/build/outputs/apk/release/app-release.apk
 *
 * and the same switches as staging.test.ts (`E2E_RELEASE=1` plus
 * `E2E_STAGING=1` for the lane, or `E2E_STAGING_DRYRUN=1` against the dead
 * endpoint). Without `run-as` nothing on the device can be listed, so:
 *   - the build is checked first: `run-as` must be refused (not debuggable),
 *     and the crash's own logcat trace must show the obfuscated frame
 *     (`BugseeModule.testCrash(r8-map-id-…)`, never `BugseeModule.java`) --
 *     the proof that retrace has something to do;
 *   - the app's data is cleared with `pm clear` instead of deleting the
 *     bundles directory, and delivery is judged from the app's event marks
 *     (staging: `AfterReportUploaded`, once per report id; dry run: an upload
 *     failure), not from a bundle listing.
 * The controller then checks on staging that the issue's frames read
 * `BugseeModule.java:<line>` (retraced), from the `STAGING-EVIDENCE` line.
 */
import { ANDROID_PACKAGE } from './device';
import { CAMPAIGN_MODE, ON_ANDROID, RELEASE, type Run, TARGET_NAME, describeDevice, must, report, startDeviceLog, startRun, stopApp, stopDeviceLog } from './harness';
import { ensureOnline } from './online';
import { TEST_CRASH_FRAME, isObfuscatedPosition, refusedRunAs } from './retrace';
import { type DeviceLog, adbStatus, resetScenario } from './scenario';

jest.setTimeout(15 * 60_000);

const STAGING = CAMPAIGN_MODE === 'staging';
const DRY_RUN = !STAGING && process.env.E2E_STAGING_DRYRUN === '1';
const describeRetrace = (STAGING || DRY_RUN) && ON_ANDROID && RELEASE ? describeDevice : describe.skip;

/** What the upload of a report must end in, in this mode (as staging.test.ts). */
const DELIVERED = STAGING ? /^AfterReportUploaded$/ : /^(ReportUploadFailed|ReportUploadFailedWithFutureRetry)$/;
const OUTCOME = /^(AfterReportUploaded|ReportUploadFailed|ReportUploadFailedWithFutureRetry)$/;

describeRetrace(`S-4 retrace on a non-debuggable R8 build, ${TARGET_NAME} (${STAGING ? 'STAGING' : 'dry run'})`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await startDeviceLog('S-4', 'S-4');
    await ensureOnline();
  });

  afterAll(async () => {
    await stopApp();
    await adbStatus('shell', 'pm', 'clear', ANDROID_PACKAGE).catch(() => undefined);
    stopDeviceLog(log);
    resetScenario();
  });

  function outcomes(runs: readonly Run[], from: number): Array<{ name: string; id: string }> {
    return runs.flatMap(run =>
      log!
        .all(new RegExp(`BUGSEE_E2E stg event name=(\\S+) id=(\\S+) nonce=${run.scenario.nonce}`), from)
        .map(line => {
          const [, name, id] = /name=(\S+) id=(\S+)/.exec(line.text)!;
          return { name: name!, id: id! };
        })
        .filter(event => OUTCOME.test(event.name)),
    );
  }

  it('[N-19][S-4][FLOW-26] an obfuscated Java crash is recovered and uploaded for retrace', async () => {
    const runAs = await adbStatus('shell', 'run-as', ANDROID_PACKAGE, 'true');
    report('run-as', runAs.output.trim());
    // A debuggable build is not obfuscated: this case would prove nothing.
    expect(refusedRunAs(runAs.output)).toBe(true);

    await stopApp();
    const cleared = await adbStatus('shell', 'pm', 'clear', ANDROID_PACKAGE);
    expect(cleared.output).toMatch(/Success/);

    const crash = await startRun('stg-native-exception');
    must(await log!.waitFor(new RegExp(`BUGSEE_E2E stg crashing kind=native-exception nonce=${crash.scenario.nonce}`), 20_000, crash.start), 'the crash call', crash.start);
    const frame = must(await log!.waitFor(TEST_CRASH_FRAME, 20_000, crash.start), 'the crash trace in logcat', crash.start);
    const position = TEST_CRASH_FRAME.exec(frame.text)![1]!;
    report('raw crash frame', frame.text.trim());
    expect(isObfuscatedPosition(position)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await stopApp();

    const observe = await startRun('stg-observe');
    const runs = [crash, observe];
    const deadline = Date.now() + 180_000;
    while (!outcomes(runs, crash.start).some(event => DELIVERED.test(event.name)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    // Let a duplicate delivery show itself before counting.
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const seen = outcomes(runs, crash.start);
    report('STAGING-EVIDENCE', {
      id: 'S-4',
      mode: STAGING ? 'staging' : 'dry-run',
      build: 'release, minified, not debuggable',
      target: TARGET_NAME,
      nonce: crash.scenario.nonce,
      observeNonce: observe.scenario.nonce,
      search: `campaign ${crash.scenario.nonce}`,
      rawFrame: `BugseeModule.testCrash(${position})`,
      outcomes: seen.map(event => `${event.name}:${event.id}`),
    });
    expect(seen.filter(event => DELIVERED.test(event.name)).length).toBeGreaterThan(0);
    const delivered = seen.filter(event => event.name === 'AfterReportUploaded').map(event => event.id);
    expect(new Set(delivered).size).toBe(delivered.length);
  });
});
