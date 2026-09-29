/**
 * Final-review fix B1: a secure rectangle published from JS is served to the
 * Android SDK over the view it covers, in display pixels.
 *
 * JS measures with `measureInWindow`, which React Native makes relative to
 * the root's viewport offset -- and with edge-to-edge OFF that offset has the
 * status bar and cutout subtracted, so an unconverted rectangle lands that
 * many pixels too high and a strip of the secure view is recorded in the
 * clear. The example ships with `edgeToEdgeEnabled=true`, which hides the
 * defect; this test is meant to be run against both settings.
 *
 * Ground truth is the accessibility tree (`uiautomator dump`), whose bounds
 * are the view's on-screen rectangle in display pixels -- independent of
 * anything this wrapper computes (`AccessibilityNodeInfo.getBoundsInScreen`,
 * which the View fills from its `getLocationOnScreen` position). The served
 * rectangle is the store's snapshot, logged by the module (`BugseeRN secure
 * ... served=[...]`) only while `log.tag.BugseeRN` is DEBUG, which this test
 * sets and then clears.
 *
 * `E2E_EDGE_TO_EDGE=false|true` names the setting the installed build was
 * made with, and turns the run into an assertion about it (Task 3.H):
 *
 *   false  the React root's display origin is below the status bar
 *          (origin y > 0), and the JS rectangle unconverted would miss the
 *          probe by exactly that origin -- the defect is really present on
 *          this build -- while the served rectangle is on the probe.
 *   true   the origin is (0, 0): nothing to convert.
 *
 * It is required: a run that does not say which build it tested proves
 * nothing about either setting, so the test fails without it. When every edge of the probe falls on a whole display pixel (density x dp
 * integral, as on the WOD_LX1 at density 2), outward rounding has nothing to
 * add, so the served rectangle must equal the probe exactly.
 *
 * The edge-to-edge-off build needs no source change: the React Native
 * Gradle plugin reads the property, so `./gradlew :app:assembleDebug
 * -PedgeToEdgeEnabled=false` overrides gradle.properties for that build
 * only, and the checked-in `edgeToEdgeEnabled=true` never changes.
 *
 * Preconditions, as for the other Android e2e: the app is installed on the
 * handset named in device.ts, and for a debug build Metro is running with
 * `adb reverse tcp:8081 tcp:8081`.
 */
import { ANDROID_PACKAGE } from './device';
import { ON_ANDROID, must, useLog } from './harness';
import {
  type LogLine,
  Logcat,
  adb,
  launchScenario,
  resetScenario,
  writeScenario,
} from './scenario';

const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(4 * 60_000);

const PROBE = 'bugsee-secure-probe';
const DUMP = '/data/local/tmp/bugsee-e2e-ui.xml';

let log: Logcat;

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The probe's on-screen bounds, from the accessibility tree. */
async function probeBounds(): Promise<Rect> {
  await adb('shell', 'uiautomator', 'dump', DUMP);
  const xml = await adb('exec-out', 'cat', DUMP);
  await adb('shell', 'rm', '-f', DUMP);
  const node = new RegExp(
    `<node [^>]*content-desc="${PROBE}"[^>]*bounds="\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]"`,
  ).exec(xml);
  if (node === null) {
    throw new Error(`no node with content-desc="${PROBE}" in the UI dump:\n${xml.slice(0, 4000)}`);
  }
  const [left, top, right, bottom] = node.slice(1, 5).map(Number) as [number, number, number, number];
  return { left, top, right, bottom };
}

/**
 * The one rectangle in a logged `<key>=[version, count, l, t, r, b]`
 * (`served`), or `<key>=[l, t, r, b]` (`raw`, the flat list JS published).
 */
function rectOf(line: LogLine, key: 'served' | 'raw' = 'served'): Rect {
  const found = new RegExp(`${key}=\\[([^\\]]*)\\]`).exec(line.text);
  if (found === null) {
    throw new Error(`no ${key} buffer in: ${line.text}`);
  }
  const values = found[1]!.split(',').map(value => Number(value.trim()));
  if (key === 'raw') {
    if (values.length !== 4) {
      throw new Error(`expected exactly one raw rectangle, got ${found[0]}`);
    }
    const [left, top, right, bottom] = values as [number, number, number, number];
    return { left, top, right, bottom };
  }
  if (values[1] !== 1 || values.length !== 6) {
    throw new Error(`expected exactly one served rectangle, got ${found[0]}`);
  }
  const [, , left, top, right, bottom] = values as [number, number, number, number, number, number];
  return { left, top, right, bottom };
}

/** `origin=<x>,<y>` from a `BugseeRN secure origin` line. */
function originOf(line: LogLine): { x: number; y: number } {
  const found = /origin=(-?\d+),(-?\d+)/.exec(line.text);
  if (found === null) {
    throw new Error(`no origin in: ${line.text}`);
  }
  return { x: Number(found[1]), y: Number(found[2]) };
}

/** The handset's display density, as a scale factor (`wm density` / 160). */
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

const EDGE_TO_EDGE = process.env.E2E_EDGE_TO_EDGE;

