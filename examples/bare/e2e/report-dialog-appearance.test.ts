/**
 * API-40 / FLOW-21: `Bugsee.appearance` repaints the report dialog, read off
 * the screen rather than back from the SDK (appearance.test.ts does that).
 *
 * Scenario `cov-dialog-color` (scenarios/coverage.ts) sets the report
 * background to opaque pure red, reads it back, and opens the report dialog
 * with `showReportDialog`. The app's own screen has no pure red at all, so
 * a screen capture with a large pure-red area is the dialog wearing the
 * color.
 * Nothing taps the dialog; Android closes it with the Back key afterwards.
 */
import { ON_ANDROID, type Run, TARGET_NAME, describeDevice, must, report, startRun } from './harness';
import { colourOf, colourPixels } from './media';
import { beginRetainingSuite, captureScreen, endRetainingSuite } from './observe';
import { type DeviceLog, adbStatus } from './scenario';

jest.setTimeout(5 * 60_000);

describeDevice(`the report dialog in the appearance colors on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-dialog');
  });

  afterAll(async () => {
    if (ON_ANDROID) {
      await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    }
    await endRetainingSuite(log);
  });

  it('the dialog is painted in the background color set before it opened', async () => {
    const run: Run = await startRun('cov-dialog-color');
    const shown = must(
      await log!.waitFor(new RegExp(`BUGSEE_E2E cov dialog shown nonce=${run.scenario.nonce} background=(\\S+)`), 20_000, run.start),
      'the dialog being opened',
      run.start,
    );
    expect(shown.text).toContain('background=#ff0000ff');
    // The dialog animates in.
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const shot = await captureScreen('report-dialog');
    const red = await colourPixels(shot, colourOf('#ff0000'), 24);
    report('red pixels', { count: red.count, of: red.width * red.height, box: red.box });
    // Android paints the whole dialog body; iOS paints the background the
    // grouped cells sit on (their own color is `cellBackgroundColor`), which
    // shows as the bands between the cells and the area below them -- about
    // a tenth of the screen on the iPhone 17 Pro simulator.
    expect(red.count).toBeGreaterThan((ON_ANDROID ? 0.3 : 0.05) * red.width * red.height);
  });
});
