/**
 * Phase 6 Modal follow-up: a `<BugseeSecure>` on the activity root and one
 * inside a `<Modal>` must both cover their on-screen controls. Fabric
 * measureInWindow is surface-relative; each rectangle is translated by that
 * surface's display origin at pull time.
 *
 * Scenario `secure-modal` (scenarios/privacy.tsx). Android: WOD_LX1 with
 * `E2E_EDGE_TO_EDGE` naming the installed build. iOS: simulator or XS
 * (`E2E_IOS_TARGET`), ground truth from the scenario's measureInWindow logs.
 */
import { type PulledBundle, airplane, removePulledBundles } from './bundles';
import {
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
import { LUMA_BRIGHT_MIN, LUMA_DARK_MAX } from './media';
import { type DeviceLog, type LogLine, adb, resetScenario } from './scenario';
import {
  type Media,
  type Rect,
  assertMedia,
  boundsIn,
  bundleBySummary,
  displaySize,
  markerScreen,
  moved,
  screenshotLumas,
  servedOf,
  uiDump,
} from './screen';

jest.setTimeout(4 * 60_000);

const SHEET_LABEL = 'bugsee-secure-modal-sheet';
const EDGE_TO_EDGE = process.env.E2E_EDGE_TO_EDGE;
const SERVED = /BugseeRN\s*:\s*secure (published|origin) .*served=/;

describeDevice(`<BugseeSecure> in Modal on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let display: { width: number; height: number };
  let mainBounds: Rect;
  let sheetBounds: Rect;
  let servedLine: LogLine;
  let bundle: PulledBundle;
  let media: Media;

  const marker = async (what: string, from: number, timeoutMs = 45_000): Promise<LogLine> =>
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E secure-modal ${escape(what)}.* nonce=${nonce}`), timeoutMs, from),
      `the secure-modal scenario's "${what}" marker`,
      run.start,
    );

  beforeAll(async () => {
    if (!ON_IOS && EDGE_TO_EDGE !== 'true' && EDGE_TO_EDGE !== 'false') {
      throw new Error(
        `E2E_EDGE_TO_EDGE must state how the installed build was made, "true" or "false"; got ${JSON.stringify(EDGE_TO_EDGE)}`,
      );
    }
    log = await startDeviceLog('6.modal', '6.modal');
    if (!ON_IOS) {
      await adb('shell', 'setprop', 'log.tag.BugseeRN', 'DEBUG');
      await airplane(true);
      display = await displaySize();
    }

    await clearBundles();
    run = await startRun('secure-modal');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    const rect = await marker('rect phase=both', run.launched.index);
    await marker('uploaded', rect.index);
    const still = await marker('still', rect.index);

    const main = /main=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(rect.text);
    const sheet = /sheet=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(rect.text);
    if (main === null || sheet === null) {
      throw new Error(`could not parse main/sheet from ${rect.text}`);
    }
    const ratio = Number(/\bratio=([\d.]+)/.exec(rect.text)?.[1] ?? (ON_IOS ? '1' : 'NaN'));
    if (!Number.isFinite(ratio) || ratio <= 0) {
      throw new Error(`could not parse PixelRatio from ${rect.text}`);
    }

    if (ON_IOS) {
      // Simulator window points == screen points (Task 6.9 rule).
      display = markerScreen(rect);
      mainBounds = {
        left: Number(main[1]),
        top: Number(main[2]),
        right: Number(main[1]) + Number(main[3]),
        bottom: Number(main[2]) + Number(main[4]),
      };
      sheetBounds = {
        left: Number(sheet[1]),
        top: Number(sheet[2]),
        right: Number(sheet[1]) + Number(sheet[3]),
        bottom: Number(sheet[2]) + Number(sheet[4]),
      };
      report('JS rectangles (points)', { main: mainBounds, sheet: sheetBounds });
    } else {
      // A focused Android Dialog's accessibility dump does not include the
      // activity-root control behind it. Sheet bounds come from uiautomator;
      // main bounds from the twin's measureInWindow, scaled like the registry
      // (and shifted by the activity origin when edge-to-edge is off).
      const upTo = log.mark();
      servedLine = must(log.all(SERVED, run.start, upTo).pop(), 'a served line before the dump', run.start);
      const originLine = log.all(/BugseeRN\s*:\s*secure origin .*surface=0\b/, run.start, upTo).pop()
        ?? log.all(/BugseeRN\s*:\s*secure origin /, run.start, upTo).pop();
      const origin = /origin=(-?\d+),(-?\d+)/.exec(originLine?.text ?? '');
      const ox = origin ? Number(origin[1]) : 0;
      const oy = origin ? Number(origin[2]) : 0;
      mainBounds = {
        left: Math.round(Number(main[1]) * ratio) + ox,
        top: Math.round(Number(main[2]) * ratio) + oy,
        right: Math.round((Number(main[1]) + Number(main[3])) * ratio) + ox,
        bottom: Math.round((Number(main[2]) + Number(main[4])) * ratio) + oy,
      };
      const { xml } = await uiDump();
      sheetBounds = boundsIn(xml, SHEET_LABEL);
      report('bounds', {
        mainFromJs: mainBounds,
        sheetFromDump: sheetBounds,
        origin: { ox, oy },
        ratio,
        stillBeforeDump: still.deviceMs,
      });
      report('served', servedLine.text.trim());
    }

    report('display', display);
    const bundles = await awaitBundles(1);
    bundle = bundleBySummary(bundles, `secure-modal-${nonce}`);
    media = await assertMedia(bundle);
    report('media', {
      screenshots: media.screenshots.length,
      codecs: media.screenshotCodecs,
      video: media.videoCodec,
    });
  });

  afterAll(async () => {
    try {
      await stopApp();
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        if (!ON_IOS) {
          await airplane(false);
        }
      } finally {
        if (!ON_IOS) {
          await adb('shell', 'setprop', 'log.tag.BugseeRN', "''").catch(() => {});
        }
        const { removed, kept } = removePulledBundles();
        report('pulled bundle roots', { removed: removed.length, kept });
        stopDeviceLog(log);
        resetScenario();
      }
    }
  });

  it('both the main and modal secure regions are masked', async () => {
    const mainInner = await screenshotLumas(media.screenshots, mainBounds, display.width, 0.6);
    const sheetInner = await screenshotLumas(media.screenshots, sheetBounds, display.width, 0.6);
    const control: Rect = moved(mainBounds, (mainBounds.bottom - mainBounds.top) + 40);
    const controlLumas = await screenshotLumas(media.screenshots, control, display.width);
    report('lumas', { mainInner, sheetInner, control, controlLumas });

    for (const luma of mainInner) {
      expect(luma).toBeLessThanOrEqual(LUMA_DARK_MAX);
    }
    for (const luma of sheetInner) {
      expect(luma).toBeLessThanOrEqual(LUMA_DARK_MAX);
    }
    for (const luma of controlLumas) {
      expect(luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    }

    if (ON_IOS) {
      return;
    }

    const served = servedOf(servedLine);
    expect(served.count).toBeGreaterThanOrEqual(2);
    report('served vs on screen', {
      edgeToEdge: EDGE_TO_EDGE,
      served: served.rects,
      main: mainBounds,
      sheet: sheetBounds,
    });

    const covers = (rect: { left: number; top: number; right: number; bottom: number }, onScreen: Rect): boolean =>
      rect.left <= onScreen.left &&
      rect.top <= onScreen.top &&
      rect.right >= onScreen.right &&
      rect.bottom >= onScreen.bottom &&
      onScreen.left - rect.left <= 2 &&
      onScreen.top - rect.top <= 2 &&
      rect.right - onScreen.right <= 2 &&
      rect.bottom - onScreen.bottom <= 2;

    expect(served.rects.some(r => covers(r, mainBounds))).toBe(true);
    expect(served.rects.some(r => covers(r, sheetBounds))).toBe(true);
  });
});
