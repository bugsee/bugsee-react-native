/**
 * Campaign N-15: upgrading the app over data the previous build left
 * (FLOW-37..39, MX-UPG). Nothing is wiped between the builds: the previous
 * build is installed and seeded, the next is installed over it keeping the
 * data (install.ts `installKeepingData`), and the next build's first launch
 * is observed. Opt in by naming the path and both builds:
 *
 *   E2E_UPGRADE_PATH   U-01  previous campaign build -> campaign build
 *                            (iOS: 7.0.0-beta4 -> beta5; Android: the
 *                            previous campaign build of the same 7.3.0 SDK)
 *                      U-02  campaign build -> the same with a higher app
 *                            version (Android versionCode, iOS
 *                            CFBundleShortVersionString + CFBundleVersion)
 *                      U-03  a 6.x `react-native-bugsee` (v2) build of the
 *                            same application id -> 7.x (Android only)
 *   E2E_UPGRADE_FROM   the previous build: an .apk (Android) or .app (iOS)
 *   E2E_UPGRADE_TO     the build under test, same form
 *   E2E_UPGRADE_FROM_SDK  iOS: the SDK version the previous build launches
 *                      (U-01: 7.0.0-beta4); default the pin
 *
 * U-01 / U-02 seed with scenarios every campaign build has: `attributes`
 * (attributes and a user id, then an upload that stays on the device: a
 * pending report), one more launch and a minute to settle, and
 * `native-crash-segv` (a crash left for the next launch to claim). The next
 * build then runs `flow-upgrade-observe`. Expected:
 *
 *   [FLOW-37] the pending report is still there; the attributes and the user
 *             id read back exactly as the previous build left them.
 *   [FLOW-37][FLOW-38] the crash the previous build left, by the SDK's rule:
 *             iOS (bugsee-cocoa #194) drops a report another build left
 *             (a different SDK version or CFBundleShortVersionString): the
 *             report the crash queued is gone from PLCrashReporter's queue
 *             after the next build's launch and no crash bundle is filed (the
 *             SDK logs the drop only to its internal log, so the queue is the
 *             witness); Android recovers it: one crash bundle.
 *   [FLOW-39] U-03: the 6.x build runs offline (airplane mode) and is
 *             stopped; 7.x launches over its data, reaches Launched, does not
 *             crash and is still running 10 s later. What the 6.x build left
 *             is recorded before and after (INFO).
 *
 * Retention as the retaining suites: airplane mode on Android, the dead
 * endpoint on iOS. `E2E_NO_WIPE=1` (harness.ts) is the same no-wipe mode for
 * running any other suite across an upgrade by hand.
 */
import { type PulledBundle, listAndroidBundles, listIosBundles, pullAndroidBundles, pullIosBundles } from './bundles';
import { ANDROID_PACKAGE, iosTarget } from './device';
import { markerJson, parseUpgradePath } from './flow-config';
import { ON_ANDROID, ON_IOS, TARGET_NAME, clearBundles, describeDevice, must, report, startRun, stopApp } from './harness';
import { androidDataFiles, androidPackageInfo, iosAppInfo, installKeepingData } from './install';
import { crashQueue, holdsReport } from './ios-container';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, adb, pidOf } from './scenario';

jest.setTimeout(15 * 60_000);

const PATH = parseUpgradePath(process.env.E2E_UPGRADE_PATH);
const FROM = process.env.E2E_UPGRADE_FROM ?? '';
const TO = process.env.E2E_UPGRADE_TO ?? '';
const FROM_SDK = process.env.E2E_UPGRADE_FROM_SDK;
/**
 * Android and the iPhone. Not the simulator: its SDK slice has no crash
 * reporter (ios-native-crash.test.ts), so the crash half cannot run there.
 */
const ENABLED = PATH !== undefined && (ON_ANDROID || (ON_IOS && iosTarget() === 'device'));
if (ENABLED && (FROM === '' || TO === '')) {
  throw new Error('E2E_UPGRADE_PATH is set: E2E_UPGRADE_FROM and E2E_UPGRADE_TO must name both builds');
}
const describeUpgrade = ENABLED ? describeDevice : describe.skip;
const describeSeeded = ENABLED && PATH !== 'U-03' ? describe : describe.skip;
const describeLegacy = ENABLED && PATH === 'U-03' && ON_ANDROID ? describe : describe.skip;

const DROPPED = /Dropped a crash report left by another build/;

/** How long the previous build's state settles before the update (U-01, U-02). */
const SETTLE_MS = 60_000;

/**
 * Known, intermittent (iOS 7.0.0-beta5 on the XS): attributes set seconds
 * before the app is updated are sometimes gone after the update
 * (getAllAttributes is {}) while the user id set with them is kept. Lost in
 * 6 of 7 updates that came within seconds of the write (U-01 x3, U-02 x2, the
 * same build reinstalled x1; kept once, U-02 r3), never with a launch and a
 * minute in between (0 of 3). The SDK keeps attributes in NSUserDefaults
 * (`bugsee_userAttributesKey`), whose cfprefsd copy an install can discard
 * before it reaches disk. Intermittent, so a plain `it` (a product-caused
 * intermittent failure is FAIL, plan 4.1), not `it.failing`. Issue: to file
 * (bugsee-cocoa), sdk-issues-filed.md.
 */
