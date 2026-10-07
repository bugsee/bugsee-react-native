/**
 * N-13: every report-dialog appearance key (section 1.5 RA rows), read back
 * and, where the key paints the dialog as it opens, found on screen.
 *
 * Scenario `api-dialog-keys` (scenarios/api-ui.ts) sets all 14 keys of
 * `Bugsee.appearance` to the colours in scenarios/api-constants.ts
 * REPORT_COLOURS, logs each read-back, logs the error each key without a
 * binding on this platform threw, then opens the dialog pre-filled (summary
 * and description, so the text colour has text to paint). The test
 * screenshots the dialog and counts each colour's pixels.
 *
 * Keys that paint only in a state the dialog does not open in (a pressed
 * button: `actionBarButtonBackgroundClickedColor`) are read back only (M-A11).
 */
import { apiMarker, jsonAfter } from './api-markers';
import { REPORT_COLOURS, REPORT_KEYS } from '../scenarios/api-constants';
import { ON_ANDROID, ON_IOS, type Run, TARGET_NAME, describeDevice, report, startRun } from './harness';
import { colourOf, colourPixels } from './media';
import { beginRetainingSuite, captureScreen, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine, adbStatus } from './scenario';

jest.setTimeout(5 * 60_000);

const PLATFORM = ON_IOS ? 'ios' : 'android';
const BOUND: readonly string[] = REPORT_KEYS[PLATFORM];
/** Keys a just-opened dialog cannot show (pressed states). */
const NOT_ON_SCREEN = new Set(['actionBarButtonBackgroundClickedColor']);
/** A colour region this small or smaller is noise, not paint. */
const MIN_PIXELS = 40;

describeDevice(`the report dialog's appearance keys on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let readback: Record<string, string | null>;
  let foreign: Record<string, string>;
  let shot: string;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-13');
    run = await startRun('api-dialog-keys');
    const nonce = run.scenario.nonce;
    const read: LogLine = await apiMarker(log, 'dialog-keys readback', nonce, 20_000, run.start);
    const thrown: LogLine = await apiMarker(log, 'dialog-keys foreign', nonce, 5_000, run.start);
    await apiMarker(log, 'dialog-keys shown', nonce, 10_000, run.start);
    readback = jsonAfter(read.text, 'values');
    foreign = jsonAfter(thrown.text, 'values');
    report('readback', readback);
    report('foreign', foreign);
    await new Promise(resolve => setTimeout(resolve, 5_000));
    shot = await captureScreen('dialog-keys');
  });

  afterAll(async () => {
    if (ON_ANDROID) {
      await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    }
    await endRetainingSuite(log);
  });

  for (const key of Object.keys(REPORT_COLOURS)) {
    if (!BOUND.includes(key)) {
      it(`[${raOf(key)}] ${key} has no ${PLATFORM} binding: setting it throws RangeError and it reads back undefined`, () => {
        expect(foreign[key]).toMatch(/^RangeError: /);
        expect(readback[key]).toBeNull();
      });
      continue;
    }
    it(`[${raOf(key)}] ${key} reads back as set`, () => {
      expect(foreign[key]).toBeUndefined();
      expect(readback[key]).toBe(`${REPORT_COLOURS[key]}ff`);
    });
    if (NOT_ON_SCREEN.has(key)) {
      continue;
    }
    it(`[${raOf(key)}] ${key} paints the open dialog`, async () => {
      const found = await colourPixels(shot, colourOf(REPORT_COLOURS[key]!), 20);
      report(`${key} ${REPORT_COLOURS[key]} pixels`, { count: found.count, box: found.box });
      expect(found.count).toBeGreaterThan(MIN_PIXELS);
    });
  }
});

/** The plan's RA-<nn> id of a key (section 1.5, alphabetical). */
function raOf(key: string): string {
  const order = Object.keys(REPORT_COLOURS).sort((a, b) => a.localeCompare(b));
  return `RA-${String(order.indexOf(key) + 1).padStart(2, '0')}`;
}
