/**
 * `<BugseeSecure>` on the app's root and inside a `<Modal>`: both must be
 * masked in the report. Fabric measureInWindow is surface-relative, and each
 * rectangle is translated by its own surface's origin at pull time.
 *
 * Scenarios (scenarios/privacy.tsx), one block each:
 *  - `secure-modal`: a transparent Modal (both platforms).
 *  - `secure-modal-translucent` (Android): also `statusBarTranslucent`. On a
 *    build with edge-to-edge off this is the case where the dialog's origin
 *    (0) differs from the activity root's (the status bar), so it is the one
 *    that tells a per-surface origin from a shared one.
 *  - `secure-modal-sheet` (iOS): an opaque `pageSheet`, whose content is
 *    inset inside the window.
 *
 * Ground truth is independent of what the app measured: each secure view is
 * a colour nothing else on screen has, and a screenshot taken by the device
 * itself (`adb exec-out screencap`, `xcrun simctl io screenshot`) finds where
 * each really is. The report's screenshot must be dark over each one the
 * device shows, and must not contain either colour anywhere. An opaque
 * `pageSheet` covers the main view entirely on an iPhone, so there only the
 * sheet's colour is on screen. The iPhone has no command-line screenshot, so
 * there only the colour check runs.
 *
 * The video is checked too (the SDK masks it on a separate, native path): a
 * witness inside the Modal, red and not secure, marks every frame that shows
 * the Modal, and in each of those the Modal's secure view must be dark. Both
 * crops come from the same frames, so the video's timestamp lag does not
 * matter.
 *
 * Android: WOD_LX1 with `E2E_EDGE_TO_EDGE` naming the installed build.
 * iOS: simulator or XS (`E2E_IOS_TARGET`).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type PulledBundle, airplane, captureEvents, removePulledBundles } from './bundles';
import { ADB, ANDROID_SERIAL, IOS_SIMULATOR_ID, iosTarget } from './device';
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
import {
  LUMA_BRIGHT_MIN,
  LUMA_DARK_MAX,
  colourOf,
  colourPixels,
  frameLumas,
  imageSize,
  letterbox,
  regionFrameLumas,
  videoRegion,
  widthFitRegion,
} from './media';
import { type DeviceLog, type LogLine, adb, resetScenario } from './scenario';
import {
  type Media,
  type Rect,
  assertMedia,
  boundsIn,
  bundleBySummary,
  displaySize,
  interiorFrames,
  markerScreen,
  moved,
  screenshotLumas,
  servedOf,
  uiDump,
} from './screen';

const execFileAsync = promisify(execFile);

jest.setTimeout(4 * 60_000);

const SHEET_LABEL = 'bugsee-secure-modal-sheet';
const MAIN_COLOUR = colourOf('#FF00FF');
const SHEET_COLOUR = colourOf('#00FFFF');
const WITNESS_COLOUR = colourOf('#FF0000');
/** Video pixels trimmed off every edge of a crop, as in secure-component.test.ts. */
const VIDEO_INSET = 3;
/** The fewest witnessed frames a video check may rest on. */
const MIN_FRAMES = 5;
/** Pixels of a secure colour a report may show before it counts as a leak (antialiased edges). */
const LEAK_MAX_PIXELS = 64;
/** A secure view the device screenshot shows must be at least this big to count as found. */
const FOUND_MIN_PIXELS = 1_000;
const EDGE_TO_EDGE = process.env.E2E_EDGE_TO_EDGE;
const SERVED = /BugseeRN\s*:\s*secure (published|origin) .*served=/;
const ACTIVITY_ORIGIN = /BugseeRN\s*:\s*secure origin .*kind=activity\b/;

const SCENARIOS = ON_IOS ? ['secure-modal', 'secure-modal-sheet'] : ['secure-modal', 'secure-modal-translucent'];

