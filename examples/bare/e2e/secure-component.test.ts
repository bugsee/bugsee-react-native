/**
 * Task 6.8: `<BugseeSecure>` on an Android handset, asserted on the pixels of
 * the reports it was mounted, scrolled and unmounted under -- the report
 * screenshot and every recorded video frame.
 *
 * Scenario `secure-component` (scenarios/privacy.tsx): a white
 * `<BugseeSecure>` on white content, inside a ScrollView three screens tall.
 * White on white, so a dark region in a report can only be the SDK's mask.
 * The scenario uploads `secure-mounted-<n>`, scrolls by 100 dp and uploads
 * `secure-scrolled-<n>`, then unmounts the component and uploads
 * `secure-unmounted-<n>`, holding still after each upload while this test
 * reads the on-screen bounds from `uiautomator dump`.
 *
 * Every bound below is display pixels (the accessibility tree). On a report
 * screenshot it maps at `screenshot.width / displayWidth` (screen.ts); on a
 * video frame through the letterbox derived from the video's own size and
 * the display's (media.ts `videoRegion`), cross-checked against the bars the
 * bundle's `video.aux` records. A video crop is inset by `VIDEO_INSET` video
 * pixels on every edge: h264's block transform and 4:2:0 chroma smear an
 * edge by a pixel or two, and scaling 720 px down to 286 rounds by up to one
 * more; 3 px (about 7.5 display pixels here) keeps the crop clear of both.
 *
 * The scenario's witness -- a black square rendered by the same flag as the
 * component, so it appears and disappears in the same commit -- is what
 * picks out the frames the component is on screen in.
 *
 * The served rectangle is the native store's snapshot, logged at
 * `BugseeRN secure ... served=` only while `log.tag.BugseeRN` is DEBUG, which
 * this test sets and then clears (as B1 does).
 *
 * `E2E_EDGE_TO_EDGE=true|false` must name the setting the installed build was
 * made with (B1): `false` also asserts the React root's display origin is
 * really below the status bar, so the run exercises the origin conversion.
 */
import { type PulledBundle, airplane, captureEvents, removePulledBundles } from './bundles';
import { ANDROID_PACKAGE } from './device';
import { ON_ANDROID, type Run, awaitBundles, clearBundles, escape, must, report, startRun, useLog } from './harness';
import {
  LUMA_BRIGHT_MIN,
  LUMA_DARK_MAX,
  frameLumas,
  imageSize,
  letterbox,
  regionFrameLumas,
  videoRegion,
} from './media';
import { type LogLine, Logcat, adb, resetScenario } from './scenario';
import {
  type Media,
  type Rect,
  assertMedia,
  boundsIn,
  bundleBySummary,
  displaySize,
  hasNode,
  interiorFrames,
  moved,
  screenshotLumas,
  servedOf,
  uiDump,
} from './screen';

const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(6 * 60_000);

const LABEL = 'bugsee-secure-component';
const WITNESS = 'bugsee-secure-witness';
const EDGE_TO_EDGE = process.env.E2E_EDGE_TO_EDGE;
const SERVED = /BugseeRN\s*:\s*secure (published|origin) .*served=/;
/** Video pixels trimmed off every edge of a crop (see the top of this file). */
const VIDEO_INSET = 3;
/** The fewest witnessed frames a video check may rest on. */
const MIN_FRAMES = 5;

interface Series {
  t: number[];
  luma: number[];
}

