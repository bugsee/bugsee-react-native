/**
 * Task 6.8: blackout on an Android handset, asserted on what a report bundle
 * can show -- the screenshot, the view tree, the `capture` system trace and
 * the video -- rather than on the SDK's own say-so.
 *
 * Scenario `blackout` (scenarios/privacy.tsx), on the white stage: 3 s, then
 * `startBlackout()`; 2 s in, `captureViewHierarchy()`; 500 ms later
 * `upload('blackout-during-<n>')`; 2 s later `endBlackout()`; 3 s later
 * `upload('blackout-after-<n>')`. Scenario `blackout-prelaunch` calls
 * `startBlackout()` before `launch()`, which Android's SDK drops (the Phase 6
 * planner decision), and reads the state back once Launched.
 *
 * Retention is airplane mode (bundles.ts), on top of the placeholder token's
 * dead endpoint. Preconditions as for the other Android suites: the debug
 * build installed on the handset in device.ts, Metro serving this checkout
 * (`adb reverse tcp:8081 tcp:<E2E_METRO_PORT>`).
 *
 * Timestamps: the scenario's `t=` values are the device's `Date.now()`, the
 * same clock the SDK stamps bundle entries with.
 */
import {
  type PulledBundle,
  airplane,
  captureEvents,
  removePulledBundles,
} from './bundles';
import { ANDROID_PACKAGE } from './device';
import { ON_ANDROID, type Run, awaitBundles, clearBundles, escape, must, report, startRun, useLog } from './harness';
import { LUMA_DARK_MAX, blackoutPattern, frameLumas, imageSize, regionLuma, shadeOf } from './media';
import { type LogLine, Logcat, adb, resetScenario } from './scenario';
import { type Media, assertMedia, bundleBySummary, centreRegion, numberIn } from './screen';

const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(6 * 60_000);

type Entry = Record<string, unknown>;

