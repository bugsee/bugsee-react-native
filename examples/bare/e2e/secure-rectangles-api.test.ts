/**
 * N-04: `setSecureRectangles` on both platforms, read off the report's
 * screenshot (API-30a on iOS, API-30b everywhere).
 *
 * Scenario `api-secure-rects` (scenarios/api.tsx `SecureRectsStage`): a
 * white screen with two white probes, A and B. Ground truth is each probe's
 * `measureInWindow` rectangle, logged with `Dimensions.get('screen')` (points
 * on iOS, dp on Android; the example is edge-to-edge, so the window is the
 * screen), mapped onto a screenshot at `screenshot.width / screen.width`.
 * White on white: a dark probe can only be the SDK's mask.
 *
 *   set    setSecureRectangles([A])             A masked, B clear
 *   other  setSecureRectangles([]) for display 0, [B] for display 1
 *                                               A and B clear on display 0
 *   clear  setSecureRectangles([], 1)          A and B clear
 *
 * A ring around A (its rectangle grown by a quarter on every side, minus A)
 * stays bright in `set`: the mask is the probe, not the screen.
 */
import { type PulledBundle } from './bundles';
import { apiMarker } from './api-markers';
import { type Run, TARGET_NAME, awaitBundles, describeDevice, report, startRun, stopApp } from './harness';
import { LUMA_BRIGHT_MIN, LUMA_DARK_MAX, imageSize, regionLuma } from './media';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';
import { type Rect, markerRect, markerScreen, regionOnImage } from './screen';

jest.setTimeout(5 * 60_000);

describeDevice(`setSecureRectangles on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let probeA: LogLine;
  let probeB: LogLine;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    log = await beginRetainingSuite('N-04');
    run = await startRun('api-secure-rects');
    const nonce = run.scenario.nonce;
    probeA = await apiMarker(log, 'rects probe=a .*', nonce, 20_000, run.start);
    probeB = await apiMarker(log, 'rects probe=b .*', nonce, 20_000, run.start);
    await apiMarker(log, 'rects uploaded step=clear', nonce, 45_000, run.start);
    bundles = await awaitBundles(3, 60_000);
    await stopApp();
    report('probe A', probeA.text.trim());
    report('probe B', probeB.text.trim());
  });

  afterAll(() => endRetainingSuite(log));

  async function lumas(step: string): Promise<{ a: number; b: number; ring: number }> {
    const summary = `api-rects-${step}-${run.scenario.nonce}`;
    const bundle = bundles.find(b => b.request.summary === summary);
    if (bundle === undefined) {
      throw new Error(`no bundle ${summary} among ${JSON.stringify(bundles.map(b => b.request.summary))}`);
    }
    const shot = (bundle.binaries.get('screenshot') ?? [])[0];
    if (shot === undefined) {
      throw new Error(`${summary} has no screenshot`);
    }
    const screen = markerScreen(probeA);
    const { width } = await imageSize(shot);
    const a = markerRect(probeA);
    const grow = (r: Rect, f: number): Rect => {
      const dx = (r.right - r.left) * f;
      const dy = (r.bottom - r.top) * f;
      return { left: r.left - dx, top: r.top - dy, right: r.right + dx, bottom: r.bottom + dy };
    };
    // The ring: four strips just outside A.
    const outer = grow(a, 0.25);
    const strips: Rect[] = [
      { left: outer.left, top: outer.top, right: outer.right, bottom: a.top - 2 },
      { left: outer.left, top: a.bottom + 2, right: outer.right, bottom: outer.bottom },
      { left: outer.left, top: a.top, right: a.left - 2, bottom: a.bottom },
      { left: a.right + 2, top: a.top, right: outer.right, bottom: a.bottom },
    ];
    const ring = Math.min(...(await Promise.all(strips.map(s => regionLuma(shot, regionOnImage(s, screen.width, width, 0.9))))));
    const result = {
      a: await regionLuma(shot, regionOnImage(a, screen.width, width, 0.8)),
      b: await regionLuma(shot, regionOnImage(markerRect(probeB), screen.width, width, 0.8)),
      ring,
    };
    report(`${step} lumas`, result);
    return result;
  }

  it('[API-30a] a rectangle set for display 0 masks the probe it was measured from, and only it', async () => {
    const { a, b, ring } = await lumas('set');
    expect(a).toBeLessThanOrEqual(LUMA_DARK_MAX);
    expect(b).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    expect(ring).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
  });

  it('[API-30b] [] clears display 0, and a rectangle for display 1 leaves display 0 unmasked', async () => {
    const { a, b } = await lumas('other');
    expect(a).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    expect(b).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
  });

  it('[API-30b] [] for display 1 clears it too: nothing is masked', async () => {
    const { a, b } = await lumas('clear');
    expect(a).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
    expect(b).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
  });
});