describeAndroid('<BugseeSecure> on an Android handset', () => {
  let log: Logcat;
  let run: Run;
  let nonce: string;
  let display: { width: number; height: number };
  let mountedBounds: Rect;
  let scrolledBounds: Rect;
  let witnessBounds: Rect;
  /** The last served line before the mounted report's bounds were read. */
  let servedMounted: LogLine;
  let originMounted: LogLine | undefined;
  let lastServed: LogLine;
  let unmountedXml: string;
  let mounted: PulledBundle;
  let scrolled: PulledBundle;
  let unmounted: PulledBundle;
  let media: { mounted: Media; scrolled: Media; unmounted: Media };

  const marker = async (what: string, from: number, timeoutMs = 30_000): Promise<LogLine> =>
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E secure-component ${escape(what)}.* nonce=${nonce}`), timeoutMs, from),
      `the secure-component scenario's "${what}" marker`,
      run.start,
    );

  /**
   * Reads the screen during a hold and proves the read came before the
   * scenario's next change: the next phase's marker, when it arrives, is
   * stamped (device clock) after the dump finished.
   */
  const dumpBefore = async (next: string, from: number): Promise<string> => {
    const { xml, endMs } = await uiDump();
    if (next !== '') {
      const after = await marker(next, from);
      expect({ next, dumpEndedBeforeIt: after.deviceMs > endMs }).toEqual({ next, dumpEndedBeforeIt: true });
    }
    return xml;
  };

  beforeAll(async () => {
    if (EDGE_TO_EDGE !== 'true' && EDGE_TO_EDGE !== 'false') {
      throw new Error(
        `E2E_EDGE_TO_EDGE must state how the installed build was made, "true" or "false"; got ${JSON.stringify(EDGE_TO_EDGE)}`,
      );
    }
    log = await Logcat.start();
    useLog(log, '6.8');
    await adb('shell', 'setprop', 'log.tag.BugseeRN', 'DEBUG');
    await airplane(true);
    display = await displaySize();

    await clearBundles();
    run = await startRun('secure-component');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    // Mounted: read the bounds while the component is where the report saw it.
    const rectMounted = await marker('rect phase=mounted', run.launched.index);
    await marker('uploaded phase=mounted', rectMounted.index);
    const stillMounted = await marker('still phase=mounted', rectMounted.index);
    const upTo = log.mark();
    servedMounted = must(log.all(SERVED, run.start, upTo).pop(), 'a served line before the mounted report', run.start);
    originMounted = log.all(/BugseeRN\s*:\s*secure origin /, run.start, upTo).pop();
    const mountedXml = await dumpBefore('scrolling', stillMounted.index);
    mountedBounds = boundsIn(mountedXml, LABEL);
    witnessBounds = boundsIn(mountedXml, WITNESS);

    const rectScrolled = await marker('rect phase=scrolled', rectMounted.index);
    await marker('uploaded phase=scrolled', rectScrolled.index);
    const stillScrolled = await marker('still phase=scrolled', rectScrolled.index);
    scrolledBounds = boundsIn(await dumpBefore('unmounting', stillScrolled.index), LABEL);

    const unmounting = await marker('unmounting', rectScrolled.index);
    await marker('uploaded phase=unmounted', unmounting.index);
    await marker('still phase=unmounted', unmounting.index);
    unmountedXml = await dumpBefore('', 0);
    lastServed = must(log.all(SERVED, run.start).pop(), 'a served line', run.start);

    report('display', display);
    report('rect markers', [rectMounted.text.trim(), rectScrolled.text.trim()]);
    report('uiautomator bounds', { mounted: mountedBounds, scrolled: scrolledBounds, witness: witnessBounds });
    report('served (mounted)', servedMounted.text.trim());
    report('origin (mounted)', originMounted?.text.trim() ?? '(none)');
    report('served (last)', lastServed.text.trim());

    const bundles = await awaitBundles(3);
    mounted = bundleBySummary(bundles, `secure-mounted-${nonce}`);
    scrolled = bundleBySummary(bundles, `secure-scrolled-${nonce}`);
    unmounted = bundleBySummary(bundles, `secure-unmounted-${nonce}`);
    media = {
      mounted: await assertMedia(mounted),
      scrolled: await assertMedia(scrolled),
      unmounted: await assertMedia(unmounted),
    };
    report('media', Object.fromEntries(Object.entries(media).map(([k, m]) => [k, { screenshots: m.screenshots.length, codecs: m.screenshotCodecs, video: m.videoCodec }])));
  });

  afterAll(async () => {
    try {
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        await airplane(false);
      } finally {
        await adb('shell', 'setprop', 'log.tag.BugseeRN', "''").catch(() => {});
        const { removed, kept } = removePulledBundles();
        report('pulled bundle roots', { removed: removed.length, kept });
        log?.stop();
        resetScenario();
      }
    }
  });

  /**
   * Each rectangle's luma in every interior frame of `bundle`'s video (the
   * SDK's black edge frames trimmed), after checking the derived letterbox
   * against the one the bundle records.
   */
  async function videoSeries(bundle: PulledBundle, video: string, rects: Record<string, Rect>): Promise<Record<string, Series>> {
    const size = await imageSize(video);
    const box = letterbox(display, size);
    const aux = captureEvents(bundle, 'video.aux')[0] as
      | { paddingH?: number; paddingV?: number; screenW?: number; screenH?: number }
      | undefined;
    report(`${String(bundle.request.summary)}: letterbox`, { size, derived: box, aux });
    expect(aux).toBeDefined();
    expect({ screenW: aux!.screenW, screenH: aux!.screenH }).toEqual({ screenW: display.width, screenH: display.height });
    expect(Math.abs(box.padH - aux!.paddingH!)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.padV - aux!.paddingV!)).toBeLessThanOrEqual(1);

    const centre = await frameLumas(video);
    const { from, to } = interiorFrames(centre);
    const out: Record<string, Series> = {};
    for (const [name, rect] of Object.entries(rects)) {
      const frames = await regionFrameLumas(video, videoRegion(rect, display, size, VIDEO_INSET));
      // The same decode, frame for frame: the pairing below is by index.
      expect(frames.map(f => f.t)).toEqual(centre.map(f => f.t));
      out[name] = { t: frames.slice(from, to).map(f => f.t), luma: frames.slice(from, to).map(f => Math.round(f.luma)) };
    }
    report(`${String(bundle.request.summary)}: interior frames (t, ${Object.keys(rects).join(', ')})`,
      out[Object.keys(rects)[0]!]!.t.map((t, i) => [t, ...Object.keys(rects).map(k => out[k]!.luma[i])]));
    return out;
  }

  it("the component's region is masked in the report", async () => {
    const inner = await screenshotLumas(media.mounted.screenshots, mountedBounds, display.width, 0.6);
    const height = mountedBounds.bottom - mountedBounds.top;
    const control: Rect = moved(mountedBounds, height + 40);
    const controlLumas = await screenshotLumas(media.mounted.screenshots, control, display.width);
    report('mounted: inner 60% lumas / control lumas', { inner, control, controlLumas });
    for (const luma of inner) {
      expect(luma).toBeLessThanOrEqual(LUMA_DARK_MAX);
    }
    for (const luma of controlLumas) {
      expect(luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    }

    const served = servedOf(servedMounted);
    expect(served.count).toBe(1);
    const rect = served.rects[0]!;
    report('mounted: served vs on screen', { edgeToEdge: EDGE_TO_EDGE, served: rect, onScreen: mountedBounds });
    expect(rect.left).toBeLessThanOrEqual(mountedBounds.left);
    expect(rect.top).toBeLessThanOrEqual(mountedBounds.top);
    expect(rect.right).toBeGreaterThanOrEqual(mountedBounds.right);
    expect(rect.bottom).toBeGreaterThanOrEqual(mountedBounds.bottom);
    expect(mountedBounds.left - rect.left).toBeLessThanOrEqual(1);
    expect(mountedBounds.top - rect.top).toBeLessThanOrEqual(1);
    expect(rect.right - mountedBounds.right).toBeLessThanOrEqual(1);
    expect(rect.bottom - mountedBounds.bottom).toBeLessThanOrEqual(1);

    // The build under test is the one the run says it is.
    const origin = /origin=(-?\d+),(-?\d+)/.exec(must(originMounted, 'a secure origin line', run.start).text);
    const [ox, oy] = [Number(origin![1]), Number(origin![2])];
    if (EDGE_TO_EDGE === 'false') {
      expect(oy).toBeGreaterThan(0);
    } else {
      expect({ x: ox, y: oy }).toEqual({ x: 0, y: 0 });
    }
  });

  it('every video frame with the component on screen is masked there', async () => {
    const control: Rect = moved(mountedBounds, mountedBounds.bottom - mountedBounds.top + 40);
    const series = await videoSeries(mounted, media.mounted.video, {
      witness: witnessBounds,
      secure: mountedBounds,
      control,
    });
    const witnessed = series.witness!.luma.map(l => l <= LUMA_DARK_MAX);
    const first = witnessed.indexOf(true);
    // The witness maps correctly: it is white stage before the mount and
    // black from it, never letterbox bar.
    expect(first).toBeGreaterThan(0);
    expect(series.witness!.luma.slice(0, first).every(l => l >= LUMA_BRIGHT_MIN)).toBe(true);
    // Mounted until the report: every frame from the first witnessed one.
    expect(witnessed.slice(first).every(Boolean)).toBe(true);
    const frames = witnessed.length - first;
    report('mounted: frames with the component on screen', { first: series.secure!.t[first], frames });
    expect(frames).toBeGreaterThanOrEqual(MIN_FRAMES);

    const bad = series.secure!.luma.slice(first).map((l, i) => ({ t: series.secure!.t[first + i], l })).filter(f => f.l > LUMA_DARK_MAX);
    expect(bad).toEqual([]);
    // Positive control, in the same frames: the white content below it is
    // not dark, so a dark crop is the mask and not a mapping onto a bar.
    const dim = series.control!.luma.slice(first).map((l, i) => ({ t: series.control!.t[first + i], l })).filter(f => f.l < LUMA_BRIGHT_MIN);
    expect(dim).toEqual([]);
  });

  it('the mask follows a scroll', async () => {
    // Precondition: the scroll really moved the component by 100 dp.
    expect(scrolledBounds.top).toBeLessThan(mountedBounds.top);
    expect(scrolledBounds.left).toBe(mountedBounds.left);
    const dark = await screenshotLumas(media.scrolled.screenshots, scrolledBounds, display.width, 0.6);
    const old = await screenshotLumas(media.scrolled.screenshots, mountedBounds, display.width);
    report('scrolled: new-bounds inner 60% lumas / old-bounds lumas', { dark, old, newBounds: scrolledBounds, oldBounds: mountedBounds });
    for (const luma of dark) {
      expect(luma).toBeLessThanOrEqual(LUMA_DARK_MAX);
    }
    for (const luma of old) {
      expect(luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    }
  });

  it('the mask follows a scroll in the video', async () => {
    // The video's last recorded frames before the report: the scroll
    // happened 1.5 s before the upload, so the final half second is
    // settled (the mask's re-measure is 100 ms, the SDK's pull ~350 ms).
    const series = await videoSeries(scrolled, media.scrolled.video, { secure: scrolledBounds, old: mountedBounds });
    const last = series.secure!.t[series.secure!.t.length - 1]!;
    const tail = series.secure!.t.map((t, i) => i).filter(i => series.secure!.t[i]! >= last - 0.5);
    report('scrolled: final frames (t, new, old)', tail.map(i => [series.secure!.t[i], series.secure!.luma[i], series.old!.luma[i]]));
    expect(tail.length).toBeGreaterThanOrEqual(3);
    for (const i of tail) {
      expect({ t: series.secure!.t[i], new: series.secure!.luma[i]! <= LUMA_DARK_MAX }).toEqual({ t: series.secure!.t[i], new: true });
      expect({ t: series.old!.t[i], old: series.old!.luma[i]! >= LUMA_BRIGHT_MIN }).toEqual({ t: series.old!.t[i], old: true });
    }
  });

  it('unmounting disposes the mask', async () => {
    // Precondition: the component is really gone from the screen.
    expect(hasNode(unmountedXml, LABEL)).toBe(false);
    expect(hasNode(unmountedXml, WITNESS)).toBe(false);
    const lumas = await screenshotLumas(media.unmounted.screenshots, scrolledBounds, display.width);
    report('unmounted: last-bounds lumas', lumas);
    for (const luma of lumas) {
      expect(luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    }
    expect(servedOf(lastServed).count).toBe(0);

    // In the video: every frame after the witness went, the last bounds are
    // white content again.
    const series = await videoSeries(unmounted, media.unmounted.video, { witness: witnessBounds, last: scrolledBounds });
    const witnessed = series.witness!.luma.map(l => l <= LUMA_DARK_MAX);
    const gone = witnessed.lastIndexOf(true) + 1;
    expect(gone).toBeGreaterThan(0);
    expect(witnessed.slice(gone).some(Boolean)).toBe(false);
    const frames = witnessed.length - gone;
    report('unmounted: frames after the component went', { first: series.last!.t[gone], frames, lumas: series.last!.luma.slice(gone) });
    expect(frames).toBeGreaterThanOrEqual(MIN_FRAMES);
    const dark = series.last!.luma.slice(gone).map((l, i) => ({ t: series.last!.t[gone + i], l })).filter(f => f.l < LUMA_BRIGHT_MIN);
    expect(dark).toEqual([]);
  });
});
