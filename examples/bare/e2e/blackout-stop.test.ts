/**
 * #143: a blackout ends with `stop()` -- launch, startBlackout, stop, launch,
 * and the SDK is not blacked out after the relaunch. The shared contract,
 * asserted on both platforms (Android's SDK ends the blackout itself; on iOS
 * it is the wrapper, see below).
 *
 * Covered, each its own scenario run (scenarios/api-lifecycle.ts, markers
 * `BUGSEE_E2E api bs|bps ...` and the `<scenario> event` lines recordEvents
 * logs for every lifecycle event):
 *
 *   api-blackout-stop           Launched, startBlackout(), stop(), launch():
 *                               isBlackout() is false after the relaunch, and
 *                               BlackoutStarted and BlackoutEnded were each
 *                               delivered exactly once, BlackoutEnded between
 *                               the stop() call and the relaunch (so stop()
 *                               caused it and the new session did not
 *                               re-deliver it).
 *   api-blackout-stop-idle      the same with NO startBlackout(): no
 *                               BlackoutStarted and no BlackoutEnded at all
 *                               (stop() must not invent an end), and
 *                               isBlackout() is false after the relaunch.
 *   api-blackout-prelaunch-stop startBlackout() and then stop() BEFORE the
 *                               first launch(): the blackout survives
 *                               (isBlackout() is true once Launched), and no
 *                               BlackoutEnded came before it. This is the
 *                               guard in the iOS workaround: a Stopped /
 *                               never-launched SDK is left alone. A
 *                               startBlackout() before a stop-less launch()
 *                               is blackout.test.ts's `blackout-prelaunch`.
 *
 * Not asserted: isBlackout() while Stopped (the SDKs differ), and what
 * relaunch() does to a blackout (platform-defined, src/index.ts).
 *
 * Why iOS needed a wrapper workaround, and when it can go: before
 * bugsee-react-native#153 the iOS SDK's `stop` left the blackout in force, so
 * it survived into the next `launch()` (the first case failed with
 * isBlackout=true and no BlackoutEnded). #153's `BGSRNEndBlackoutForStop`
 * (ios/Support, TODO(#143)) ends it ahead of `[Bugsee stop:]` while the SDK
 * is not Stopped. When bugsee-cocoa#268 lands -- `[Bugsee stop:]` ends an
 * active blackout itself and delivers BlackoutEnded exactly once -- bump the
 * pinned iOS SDK, delete the helper and its call in BugseeModule.mm; this
 * suite is the check that the SDK does it (the first two cases must stay
 * green with no wrapper help, and a doubled BlackoutEnded would show as a
 * count of 2).
 *
 * Preconditions as for the other scenario suites: Android needs the debug
 * build installed and Metro reachable (`adb reverse tcp:8081
 * tcp:<E2E_METRO_PORT>`); iOS needs `E2E_IOS_TARGET`. Run one platform at a
 * time per examples/bare checkout (the scenario JSON Metro serves is shared);
 * a stale Metro is restarted by port. Offline, the placeholder token
 * 00000000-0000-4000-8000-000000000000 against the dead endpoint.
 */
import { type Run, TARGET_NAME, clearBundles, describeDevice, report, startRun } from './harness';
import { apiMarker, wordAfter } from './api-markers';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';

jest.setTimeout(8 * 60_000);