describeAndroid('secure rectangles on an Android handset', () => {
  beforeAll(async () => {
    log = await Logcat.start();
    useLog(log, 'B1');
    await adb('shell', 'setprop', 'log.tag.BugseeRN', 'DEBUG');
  });

  afterAll(async () => {
    try {
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await adb('shell', 'rm', '-f', DUMP).catch(() => {});
    } finally {
      await adb('shell', 'setprop', 'log.tag.BugseeRN', "''").catch(() => {});
      resetScenario();
      if (log !== undefined) {
        log.stop();
      }
    }
  });

  it('serves the probe’s rectangle over the probe, in display pixels', async () => {
    const scenario = writeScenario('secure');
    const start = log.mark();
    await launchScenario(scenario);

    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E scenario=secure nonce=${scenario.nonce} `), 120_000, start),
      `the app starting scenario secure (nonce ${scenario.nonce})`,
      start,
    );
    const published = must(
      await log.waitFor(new RegExp(`BUGSEE_E2E secure published .* nonce=${scenario.nonce}`), 30_000, start),
      'the probe being published',
      start,
    );
    // The native line that follows the JS publish, then a beat for any
    // layout-driven origin update to land.
    must(
      await log.waitFor(/BugseeRN\s*:\s*secure published /, 10_000, start),
      'the module logging the published set (is log.tag.BugseeRN DEBUG?)',
      start,
    );
    await new Promise(resolve => setTimeout(resolve, 1_500));

    // One snapshot of the log for every native number below, taken before
    // the (seconds-long) UI dump, so they all describe the same moment.
    const upTo = log.mark();
    const servedLines = log.all(/BugseeRN\s*:\s*secure (published|origin) .*served=/, start, upTo);
    const last = servedLines[servedLines.length - 1]!;
    const served = rectOf(last);
    const originLines = log.all(/BugseeRN\s*:\s*secure origin /, start, upTo);
    const origins = originLines.map(line => line.text.trim());
    const publishedNative = log.all(/BugseeRN\s*:\s*secure published .*raw=/, start, upTo);
    const bounds = await probeBounds();
    const raw = rectOf(must(publishedNative[publishedNative.length - 1], 'the native published line', start), 'raw');
    const origin = originOf(must(originLines[originLines.length - 1], 'a secure origin line', start));
    const scale = await densityScale();

    console.log(
      `[B1] edgeToEdgeEnabled (as built): ${EDGE_TO_EDGE ?? '(not stated)'}\n` +
        `[B1] density: ${scale}\n` +
        `[B1] JS measureInWindow: ${published.text.trim()}\n` +
        `[B1] raw (JS, px): ${JSON.stringify(raw)}\n` +
        `[B1] origin lines: ${JSON.stringify(origins.slice(-3))}\n` +
        `[B1] origin: ${JSON.stringify(origin)}\n` +
        `[B1] served (last): ${last.text.trim()}\n` +
        `[B1] served rect: ${JSON.stringify(served)}\n` +
        `[B1] probe on screen (uiautomator): ${JSON.stringify(bounds)}`,
    );

    // What the store serves is JS's rectangle moved by the root's display
    // origin -- the conversion under test, read off this device.
    expect(served).toEqual({
      left: raw.left + origin.x,
      top: raw.top + origin.y,
      right: raw.right + origin.x,
      bottom: raw.bottom + origin.y,
    });
    if (EDGE_TO_EDGE === 'false') {
      // The experiment: this build really has the defect's precondition.
      // The root sits below the status bar, and JS's rectangle, unconverted,
      // is exactly that far above the probe.
      expect(origin.y).toBeGreaterThan(0);
      expect(bounds.top - raw.top).toBe(origin.y);
      expect(bounds.left - raw.left).toBe(origin.x);
    } else if (EDGE_TO_EDGE === 'true') {
      expect(origin).toEqual({ x: 0, y: 0 });
    } else {
      throw new Error(
        `E2E_EDGE_TO_EDGE must state how the installed build was made, "true" or "false"; got ${JSON.stringify(EDGE_TO_EDGE)}`,
      );
    }

    // Covers the probe entirely...
    expect(served.left).toBeLessThanOrEqual(bounds.left);
    expect(served.top).toBeLessThanOrEqual(bounds.top);
    expect(served.right).toBeGreaterThanOrEqual(bounds.right);
    expect(served.bottom).toBeGreaterThanOrEqual(bounds.bottom);
    // ...and no more than the one pixel outward rounding may add per edge.
    expect(bounds.left - served.left).toBeLessThanOrEqual(1);
    expect(bounds.top - served.top).toBeLessThanOrEqual(1);
    expect(served.right - bounds.right).toBeLessThanOrEqual(1);
    expect(served.bottom - bounds.bottom).toBeLessThanOrEqual(1);

    // Whole display pixels on every edge: outward rounding adds nothing,
    // so the served rectangle is the probe's, exactly.
    const dp = /x=(-?[\d.]+) y=(-?[\d.]+) w=([\d.]+) h=([\d.]+)/.exec(published.text);
    if (dp === null) {
      throw new Error(`could not read the probe's dp rectangle from: ${published.text}`);
    }
    const [x, y, w, h] = dp.slice(1, 5).map(Number) as [number, number, number, number];
    const edges = [x, y, x + w, y + h].map(v => v * scale);
    const wholePixels = edges.every(v => Math.abs(v - Math.round(v)) < 1e-6);
    console.log(`[B1] whole-pixel edges ${JSON.stringify(edges)}: exact-equality check ${wholePixels ? 'ran' : 'skipped'}`);
    if (wholePixels) {
      expect(served).toEqual(bounds);
    }
  });
});