describeAndroid('blackout on an Android handset', () => {
  let log: Logcat;
  let run: Run;
  let nonce: string;
  let started: LogLine;
  let uploadedDuring: LogLine;
  let ended: LogLine;
  let startedT: number;
  let uploadedDuringT: number;
  let endedT: number;
  let during: PulledBundle;
  let after: PulledBundle;
  let duringMedia: Media;
  let afterMedia: Media;

  let prelaunchRun: Run;
  let prelaunchCalled: LogLine | undefined;

  const marker = async (what: string, from: number, timeoutMs = 20_000): Promise<LogLine> =>
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E blackout ${escape(what)}.* nonce=${nonce}`), timeoutMs, from),
      `the blackout scenario's "${what}" marker`,
      run.start,
    );

  beforeAll(async () => {
    log = await Logcat.start();
    useLog(log, '6.8');
    await airplane(true);

    await clearBundles();
    run = await startRun('blackout');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    started = await marker('started', run.launched.index);
    uploadedDuring = await marker('uploaded-during', started.index);
    ended = await marker('ended', uploadedDuring.index);
    await marker('uploaded-after', ended.index);
    startedT = numberIn(started, 't');
    uploadedDuringT = numberIn(uploadedDuring, 't');
    endedT = numberIn(ended, 't');
    report('markers', log.all(/BUGSEE_E2E blackout /, run.start).map(line => line.text.trim()));

    const bundles = await awaitBundles(2);
    during = bundleBySummary(bundles, `blackout-during-${nonce}`);
    after = bundleBySummary(bundles, `blackout-after-${nonce}`);
    duringMedia = await assertMedia(during);
    afterMedia = await assertMedia(after);
    report('media', {
      during: { screenshots: duringMedia.screenshots.length, codecs: duringMedia.screenshotCodecs, video: duringMedia.videoCodec },
      after: { screenshots: afterMedia.screenshots.length, codecs: afterMedia.screenshotCodecs, video: afterMedia.videoCodec },
    });

    // The second scenario, on its own launch.
    await clearBundles();
    prelaunchRun = await startRun('blackout-prelaunch');
    prelaunchCalled = log.all(
      new RegExp(`BUGSEE_E2E blackout prelaunch-called nonce=${prelaunchRun.scenario.nonce}`),
      prelaunchRun.start,
    )[0];
    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E blackout prelaunch-cleared .*nonce=${prelaunchRun.scenario.nonce}`),
        20_000,
        prelaunchRun.launched.index,
      ),
      'the blackout-prelaunch scenario finishing',
      prelaunchRun.start,
    );
  });

  afterAll(async () => {
    try {
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        await airplane(false);
      } finally {
        const { removed, kept } = removePulledBundles();
        report('pulled bundle roots', { removed: removed.length, kept });
        log?.stop();
        resetScenario();
      }
    }
  });

  it('isBlackout and the lifecycle report the blackout', async () => {
    expect(started.text).toMatch(/ isBlackout=true /);
    expect(ended.text).toMatch(/ isBlackout=false /);

    const lifecycle = (name: string, from: number) =>
      log.all(new RegExp(`BUGSEE_E2E blackout lifecycle ${name} .*nonce=${nonce}`), from);
    const blackoutStarted = lifecycle('BlackoutStarted', run.start);
    const blackoutEnded = lifecycle('BlackoutEnded', run.start);
    report('lifecycle', { started: blackoutStarted.map(l => l.text.trim()), ended: blackoutEnded.map(l => l.text.trim()) });
    expect(blackoutStarted).toHaveLength(1);
    expect(blackoutEnded).toHaveLength(1);
    // Each event follows the call that caused it, by the JS clock: startedT
    // and endedT are read right after the call, before the isBlackout()
    // await the marker waits on, and a listener cannot run before them.
    const startedAt = numberIn(blackoutStarted[0]!, 't');
    const endedAt = numberIn(blackoutEnded[0]!, 't');
    report('lifecycle t vs calls', { startedT, startedAt, endedT, endedAt });
    expect(startedAt).toBeGreaterThanOrEqual(startedT);
    expect(startedAt).toBeLessThan(endedT);
    expect(endedAt).toBeGreaterThanOrEqual(endedT);
  });

  it('a report taken during blackout has a black screenshot and no view tree', async () => {
    const lumas: number[] = [];
    for (const file of duringMedia.screenshots) {
      lumas.push(await regionLuma(file, centreRegion(await imageSize(file))));
    }
    report('during: screenshot centre lumas', lumas);
    for (const luma of lumas) {
      expect(luma).toBeLessThanOrEqual(LUMA_DARK_MAX);
    }

    const trees = captureEvents(during, 'viewtree');
    const window = [startedT, uploadedDuringT + 1000];
    report('during: viewtree timestamps', { window, timestamps: trees.map(tree => tree.timestamp) });
    const inside = trees.filter(
      tree => typeof tree.timestamp === 'number' && tree.timestamp >= window[0]! && tree.timestamp <= window[1]!,
    );
    expect(inside).toEqual([]);

    // The example is wrapped, so the view tree is live: had the SDK asked
    // while blacked out, the bridge would have logged it.
    const asked = log.all(/BugseeRN\s*:\s*data request /, started.index, ended.index);
    report('data request lines inside the blackout', asked.map(line => line.text.trim()));
    expect(asked).toEqual([]);
    // Precondition: the same log does carry such lines outside it.
    expect(log.all(/BugseeRN\s*:\s*data request dr-\d+ type=vh /, run.start).length).toBeGreaterThan(0);
    // And outside the blackout the capture does produce trees: the report
    // taken after it carries the snapshot of its own upload.
    const afterTrees = captureEvents(after, 'viewtree').map(tree => tree.timestamp as number);
    report('after: viewtree timestamps', { endedT, afterTrees });
    expect(afterTrees.filter(t => t > endedT).length).toBeGreaterThanOrEqual(1);
  });

  it('the capture trace brackets the blackout', () => {
    const captures = captureEvents(after, 'traces.system').filter(trace => trace.name === 'capture');
    report('after: capture traces', captures);
    const stateOf = (trace: Entry) => (trace.value as { state?: unknown } | undefined)?.state;
    const near = (trace: Entry, t: number) =>
      typeof trace.timestamp === 'number' && Math.abs(trace.timestamp - t) <= 1000;

    const blackout = captures.find(trace => stateOf(trace) === 'blackout' && near(trace, startedT));
    expect(blackout).toBeDefined();
    const active = captures.find(
      trace =>
        stateOf(trace) === 'active' &&
        near(trace, endedT) &&
        (trace.timestamp as number) > (blackout!.timestamp as number),
    );
    expect(active).toBeDefined();
    report('after: bracketing traces', { blackout, active, startedT, endedT });
  });

  it('the video is black for the blackout and only for it', async () => {
    const frames = await frameLumas(afterMedia.video);
    report('after: video frames (t, luma)', frames.map(f => [Number(f.t.toFixed(3)), Math.round(f.luma)]));
    const pattern = blackoutPattern(frames);
    report('after: blackoutPattern', pattern);
    expect(pattern.ok).toBe(true);
    const expected = (endedT - startedT) / 1000;
    const darkSeconds = (pattern as { darkSeconds: number }).darkSeconds;
    report('after: darkSeconds vs ended-started', { darkSeconds, expected });
    expect(Math.abs(darkSeconds - expected)).toBeLessThanOrEqual(1.0);

    // Only for it: that is the one dark stretch with recording on both
    // sides. (Every Android bundle video, blacked out or not, also opens
    // with one black frame at t=0 and closes with two at report time -- an
    // SDK artefact at the recording's edges, recorded in the task report.)
    const shades = frames.map(f => shadeOf(f.luma));
    const interiorDarkRuns = shades.filter(
      (shade, i) =>
        shade === 'dark' &&
        shades[i - 1] !== 'dark' &&
        shades.slice(0, i).includes('bright') &&
        shades.slice(i).some(later => later === 'bright'),
    ).length;
    report('after: dark runs between bright frames', interiorDarkRuns);
    expect(interiorDarkRuns).toBe(1);
  });

  it('a blackout started before launch', () => {
    const prelaunchNonce = prelaunchRun.scenario.nonce;
    // Precondition: the call really ran before the SDK was Launched.
    const called = must(prelaunchCalled, 'the pre-launch startBlackout marker', prelaunchRun.start);
    expect(called.index).toBeLessThan(prelaunchRun.launched.index);

    const state = must(
      log.all(new RegExp(`BUGSEE_E2E blackout prelaunch isBlackout=\\w+ nonce=${prelaunchNonce}`), prelaunchRun.start)[0],
      'the post-launch isBlackout read',
      prelaunchRun.start,
    );
    const cleared = must(
      log.all(new RegExp(`BUGSEE_E2E blackout prelaunch-cleared isBlackout=\\w+ nonce=${prelaunchNonce}`), prelaunchRun.start)[0],
      'the isBlackout read after endBlackout',
      prelaunchRun.start,
    );
    report('prelaunch', [called.text.trim(), state.text.trim(), cleared.text.trim()]);
    // Android: the SDK drops a startBlackout() before launch (a logged no-op).
    expect(state.text).toMatch(/ isBlackout=false /);
    expect(cleared.text).toMatch(/ isBlackout=false /);
    // ...and says nothing about it: the lifecycle listener, subscribed before
    // the call, hears no BlackoutStarted for this run.
    expect(log.all(new RegExp(`BUGSEE_E2E blackout lifecycle BlackoutStarted .*nonce=${prelaunchNonce}`), prelaunchRun.start)).toEqual([]);
  });
});