describeDevice(`blackout and stop() on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('143');
  });

  afterAll(() => endRetainingSuite(log));

  /** This run's `<tag> event` lines for `name`, in log order. */
  const events = (tag: string, nonce: string, name: string, from: number, to?: number): LogLine[] =>
    log!.all(new RegExp(`BUGSEE_E2E api ${tag} event nonce=${nonce} name=${name}\\b`), from, to);

  const stopThenRelaunch = (scenario: string, withBlackout: boolean) => {
    describe(scenario, () => {
      let run: Run;
      let started: LogLine;
      let stopped: LogLine;
      let afterStop: LogLine;
      let relaunched: LogLine;
      let summary: LogLine;
      const tag = scenario.slice(4);

      beforeAll(async () => {
        await clearBundles();
        run = await startRun(scenario);
        const nonce = run.scenario.nonce;
        started = await apiMarker(log!, 'bs started', nonce, 20_000, run.launched.index, run.start);
        stopped = await apiMarker(log!, 'bs stopped', nonce, 30_000, started.index, run.start);
        afterStop = await apiMarker(log!, 'bs after-stop', nonce, 20_000, stopped.index, run.start);
        relaunched = await apiMarker(log!, 'bs relaunched', nonce, 45_000, afterStop.index, run.start);
        summary = await apiMarker(log!, 'bs summary', nonce, 20_000, relaunched.index, run.start);
        report('markers', [started, stopped, afterStop, relaunched, summary].map(l => l.text.trim()));
        report(
          'blackout events',
          log!.all(new RegExp(`BUGSEE_E2E api ${tag} event nonce=${nonce} name=Blackout`), run.start).map(l => l.text.trim()),
        );
      });

      it('the SDK relaunches (Launched) and is not blacked out', () => {
        expect(wordAfter(started.text, 'withBlackout')).toBe(String(withBlackout));
        // Precondition: the blackout was really in force before stop().
        expect(wordAfter(started.text, 'isBlackout')).toBe(String(withBlackout));
        expect(wordAfter(relaunched.text, 'status')).toBe('2');
        expect(wordAfter(relaunched.text, 'isBlackout')).toBe('false');
      });

      if (withBlackout) {
        it('BlackoutStarted and BlackoutEnded are each delivered exactly once, BlackoutEnded by stop()', () => {
          const nonce = run.scenario.nonce;
          const blackoutStarted = events(tag, nonce, 'BlackoutStarted', run.start);
          const blackoutEnded = events(tag, nonce, 'BlackoutEnded', run.start);
          expect(blackoutStarted).toHaveLength(1);
          expect(blackoutEnded).toHaveLength(1);
          expect(blackoutStarted[0]!.index).toBeLessThan(stopped.index);
          // Caused by the stop() call (between its marker and the relaunch),
          // not by the new session: nothing after the relaunch marker.
          expect(blackoutEnded[0]!.index).toBeGreaterThan(started.index);
          expect(blackoutEnded[0]!.index).toBeLessThan(relaunched.index);
          expect(events(tag, nonce, 'BlackoutEnded', relaunched.index)).toHaveLength(0);
        });
      } else {
        it('stop() with no blackout emits neither BlackoutStarted nor BlackoutEnded', () => {
          const nonce = run.scenario.nonce;
          expect(events(tag, nonce, 'BlackoutStarted', run.start)).toHaveLength(0);
          expect(events(tag, nonce, 'BlackoutEnded', run.start)).toHaveLength(0);
          expect(summary.index).toBeGreaterThan(relaunched.index);
        });
      }
    });
  };

  stopThenRelaunch('api-blackout-stop', true);
  stopThenRelaunch('api-blackout-stop-idle', false);

  describe('api-blackout-prelaunch-stop', () => {
    let run: Run;
    let called: LogLine;
    let stopped: LogLine;
    let launched: LogLine;
    let cleared: LogLine;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('api-blackout-prelaunch-stop');
      const nonce = run.scenario.nonce;
      // Logged before launch(), so look from the run's start.
      called = await apiMarker(log!, 'bps called', nonce, 20_000, run.start);
      stopped = await apiMarker(log!, 'bps stopped', nonce, 20_000, called.index, run.start);
      launched = await apiMarker(log!, 'bps launched', nonce, 30_000, stopped.index, run.start);
      cleared = await apiMarker(log!, 'bps cleared', nonce, 20_000, launched.index, run.start);
      report('markers', [called, stopped, launched, cleared].map(l => l.text.trim()));
    });

    it('a stop() before the first launch() does not cancel a pre-launch blackout', () => {
      const nonce = run.scenario.nonce;
      // Precondition: both calls ran before the SDK was Launched.
      expect(stopped.index).toBeLessThan(run.launched.index);
      expect(wordAfter(launched.text, 'isBlackout')).toBe('true');
      expect(wordAfter(cleared.text, 'isBlackout')).toBe('false');
      // The stop() of a never-launched SDK ended nothing: BlackoutEnded
      // belongs to the endBlackout() after launch.
      const ended = events('blackout-prelaunch-stop', nonce, 'BlackoutEnded', run.start);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.index).toBeGreaterThan(launched.index);
    });
  });
});
