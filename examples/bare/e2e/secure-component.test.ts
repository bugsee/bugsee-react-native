/**
 * Task 6.8: `<BugseeSecure>` on an Android handset, asserted on the pixels of
 * the reports it was mounted, scrolled and unmounted under.
 *
 * Scenario `secure-component` (scenarios/privacy.tsx): a white
 * `<BugseeSecure>` on white content, inside a ScrollView three screens tall.
 * White on white, so a dark region in a report can only be the SDK's mask.
 * The scenario uploads `secure-mounted-<n>`, scrolls by 100 dp and uploads
 * `secure-scrolled-<n>`, then unmounts the component and uploads
 * `secure-unmounted-<n>`, holding still after each upload while this test
 * reads the component's on-screen bounds from `uiautomator dump`.
 *
 * Every bound below is display pixels (the accessibility tree), mapped onto
 * each report screenshot at `screenshot.width / displayWidth` (screen.ts).
 * The served rectangle is the native store's snapshot, logged at
 * `BugseeRN secure ... served=` only while `log.tag.BugseeRN` is DEBUG, which
 * this test sets and then clears (as B1 does).
 *
 * `E2E_EDGE_TO_EDGE=true|false` must name the setting the installed build was
 * made with (B1): `false` also asserts the React root's display origin is
 * really below the status bar, so the run exercises the origin conversion.
 */
import { type PulledBundle, airplane, removePulledBundles } from './bundles';
import { ANDROID_PACKAGE } from './device';
import { ON_ANDROID, type Run, awaitBundles, clearBundles, must, report, startRun, useLog } from './harness';
import { LUMA_BRIGHT_MIN, LUMA_DARK_MAX } from './media';
import { type LogLine, Logcat, adb, resetScenario } from './scenario';
import {
  type Media,
  type Rect,
  assertMedia,
  boundsIn,
  bundleBySummary,
  displaySize,
  hasNode,
  moved,
  screenshotLumas,
  servedOf,
  uiDump,
} from './screen';

const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(6 * 60_000);

const LABEL = 'bugsee-secure-component';
const EDGE_TO_EDGE = process.env.E2E_EDGE_TO_EDGE;
const SERVED = /BugseeRN\s*:\s*secure (published|origin) .*served=/;

describeAndroid('<BugseeSecure> on an Android handset', () => {
  let log: Logcat;
  let run: Run;
  let nonce: string;
  let display: { width: number; height: number };
  let mountedBounds: Rect;
  let scrolledBounds: Rect;
  /** The last served line before the mounted report's bounds were read. */
  let servedMounted: LogLine;
  let originMounted: LogLine | undefined;
  let lastServed: LogLine;
  let unmountedDump: string;
  let mounted: PulledBundle;
  let scrolled: PulledBundle;
  let unmounted: PulledBundle;
  let media: { mounted: Media; scrolled: Media; unmounted: Media };

  const marker = async (what: string, from: number, timeoutMs = 30_000): Promise<LogLine> =>
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E secure-component ${what}.* nonce=${nonce}`), timeoutMs, from),
      `the secure-component scenario's "${what}" marker`,
      run.start,
    );

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
    await marker('still phase=mounted', rectMounted.index);
    const upTo = log.mark();
    servedMounted = must(log.all(SERVED, run.start, upTo).pop(), 'a served line before the mounted report', run.start);
    originMounted = log.all(/BugseeRN\s*:\s*secure origin /, run.start, upTo).pop();
    mountedBounds = boundsIn(await uiDump(), LABEL);
    // Precondition: the dump finished before the scenario scrolled.
    expect(log.all(new RegExp(`BUGSEE_E2E secure-component scrolling .*nonce=${nonce}`), run.start)).toEqual([]);

    const scrolling = await marker('scrolling', rectMounted.index);
    const rectScrolled = await marker('rect phase=scrolled', scrolling.index);
    await marker('uploaded phase=scrolled', rectScrolled.index);
    await marker('still phase=scrolled', rectScrolled.index);
    scrolledBounds = boundsIn(await uiDump(), LABEL);
    expect(log.all(new RegExp(`BUGSEE_E2E secure-component unmounting .*nonce=${nonce}`), run.start)).toEqual([]);

    const unmounting = await marker('unmounting', rectScrolled.index);
    await marker('uploaded phase=unmounted', unmounting.index);
    await marker('still phase=unmounted', unmounting.index);
    unmountedDump = await uiDump();
    lastServed = must(log.all(SERVED, run.start).pop(), 'a served line', run.start);

    report('display', display);
    report('rect markers', [rectMounted.text.trim(), rectScrolled.text.trim()]);
    report('uiautomator bounds', { mounted: mountedBounds, scrolled: scrolledBounds });
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

  it('unmounting disposes the mask', async () => {
    // Precondition: the component is really gone from the screen.
    expect(hasNode(unmountedDump, LABEL)).toBe(false);
    const lumas = await screenshotLumas(media.unmounted.screenshots, scrolledBounds, display.width);
    report('unmounted: last-bounds lumas', lumas);
    for (const luma of lumas) {
      expect(luma).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    }
    expect(servedOf(lastServed).count).toBe(0);
  });
});
