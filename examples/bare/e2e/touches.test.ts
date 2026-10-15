/**
 * A report carries the touches the person made: tap the example app, swipe
 * it, take a report, and read the `input` capture out of the bundle.
 *
 * Scenario `touch-capture` (scenarios/touches.ts) logs `ready`, waits 20 s,
 * uploads `touch-capture-<nonce>` and logs `uploaded`. In that window this
 * file drives `adb shell input` with three taps and one swipe at known pixels,
 * and the bundle's `input` capture (spec: sdk/reporting/bundle/input.md) must
 * show them: a `begin` and an `end` per tap, `move`s for the swipe, and
 * coordinates in dp (the pixel divided by the display density).
 *
 * Android: known SDK bug https://github.com/bugsee/bugsee-android/issues/267.
 * The SDK decides its touch overlay is already installed with
 * `findViewById(View.generateViewId())`, and React Native's root view has the
 * id 1 as well, so the overlay is never added and the bundle has no `input`
 * capture at all. The touch case is `it.failing` there until a fixed SDK is
 * pinned: a fix then shows up as "it.failing passed". The preconditions (the
 * bundle exists, the video was recorded) are plain `it`, so the pin cannot
 * hide a broken run.
 *
 * iOS: skipped. Nothing in this harness can drive a tap on the simulator (no
 * idb, no XCUITest runner; operator.ts says the harness never taps), and
 * taking over the Simulator window is not an option.
 *
 * Retention is airplane mode (bundles.ts) on top of the placeholder token's
 * dead endpoint. Preconditions as for the other Android suites.
 */
import { type PulledBundle, airplane, captureEvents, removePulledBundles } from './bundles';
import {
  ON_ANDROID,
  ON_IOS,
  type Run,
  TARGET_NAME,
  awaitBundles,
  clearBundles,
  describeDevice,
  escape,
  must,
  report,
  startDeviceLog,
  startRun,
  stopApp,
  stopDeviceLog,
} from './harness';
import { type DeviceLog, adb, resetScenario } from './scenario';
import { bundleBySummary, effectiveDisplaySize } from './screen';

jest.setTimeout(6 * 60_000);

type Entry = Record<string, unknown>;

/** Where the taps land, as fractions of the display, and the swipe's ends. */
const TAPS: ReadonlyArray<readonly [number, number]> = [
  [0.25, 0.4],
  [0.5, 0.5],
  [0.75, 0.6],
];
const SWIPE = { from: [0.5, 0.75], to: [0.5, 0.3], ms: 400 } as const;

/** How far a recorded coordinate may be from tap pixel / density, in dp. */
const TOLERANCE_DP = 1;

/** The display density as a scale factor (`wm density` / 160). */
async function densityScale(): Promise<number> {
  const out = await adb('shell', 'wm', 'density');
  const override = /Override density: (\d+)/.exec(out);
  const physical = /Physical density: (\d+)/.exec(out);
  const dpi = Number((override ?? physical)?.[1]);
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new Error(`could not read the display density: ${out}`);
  }
  return dpi / 160;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Android's touch capture is broken for React Native apps (bugsee-android#267).
// iOS cannot be driven here at all: skip, do not pin.
const itTouches = ON_IOS ? it.skip : ON_ANDROID ? it.failing : it;

describeDevice(`touch capture on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let bundle: PulledBundle;
  let taps: Array<{ px: number; py: number }> = [];
  let density = 1;

  beforeAll(async () => {
    if (!ON_ANDROID) {
      return;
    }
    log = await startDeviceLog('touches', 'touches');
    await airplane(true);
    await clearBundles();
    run = await startRun('touch-capture');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    const ready = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E touches ready .*nonce=${nonce}`), 20_000, run.launched.index),
      'the touch-capture scenario being ready',
      run.start,
    );

    // The override, when set, is the space injected touches and the app use.
    const { width, height } = await effectiveDisplaySize();
    density = await densityScale();
    taps = TAPS.map(([fx, fy]) => ({ px: Math.round(fx * width), py: Math.round(fy * height) }));
    report('display', { width, height, density, taps });
    for (const { px, py } of taps) {
      await adb('shell', 'input', 'touchscreen', 'tap', String(px), String(py));
      await sleep(600);
    }
    const [x1, y1] = SWIPE.from.map((f, i) => Math.round(f * (i === 0 ? width : height)));
    const [x2, y2] = SWIPE.to.map((f, i) => Math.round(f * (i === 0 ? width : height)));
    await adb('shell', 'input', 'touchscreen', 'swipe', String(x1), String(y1), String(x2), String(y2), String(SWIPE.ms));

    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E touches uploaded nonce=${escape(nonce)}`), 40_000, ready.index),
      'the touch-capture scenario uploading',
      run.start,
    );
    const bundles = await awaitBundles(1);
    bundle = bundleBySummary(bundles, `touch-capture-${nonce}`);
    report('manifest types', bundle.manifest.files.map(f => f.type));
  });

  afterAll(async () => {
    if (!ON_ANDROID) {
      return;
    }
    try {
      await stopApp();
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        await airplane(false);
      } finally {
        const { removed, kept } = removePulledBundles();
        report('pulled bundle roots', { removed: removed.length, kept });
        stopDeviceLog(log);
        resetScenario();
      }
    }
  });

  (ON_ANDROID ? it : it.skip)('the run produced a report with a recorded video', () => {
    expect(bundle.manifest.files.some(f => f.type === 'video')).toBe(true);
  });

  itTouches(
    `the report holds the taps and the swipe as input events${
      ON_ANDROID ? ' [known: SDK never installs its touch overlay in RN apps (bugsee-android#267, https://github.com/bugsee/bugsee-android/issues/267)]' : ''
    }${ON_IOS ? ' [skipped on iOS: the harness has no way to tap the simulator]' : ''}`,
    () => {
      expect(bundle.manifest.files.some(f => f.type === 'input')).toBe(true);

      // Pointer events only. `adb shell input` injects with an unknown tool
      // type, which the SDK records as tool 5 ("other") rather than 1 (touch),
      // so the tool is not asserted; key events (tool 7) are left out.
      const events = captureEvents(bundle, 'input').filter(e => e.tool !== 7);
      report('input events', { count: events.length, first: events[0] });
      const ofType = (type: string): Entry[] => events.filter(e => e.type === type);
      const begins = ofType('begin');
      const ends = ofType('end');
      expect(begins.length).toBeGreaterThanOrEqual(TAPS.length + 1);
      expect(ends.length).toBeGreaterThanOrEqual(TAPS.length + 1);
      // Every gesture that began also ended, under one id (a missing id on
      // both sides would otherwise match).
      const endIds = new Set(ends.map(e => e.id));
      for (const begin of begins) {
        expect(begin.id).toEqual(expect.anything());
        expect(endIds.has(begin.id)).toBe(true);
      }
      // The swipe moved.
      expect(ofType('move').length).toBeGreaterThanOrEqual(1);

      // Each tap is recorded at its pixel divided by the density, in dp.
      for (const { px, py } of taps) {
        const ex = px / density;
        const ey = py / density;
        const hit = begins.find(
          b =>
            Math.abs((b.x as number) - ex) <= TOLERANCE_DP && Math.abs((b.y as number) - ey) <= TOLERANCE_DP,
        );
        report(`tap ${px},${py} -> expect ${ex.toFixed(2)},${ey.toFixed(2)}`, hit);
        expect(hit).toBeDefined();
      }
    },
  );
});
