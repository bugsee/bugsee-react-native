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
 * anything this wrapper computes. The served rectangle is the store's
 * snapshot, logged by the module (`BugseeRN secure ... served=[...]`) only
 * while `log.tag.BugseeRN` is DEBUG, which this test sets and then clears.
 *
 * Preconditions, as for the other Android e2e: the app is installed on the
 * handset named in device.ts, and for a debug build Metro is running with
 * `adb reverse tcp:8081 tcp:8081`.
 */
import { ANDROID_PACKAGE } from './device';
import {
  type LogLine,
  Logcat,
  adb,
  launchScenario,
  resetScenario,
  writeScenario,
} from './scenario';

const ON_ANDROID = process.env.E2E_PLATFORM === 'android';
const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(4 * 60_000);

const PROBE = 'bugsee-secure-probe';
const DUMP = '/data/local/tmp/bugsee-e2e-ui.xml';

let log: Logcat;

function must(line: LogLine | undefined, what: string, from = 0): LogLine {
  if (line === undefined) {
    throw new Error(`never saw ${what}.\nLog since the run started:\n${log.tail(from)}`);
  }
  return line;
}

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

/** The one rectangle in a logged `served=[version, count, l, t, r, b]`. */
function servedRect(line: LogLine): Rect {
  const served = /served=\[([^\]]*)\]/.exec(line.text);
  if (served === null) {
    throw new Error(`no served buffer in: ${line.text}`);
  }
  const values = served[1]!.split(',').map(value => Number(value.trim()));
  if (values[1] !== 1 || values.length !== 6) {
    throw new Error(`expected exactly one served rectangle, got ${served[0]}`);
  }
  const [, , left, top, right, bottom] = values as [number, number, number, number, number, number];
  return { left, top, right, bottom };
}

describeAndroid('secure rectangles on an Android handset', () => {
  beforeAll(async () => {
    log = await Logcat.start();
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

    const servedLines = log.all(/BugseeRN\s*:\s*secure (published|origin) .*served=/, start);
    const last = servedLines[servedLines.length - 1]!;
    const served = servedRect(last);
    const bounds = await probeBounds();
    const origins = log.all(/BugseeRN\s*:\s*secure origin /, start).map(line => line.text.trim());

    console.log(
      `[B1] JS measureInWindow: ${published.text.trim()}\n` +
        `[B1] origin lines: ${JSON.stringify(origins.slice(-3))}\n` +
        `[B1] served (last): ${last.text.trim()}\n` +
        `[B1] served rect: ${JSON.stringify(served)}\n` +
        `[B1] probe on screen (uiautomator): ${JSON.stringify(bounds)}`,
    );

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
  });
});
