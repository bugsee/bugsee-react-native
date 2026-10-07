/**
 * N-02: `Bugsee.attach()` (API-07) and the Android manifest auto-launch
 * (FLOW-02, PLG-07a).
 *
 * Scenario `api-attach` (scenarios/api-lifecycle.ts), before any launch():
 * getStatus, attach(), getStatus, getLaunchOptions.
 *
 *   E2E_ANDROID_AUTOLAUNCH=1  the installed Android build was made with
 *     `-PbugseeE2eAutoLaunch=true` (android/app/build.gradle), so the SDK
 *     launched itself from `com.bugsee.app-token` meta-data (the placeholder
 *     token, the dead endpoint) before any JS ran. The scenario never calls
 *     launch(): attach() must wire the JS layer to that session -- a console
 *     line and a handled error reach the report -- and start no second one.
 *     Reinstall the ordinary build afterwards: every other suite launches from
 *     JS and would find the SDK already running.
 *   otherwise (iOS, which has no auto-launch, or an ordinary Android build)
 *     nothing launched: attach() resolves, starts nothing, and the app's own
 *     launch() that follows still reaches Launched.
 *
 * Markers:
 *   BUGSEE_E2E api attach before nonce=<n> status=<s>
 *   BUGSEE_E2E api attach done nonce=<n> status=<s> result=<settled> detectCrash=<b> keys=<k>
 *   BUGSEE_E2E api attach idle nonce=<n> status=<s>          (nothing launched)
 *   BUGSEE_E2E api attach uploaded nonce=<n>                  (manifest build)
 */
import { type PulledBundle, captureEvents } from './bundles';
import { type Settled, apiMarker, jsonAfter, wordAfter } from './api-markers';
import { ON_ANDROID, ON_IOS, type Run, TARGET_NAME, awaitBundles, describeDevice, report, startRun } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';

jest.setTimeout(5 * 60_000);

const AUTOLAUNCH = ON_ANDROID && process.env.E2E_ANDROID_AUTOLAUNCH === '1';
const itManifest = AUTOLAUNCH ? it : it.skip;
const itNothingLaunched = AUTOLAUNCH ? it.skip : it;

describeDevice(`attach() on ${TARGET_NAME}${AUTOLAUNCH ? ' (manifest auto-launch build)' : ''}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let before: LogLine;
  let done: LogLine;
  let idle: LogLine | undefined;
  let bundles: PulledBundle[] = [];

  beforeAll(async () => {
    log = await beginRetainingSuite('N-02');
    run = await startRun('api-attach');
    const nonce = run.scenario.nonce;
    before = await apiMarker(log, 'attach before', nonce, 20_000, run.start);
    done = await apiMarker(log, 'attach done', nonce, 20_000, before.index, run.start);
    report('before', before.text.trim());
    report('done', done.text.trim());
    if (AUTOLAUNCH) {
      await apiMarker(log, 'attach uploaded', nonce, 30_000, done.index, run.start);
      bundles = await awaitBundles(2, 60_000);
      report('bundles', bundles.map(b => ({ type: b.request.type, summary: b.request.summary })));
    } else {
      idle = await apiMarker(log, 'attach idle', nonce, 20_000, done.index, run.start);
      report('idle', idle.text.trim());
    }
  });

  afterAll(() => endRetainingSuite(log));

  itNothingLaunched('[API-07] attach() with nothing launched resolves, starts nothing, and launch() still works after it', () => {
    expect(wordAfter(before.text, 'status')).toBe('0');
    expect(jsonAfter<Settled>(done.text, 'result')).toEqual({ ok: true, value: null });
    expect(wordAfter(done.text, 'status')).toBe('0');
    expect(wordAfter(idle!.text, 'status')).toBe('0');
    // startRun saw the app's own launch() reach Launched after all this.
    expect(run.launched.index).toBeGreaterThan(idle!.index);
  });

  itManifest('[API-07][FLOW-02] the manifest launched the SDK before any JS launch(), and attach() resolves on it', () => {
    expect(['1', '2']).toContain(wordAfter(before.text, 'status'));
    expect(jsonAfter<Settled>(done.text, 'result')).toEqual({ ok: true, value: null });
    expect(wordAfter(done.text, 'status')).toBe('2');
    // detect.crash read from native (the default, on).
    expect(wordAfter(done.text, 'detectCrash')).toBe('true');
  });

  itManifest('[API-07][FLOW-02] there is one session: one SDK start, and no second launch was attempted', () => {
    const banners = log!.all(/Bugsee Android SDK \S+ \[[0-9a-f]+\]/, run.start);
    const ignored = log!.all(/Bugsee is already running, so these options are IGNORED/, run.start);
    report('banners', banners.map(line => line.text.trim()));
    expect(banners).toHaveLength(1);
    expect(ignored).toHaveLength(0);
  });

  itManifest('[API-07][FLOW-02] attach() installed the JS handlers and console capture: a handled error and a console line reach reports', () => {
    const nonce = run.scenario.nonce;
    const errors = bundles.filter(b => b.request.type === 'error');
    expect(errors).toHaveLength(1);
    const upload = bundles.find(b => b.request.summary === `api-attach-${nonce}`);
    expect(upload).toBeDefined();
    const console = captureEvents(upload!, 'log').filter(e => e.message === `api-attach console ${nonce}`);
    report('console line', console);
    expect(console).toHaveLength(1);
    expect(console[0]!.source).toBe(98);
    // The wrapper registered itself (ReactNativeWrapperInitProvider), with no launch() from JS.
    const sdk = (upload!.request.environment as { sdk?: { wrapper?: { type?: string } } }).sdk;
    expect(sdk?.wrapper?.type).toBe('react_native');
  });

  if (ON_IOS) {
    it.skip('[API-07] manifest auto-launch: Android only (iOS has no auto-launch)', () => {});
  }
});
