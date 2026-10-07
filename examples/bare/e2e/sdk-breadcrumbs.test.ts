/**
 * N-11: breadcrumbs the SDK writes on its own (FLOW-15), and the video of an
 * ordinary upload (FLOW-19).
 *
 * Scenario `api-sdk-crumbs` (scenarios/api-ui.ts) launches with
 * `capture.breadcrumbs` on, shows a white screen, adds one breadcrumb of its
 * own, and uploads 20 s later. In between, this test sends the app to the
 * background and back -- Android with the Home key and an activity start,
 * the simulator by opening Settings and relaunching the app -- so the SDK has
 * an app-lifecycle change to record. The iPhone is not driven (no other app
 * may be opened on it): there the crumbs are whatever the launch produced.
 *
 * Video: decodable h264, more than one frame, and not black -- the white
 * stage makes the centre of at least one frame bright.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type PulledBundle, captureEvents } from './bundles';
import { apiMarker } from './api-markers';
import { ANDROID_COMPONENT, IOS_BUNDLE_ID, IOS_SIMULATOR_ID, iosTarget } from './device';
import { ON_ANDROID, ON_IOS, type Run, TARGET_NAME, awaitBundles, describeDevice, report, startRun, stopApp } from './harness';
import { LUMA_BRIGHT_MIN, frameLumas, probeCodec } from './media';
import { beginRetainingSuite, endRetainingSuite, frameCount } from './observe';
import { type DeviceLog, adbStatus } from './scenario';

const execFileAsync = promisify(execFile);

jest.setTimeout(5 * 60_000);

const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';

async function backgroundAndBack(): Promise<string> {
  if (ON_ANDROID) {
    await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await adbStatus('shell', 'am', 'start', '-n', ANDROID_COMPONENT);
    return 'home key, then the activity again';
  }
  if (ON_SIMULATOR) {
    await execFileAsync('xcrun', ['simctl', 'launch', IOS_SIMULATOR_ID, 'com.apple.Preferences']);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await execFileAsync('xcrun', ['simctl', 'launch', IOS_SIMULATOR_ID, IOS_BUNDLE_ID]);
    return 'Settings opened, then the app again';
  }
  return 'not driven (iPhone)';
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
    await apiMarker(log, 'crumbs uploaded', nonce, 40_000, run.start);
    bundle = (await awaitBundles(1, 60_000)).find(b => b.request.summary === `api-crumbs-${nonce}`)!;
    await stopApp();
  });

  afterAll(() => endRetainingSuite(log));

  it('[FLOW-15] the report carries breadcrumbs the SDK wrote itself, next to the app\'s own', () => {
    const crumbs = captureEvents(bundle, 'breadcrumbs');
    const own = crumbs.filter(c => JSON.stringify(c).includes(`api-own-crumb ${run.scenario.nonce}`));
    const sdk = crumbs.filter(c => !JSON.stringify(c).includes('api-own-crumb'));
    report('breadcrumbs', crumbs.map(c => ({ type: c.type, category: c.category, message: String(c.message ?? '').slice(0, 80), level: c.level })));
    expect(own).toHaveLength(1);
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