/** The device's own screenshot, or `null` where there is no command-line one (the iPhone). */
async function deviceScreenshot(dir: string): Promise<string | null> {
  const file = join(dir, 'device.png');
  if (!ON_IOS) {
    const { stdout } = await execFileAsync(ADB, ['-s', ANDROID_SERIAL, 'exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(file, stdout as unknown as Buffer);
    return file;
  }
  if (iosTarget() !== 'simulator') {
    return null;
  }
  await execFileAsync('xcrun', ['simctl', 'io', IOS_SIMULATOR_ID, 'screenshot', file]);
  return file;
}

/** `box` (image pixels) as a `Rect` in display units, on an image `imageWidth` wide. */
function toDisplay(box: { left: number; top: number; right: number; bottom: number }, imageWidth: number, displayWidth: number): Rect {
  const scale = displayWidth / imageWidth;
  return { left: box.left * scale, top: box.top * scale, right: box.right * scale, bottom: box.bottom * scale };
}

for (const scenario of SCENARIOS) {
  describeDevice(`<BugseeSecure> in ${scenario} on ${TARGET_NAME}`, () => {
    let log: DeviceLog;
    let run: Run;
    let nonce: string;
    let display: { width: number; height: number };
    let shotDir: string;
    let deviceShot: string | null;
    /** Where the device shows each secure view (display units); `main` is absent behind an opaque sheet. */
    let found: { main: Rect | null; sheet: Rect } | null = null;
    /** Where the device shows the Modal's red witness (display units). */
    let witness: Rect | null = null;
    let sheetFromDump: Rect | undefined;
    let mainFromJs: Rect | undefined;
    let servedLine: LogLine | undefined;
    let bundle: PulledBundle;
    let media: Media;

    const marker = async (what: string, from: number, timeoutMs = 45_000): Promise<LogLine> =>
      must(
        await log.waitFor(new RegExp(`BUGSEE_E2E ${escape(scenario)} ${escape(what)}.* nonce=${nonce}`), timeoutMs, from),
        `the ${scenario} scenario's "${what}" marker`,
        run.start,
      );

    beforeAll(async () => {
      if (!ON_IOS && EDGE_TO_EDGE !== 'true' && EDGE_TO_EDGE !== 'false') {
        throw new Error(
          `E2E_EDGE_TO_EDGE must state how the installed build was made, "true" or "false"; got ${JSON.stringify(EDGE_TO_EDGE)}`,
        );
      }
      shotDir = mkdtempSync(join(tmpdir(), 'bugsee-secure-modal-'));
      log = await startDeviceLog('6.modal', '6.modal');
      if (!ON_IOS) {
        await adb('shell', 'setprop', 'log.tag.BugseeRN', 'DEBUG');
        await airplane(true);
        display = await displaySize();
      }

      await clearBundles();
      run = await startRun(scenario);
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      const rect = await marker('rect phase=both', run.launched.index);
      await marker('uploaded', rect.index);
      const still = await marker('still', rect.index);
      if (ON_IOS) {
        display = markerScreen(rect);
      }
      report('JS rectangles', rect.text.replace(/^.*rect phase=both /, ''));

      // While the scenario holds still: the device's own picture of where
      // the two secure views are.
      deviceShot = await deviceScreenshot(shotDir);
      if (deviceShot !== null) {
        const main = await colourPixels(deviceShot, MAIN_COLOUR);
        const sheet = await colourPixels(deviceShot, SHEET_COLOUR);
        const red = await colourPixels(deviceShot, WITNESS_COLOUR);
        report('device screenshot', { main, sheet, witness: red });
        if (red.box !== null) {
          witness = toDisplay(red.box, red.width, display.width);
        }
        if (sheet.box !== null) {
          found = {
            main: main.box === null ? null : toDisplay(main.box, main.width, display.width),
            sheet: toDisplay(sheet.box, sheet.width, display.width),
          };
        }
        expect(sheet.count).toBeGreaterThanOrEqual(FOUND_MIN_PIXELS);
        if (scenario === 'secure-modal-sheet') {
          // The opaque sheet hides the main view: the device must not show it.
          expect(main.count).toBe(0);
        } else {
          expect(main.count).toBeGreaterThanOrEqual(FOUND_MIN_PIXELS);
        }
      }

      if (!ON_IOS) {
        // Before the dump: a focused Dialog's accessibility dump leaves out
        // the activity-root control behind it.
        const upTo = log.mark();
        servedLine = must(log.all(SERVED, run.start, upTo).pop(), 'a served line before the dump', run.start);
        const activity = must(
          log.all(ACTIVITY_ORIGIN, run.start, upTo).pop(),
          "the activity root's origin line",
          run.start,
        );
        const origin = /origin=(-?\d+),(-?\d+)/.exec(activity.text);
        const ratio = Number(/\bratio=([\d.]+)/.exec(rect.text)?.[1] ?? 'NaN');
        const main = /main=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(rect.text);
        if (origin === null || main === null || !Number.isFinite(ratio) || ratio <= 0) {
          throw new Error(`could not parse the activity origin, ratio or main rect: ${activity.text} / ${rect.text}`);
        }
        const [ox, oy] = [Number(origin[1]), Number(origin[2])];
        mainFromJs = {
          left: Math.round(Number(main[1]) * ratio) + ox,
          top: Math.round(Number(main[2]) * ratio) + oy,
          right: Math.round((Number(main[1]) + Number(main[3])) * ratio) + ox,
          bottom: Math.round((Number(main[2]) + Number(main[4])) * ratio) + oy,
        };
        const { xml } = await uiDump();
        sheetFromDump = boundsIn(xml, SHEET_LABEL);
        report('bounds', { mainFromJs, sheetFromDump, activityOrigin: { ox, oy }, ratio, stillBeforeDump: still.deviceMs });
        report('origins', log.all(/BugseeRN\s*:\s*secure origin /, run.start, upTo).map(line => line.text.trim()));
        report('served', servedLine.text.trim());
      }

      report('display', display);
      const bundles = await awaitBundles(1);
      bundle = bundleBySummary(bundles, `${scenario}-${nonce}`);
      media = await assertMedia(bundle);
      report('media', { screenshots: media.screenshots.length, codecs: media.screenshotCodecs, video: media.videoCodec });
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
          rmSync(shotDir, { recursive: true, force: true });
          const { removed, kept } = removePulledBundles();
          report('pulled bundle roots', { removed: removed.length, kept });
          stopDeviceLog(log);
          resetScenario();
        }
      }
    });

    it('the report shows neither secure colour anywhere', async () => {
      const leaks = [];
      for (const file of media.screenshots) {
        leaks.push({
          main: (await colourPixels(file, MAIN_COLOUR)).count,
          sheet: (await colourPixels(file, SHEET_COLOUR)).count,
        });
      }
      report('secure colour pixels in the report', leaks);
      for (const leak of leaks) {
        expect(leak.main).toBeLessThanOrEqual(LEAK_MAX_PIXELS);
        expect(leak.sheet).toBeLessThanOrEqual(LEAK_MAX_PIXELS);
      }
    });

    it('the report is dark where the device shows each secure view', async () => {
      if (deviceShot === null) {
        report('device screenshot', 'none on this target: only the colour check above applies');
        return;
      }
      if (found === null) {
        throw new Error("the device screenshot does not show the Modal's secure colour");
      }
      const where = found;
      const mainInner = where.main === null ? [] : await screenshotLumas(media.screenshots, where.main, display.width, 0.6);
      const sheetInner = await screenshotLumas(media.screenshots, where.sheet, display.width, 0.6);
      // Inside the Modal's white backdrop, below its secure view.
      const control: Rect = moved(where.sheet, (where.sheet.bottom - where.sheet.top) + 40);
      const controlLumas = await screenshotLumas(media.screenshots, control, display.width);
      report('lumas', { found: where, mainInner, sheetInner, control, controlLumas });

      for (const luma of [...mainInner, ...sheetInner]) {
        expect(luma).toBeLessThanOrEqual(LUMA_DARK_MAX);
      }
      for (const luma of controlLumas) {
        expect(luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
      }
    });

    if (!ON_IOS) {
      it('the served set covers the main rectangle and the sheet', () => {
        const served = servedOf(servedLine as LogLine);
        report('served vs on screen', {
          edgeToEdge: EDGE_TO_EDGE,
          served: served.rects,
          main: mainFromJs,
          sheet: sheetFromDump,
          found,
        });
        const covers = (rect: Rect, onScreen: Rect): boolean =>
          rect.left <= onScreen.left &&
          rect.top <= onScreen.top &&
          rect.right >= onScreen.right &&
          rect.bottom >= onScreen.bottom &&
          onScreen.left - rect.left <= 2 &&
          onScreen.top - rect.top <= 2 &&
          rect.right - onScreen.right <= 2 &&
          rect.bottom - onScreen.bottom <= 2;

        expect(served.count).toBeGreaterThanOrEqual(2);
        expect(served.rects.some(r => covers(r, mainFromJs as Rect))).toBe(true);
        expect(served.rects.some(r => covers(r, sheetFromDump as Rect))).toBe(true);
      });
    }
    it('every video frame that shows the Modal is masked over its secure view', async () => {
      if (deviceShot === null) {
        report('video', 'no device screenshot on this target to place the witness: skipped');
        return;
      }
      if (found === null || witness === null) {
        throw new Error("the device screenshot does not show the Modal's secure colour and its witness");
      }
      const video = media.video;
      const size = await imageSize(video);
      let region: (rect: Rect) => { x: number; y: number; w: number; h: number };
      if (ON_IOS) {
        // The iOS SDK scales by width from the top-left, as its screenshot.
        expect(captureEvents(bundle, 'video.aux')).toEqual([]);
        region = rect => widthFitRegion(rect, display, size, VIDEO_INSET);
      } else {
        const box = letterbox(display, size);
        const aux = captureEvents(bundle, 'video.aux')[0] as
          | { paddingH?: number; paddingV?: number; screenW?: number; screenH?: number }
          | undefined;
        report('video letterbox', { size, derived: box, aux });
        expect(aux).toBeDefined();
        expect({ screenW: aux!.screenW, screenH: aux!.screenH }).toEqual({ screenW: display.width, screenH: display.height });
        expect(Math.abs(box.padH - aux!.paddingH!)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.padV - aux!.paddingV!)).toBeLessThanOrEqual(1);
        region = rect => videoRegion(rect, display, size, VIDEO_INSET);
      }
      const centre = await frameLumas(video);
      const { from, to } = interiorFrames(centre);
      const series = async (rect: Rect): Promise<number[]> => {
        const frames = await regionFrameLumas(video, region(rect));
        // The same decode, frame for frame: the pairing below is by index.
        expect(frames.map(f => f.t)).toEqual(centre.map(f => f.t));
        return frames.slice(from, to).map(f => Math.round(f.luma));
      };
      const t = centre.slice(from, to).map(f => f.t);
      const witnessLuma = await series(witness);
      const sheetLuma = await series(found.sheet);
      report('video frames (t, witness, sheet)', t.map((time, i) => [time, witnessLuma[i], sheetLuma[i]]));

      // The witness is white stage before the Modal shows, and red (or black,
      // under a whole-display mask while an origin is unknown) once it does.
      // Every frame that shows it must hide the secure view, and the Modal is
      // still up when the report is taken.
      const shown = witnessLuma.map((l, i) => i).filter(i => witnessLuma[i]! < LUMA_BRIGHT_MIN);
      expect(shown.length).toBeGreaterThanOrEqual(MIN_FRAMES);
      expect(shown[shown.length - 1]).toBe(witnessLuma.length - 1);
      const leaked = shown.map(i => ({ t: t[i], l: sheetLuma[i]! })).filter(frame => frame.l > LUMA_DARK_MAX);
      expect(leaked).toEqual([]);
    });
  });
}
