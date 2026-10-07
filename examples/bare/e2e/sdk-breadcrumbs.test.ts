/**
 * N-11: breadcrumbs the SDK writes on its own (FLOW-15), and the video of an
 * ordinary upload (FLOW-19).
 *
 * Scenario `api-sdk-crumbs` (scenarios/api-ui.ts) launches with
 * `capture.breadcrumbs` on, shows a white screen, adds one breadcrumb of its
 * own, and uploads 20 s later. In between, this test sends the Android app
 * to the background and back (the Home key, then an activity start), so the
 * SDK has an app-lifecycle change to record. iOS is not driven: there the
 * crumbs are whatever the launch produced (the SDK's own navigation and
 * lifecycle crumbs).
 *
 * Video: decodable h264, more than one frame, and not black -- the white
 * stage makes the centre of at least one frame bright.
 */
import { type PulledBundle, captureEvents } from './bundles';
import { apiMarker } from './api-markers';
import { ANDROID_COMPONENT } from './device';
import { ON_ANDROID, type Run, TARGET_NAME, awaitBundles, describeDevice, report, startRun, stopApp } from './harness';
import { LUMA_BRIGHT_MIN, frameLumas, probeCodec } from './media';
import { beginRetainingSuite, endRetainingSuite, frameCount } from './observe';
import { type DeviceLog, adbStatus } from './scenario';

jest.setTimeout(5 * 60_000);

async function backgroundAndBack(): Promise<string> {
  if (ON_ANDROID) {
    await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await adbStatus('shell', 'am', 'start', '-n', ANDROID_COMPONENT);
    return 'home key, then the activity again';
  }
  // iOS is not driven: switching apps on the simulator suspends the app
  // and loses the run's console, and no other app may be opened on the
  // iPhone. iOS records its navigation and lifecycle crumbs at launch.
  return 'not driven (iOS)';
}

describeDevice(`SDK breadcrumbs and a plain upload's video on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let bundle: PulledBundle;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-11');
    run = await startRun('api-sdk-crumbs');
    const nonce = run.scenario.nonce;
    await apiMarker(log, 'crumbs ready', nonce, 20_000, run.start);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    report('driven', await backgroundAndBack());
    // A Debug app coming back from the background may be reloaded by Metro
    // (the scenario then starts over and uploads 20 s after its new start).
    await apiMarker(log, 'crumbs uploaded', nonce, 90_000, run.start);
    bundle = (await awaitBundles(1, 60_000)).find(b => b.request.summary === `api-crumbs-${nonce}`)!;
    await stopApp();
  });

  afterAll(() => endRetainingSuite(log));

  /**
   * Android 7.3.0 records no breadcrumb of its own with capture.breadcrumbs
   * on -- none at launch, none for the app going to the background and back
   * (Home, then the activity) -- in every run on the WOD_LX1 (2026-10-07),
   * while its producers (BreadcrumbApp app.lifecycle, BreadcrumbUI) exist.
   * iOS records ui.screen and ui.lifecycle crumbs. To file (bugsee-android).
   */
  (ON_ANDROID ? it.failing : it)(`[FLOW-15] the report carries breadcrumbs the SDK wrote itself, next to the app's own${ON_ANDROID ? ' [known: Android 7.3.0 records no SDK breadcrumbs (to file)]' : ''}`, () => {
    const crumbs = captureEvents(bundle, 'breadcrumbs');
    const own = crumbs.filter(c => JSON.stringify(c).includes(`api-own-crumb ${run.scenario.nonce}`));
    const sdk = crumbs.filter(c => !JSON.stringify(c).includes('api-own-crumb'));
    report('breadcrumbs', crumbs.map(c => ({ type: c.type, category: c.category, message: String(c.message ?? '').slice(0, 80), level: c.level })));
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(sdk.length).toBeGreaterThan(0);
  });

  it('[FLOW-19] an ordinary upload carries a decodable video of more than one frame that is not black', async () => {
    const videos = bundle.binaries.get('video') ?? [];
    expect(videos).toHaveLength(1);
    expect(await probeCodec(videos[0]!)).toBe('h264');
    expect(await frameCount(videos[0]!)).toBeGreaterThan(1);
    const lumas = await frameLumas(videos[0]!);
    const brightest = Math.max(...lumas.map(f => f.luma));
    report('video', { frames: lumas.length, brightest });
    expect(brightest).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
  });
});