const itQuickUpdate = it;

async function listBundleFiles(): Promise<string[]> {
  return ON_IOS ? listIosBundles() : listAndroidBundles();
}

/** Every bundle on the device, whatever SDK build wrote it (no pin check: one is the previous build's). */
async function pullAll(): Promise<PulledBundle[]> {
  return ON_IOS ? pullIosBundles() : pullAndroidBundles();
}

/** Waits until the app process is gone (a crash), up to `ms`. */
async function awaitAndroidDeath(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await pidOf()) === undefined) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function buildInfo(artifact: string): Promise<Record<string, unknown>> {
  if (ON_IOS) {
    return { artifact, ...iosAppInfo(artifact) };
  }
  return { artifact, installed: await androidPackageInfo() };
}

describeUpgrade(`${PATH ?? 'upgrade'} over the previous build's data on ${TARGET_NAME} (N-15)`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-15');
  });

  afterAll(() => endRetainingSuite(log));

  describeSeeded('a seeded previous build', () => {
    let seedAll: unknown;
    let seedId: unknown;
    let seedBundles: string[] = [];
    let observed: { all: unknown; id: unknown };
    let observeStart = 0;
    let after: PulledBundle[] = [];
    let crashedLeft: string[] = [];
    let queueAfter: string[] = [];
    let aliveAfter = false;

    beforeAll(async () => {
      // 1. The previous build, from a clean start.
      await installKeepingData(FROM, ON_IOS);
      await clearBundles();
      report('previous build', await buildInfo(FROM));
      const fromSdk = { iosSdkVersion: FROM_SDK };

      // 2. Seed: attributes, a user id and a pending report.
      const seed = await startRun('attributes', fromSdk);
      const done = must(await log!.waitFor(/BUGSEE_E2E attr done /, 60_000, seed.start), 'the attributes seed finishing', seed.start);
      seedAll = JSON.parse(/BUGSEE_E2E attr all (.*)$/.exec(must(log!.all(/BUGSEE_E2E attr all /, seed.start, done.index + 1).at(-1), 'the seeded attributes', seed.start).text)![1]!);
      seedId = JSON.parse(/BUGSEE_E2E attr id-final (.*)$/.exec(must(log!.all(/BUGSEE_E2E attr id-final /, seed.start, done.index + 1).at(-1), 'the seeded user id', seed.start).text)![1]!);
      const deadline = Date.now() + 60_000;
      while ((seedBundles = await listBundleFiles()).length < 1 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      report('seed', { all: seedAll, id: seedId, bundles: seedBundles });

      // An update comes long after the app set its attributes: one more
      // launch, then a minute, so what the previous build wrote has settled
      // (an update seconds after the write is the separate case below).
      await startRun('flow-cold', fromSdk);
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

      // 3. A crash the next launch has to deal with.
      const crash = await startRun('native-crash-segv', fromSdk);
      must(await log!.waitFor(/BUGSEE_E2E native crashing kind=segv/, 20_000, crash.start), 'the native crash call', crash.start);
      const died = ON_IOS
        ? await Promise.race([crash.launch!.ended.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30_000))])
        : await awaitAndroidDeath(30_000);
      expect(died).toBe(true);
      crashedLeft = ON_IOS ? await crashQueue() : [];
      report('left by the crash', { queue: crashedLeft });

      // 4. The next build over it, data kept; 5. its first launch.
      await installKeepingData(TO, ON_IOS);
      report('next build', await buildInfo(TO));
      const observe = await startRun('flow-upgrade-observe');
      observeStart = observe.start;
      const state = must(
        await log!.waitFor(new RegExp(`BUGSEE_E2E flow upgrade state all=.* nonce=${observe.scenario.nonce}`), 30_000, observe.start),
        'the next build reading its state',
        observe.start,
      );
      observed = { all: markerJson(state.text, 'all'), id: markerJson(state.text, 'id') };
      must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow upgrade done status=2 nonce=${observe.scenario.nonce}`), 30_000, state.index), 'the next build still Launched', observe.start);
      aliveAfter = ON_ANDROID ? (await pidOf()) !== undefined : !(observe.launch?.hasEnded() ?? true);
      queueAfter = ON_IOS ? await crashQueue() : [];
      after = await pullAll();
      report('after the upgrade', {
        observed,
        bundles: after.map(bundle => ({ file: bundle.file, type: bundle.request.type, summary: bundle.request.summary })),
        dropped: log!.all(DROPPED, observeStart).map(line => line.text.trim()),
        crashQueueAfter: queueAfter,
      });
    });

    it(`[N-15][FLOW-37] ${PATH}: the pending report the previous build left is still on the device`, () => {
      expect(seedBundles.length).toBeGreaterThan(0);
      const files = after.map(bundle => bundle.file);
      for (const file of seedBundles) {
        expect(files).toContain(file);
      }
    });

    it(`[N-15][FLOW-37] ${PATH}: the attributes and the user id read back as the previous build left them`, () => {
      expect(observed.all).toEqual(seedAll);
      expect(observed.id).toEqual((seedId as { value?: unknown }).value);
    });

    it(`[N-15][FLOW-37][FLOW-38] ${PATH}: the next build launches and handles the previous build's crash by the SDK's rule`, () => {
      expect(aliveAfter).toBe(true);
      const crashes = after.filter(bundle => bundle.request.type === 'crash');
      const dropped = log!.all(DROPPED, observeStart);
      report('drop line (BGSInternalLog; seen only with the SDK\'s internal log on)', dropped.map(line => line.text.trim()));
      if (ON_IOS) {
        // bugsee-cocoa #194: a report another build left is dropped
        // (BGSDropPendingReportsOfAnotherBuild unlinks it): the crash left a
        // report, the next build's launch took it out of the queue and filed
        // no crash.
        expect(holdsReport(crashedLeft)).toBe(true);
        expect(holdsReport(queueAfter)).toBe(false);
        expect(crashes).toHaveLength(0);
      } else {
        expect(crashes).toHaveLength(1);
        expect(crashes[0]!.captures.get('crash') ?? '').toContain('SIGSEGV');
      }
    });
  });

  describeSeeded('an update seconds after the previous build set its attributes', () => {
    let seedAll: unknown;
    let observedAll: unknown;

    beforeAll(async () => {
      await installKeepingData(FROM, ON_IOS);
      await clearBundles();
      const seed = await startRun('attributes', { iosSdkVersion: FROM_SDK });
      const done = must(await log!.waitFor(/BUGSEE_E2E attr done /, 60_000, seed.start), 'the attributes seed finishing', seed.start);
      seedAll = JSON.parse(/BUGSEE_E2E attr all (.*)$/.exec(must(log!.all(/BUGSEE_E2E attr all /, seed.start, done.index + 1).at(-1), 'the seeded attributes', seed.start).text)![1]!);
      await installKeepingData(TO, ON_IOS);
      const observe = await startRun('flow-upgrade-observe');
      const state = must(
        await log!.waitFor(new RegExp(`BUGSEE_E2E flow upgrade state all=.* nonce=${observe.scenario.nonce}`), 30_000, observe.start),
        'the next build reading its state',
        observe.start,
      );
      observedAll = markerJson(state.text, 'all');
      report('quick update', { seedAll, observedAll });
    });

    itQuickUpdate(`[N-15][FLOW-37] ${PATH}: attributes set seconds before the update read back after it`, () => {
      expect(observedAll).toEqual(seedAll);
    });
  });

  describeLegacy('a 6.x build (react-native-bugsee v2) under it', () => {
    let before: string[] = [];
    let afterFiles: string[] = [];
    let launchedLine = '';
    let crashed: string[] = [];
    let alive = false;

    beforeAll(async () => {
      await installKeepingData(FROM, false);
      await adb('shell', 'pm', 'clear', ANDROID_PACKAGE);
      report('6.x build', await buildInfo(FROM));
      // Airplane mode is on (beginRetainingSuite): the 6.x SDK reaches nobody.
      const start = log!.mark();
      // Its launcher activity, whatever class the 6.x app named it.
      await adb('shell', 'monkey', '-p', ANDROID_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');
      await new Promise(resolve => setTimeout(resolve, 20_000));
      const pid6 = await pidOf();
      report('6.x running', { pid: pid6, lines: log!.all(/BUGSEE_E2E 6x|Bugsee Android SDK|FATAL EXCEPTION/, start).slice(0, 20).map(line => line.text.trim()) });
      expect(pid6).toBeDefined();
      must(await log!.waitFor(/BUGSEE_E2E 6x launched/, 1_000, start), 'the 6.x app launching its SDK', start);
      await stopApp();
      before = await androidDataFiles();
      report('left by 6.x', before);

      await installKeepingData(TO, false);
      report('7.x build', await buildInfo(TO));
      const observe = await startRun('flow-upgrade-observe');
      launchedLine = observe.launched.text.trim();
      must(await log!.waitFor(new RegExp(`BUGSEE_E2E flow upgrade done status=2 nonce=${observe.scenario.nonce}`), 40_000, observe.start), '7.x still Launched 10 s later', observe.start);
      alive = (await pidOf()) !== undefined;
      crashed = log!.all(/FATAL EXCEPTION|Fatal signal/, observe.start).map(line => line.text.trim());
      afterFiles = await androidDataFiles();
      report('after 7.x', { files: afterFiles, crashed });
    });

    it('[N-15][FLOW-39] U-03: 7.x launches over 6.x data, reaches Launched and keeps running', () => {
      expect(launchedLine).toMatch(/BUGSEE_E2E status=2/);
      expect(crashed).toEqual([]);
      expect(alive).toBe(true);
      expect(before.length).toBeGreaterThan(0);
    });
  });
});
