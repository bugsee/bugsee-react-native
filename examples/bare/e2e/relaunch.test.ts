/**
 * N-03: relaunch() with changed options (API-02), launch() after stop()
 * (API-03b, FLOW-41) and a second launch() while Launched (API-01d).
 *
 * Scenarios (scenarios/api-lifecycle.ts), each after the app's own launch:
 *   api-relaunch           uploads `api-rl-before-<n>`, relaunch() with
 *                          capture.screenshot=false and duration 45, reads both
 *                          back, uploads `api-rl-after-<n>`.
 *   api-launch-after-stop  stop(), then launch() with the app's options, waits
 *                          for Launched, a console line, uploads `api-las-<n>`.
 *   api-second-launch      launch() again with duration 30 while Launched; the
 *                          status, the events and duration must not move.
 */
import { type PulledBundle, captureEvents } from './bundles';
import { type Settled, apiMarker, jsonAfter, wordAfter } from './api-markers';
import { type Run, TARGET_NAME, awaitBundles, clearBundles, describeDevice, report, startRun, stopApp } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';

jest.setTimeout(8 * 60_000);

function types(bundle: PulledBundle): string[] {
  return bundle.manifest.files.map(file => file.type);
}

function bySummary(bundles: readonly PulledBundle[], summary: string): PulledBundle {
  const found = bundles.filter(b => b.request.summary === summary);
  if (found.length !== 1) {
    throw new Error(`expected one bundle ${summary}, got ${JSON.stringify(bundles.map(b => b.request.summary))}`);
  }
  return found[0]!;
}

describeDevice(`relaunch, launch after stop, and a second launch on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-03');
  });

  afterAll(() => endRetainingSuite(log));

  describe('relaunch(options)', () => {
    let run: Run;
    let first: LogLine;
    let settled: LogLine;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('api-relaunch');
      const nonce = run.scenario.nonce;
      first = await apiMarker(log!, 'relaunch first', nonce, 20_000, run.start);
      settled = await apiMarker(log!, 'relaunch settled', nonce, 45_000, first.index, run.start);
      await apiMarker(log!, 'relaunch uploaded', nonce, 30_000, settled.index, run.start);
      bundles = await awaitBundles(2, 60_000);
      await stopApp();
      report('first', first.text.trim());
      report('settled', settled.text.trim());
      report('bundles', bundles.map(b => ({ summary: b.request.summary, files: types(b) })));
    });

    it('[API-02] relaunch() settles and the SDK is Launched again with the new options read back', () => {
      expect(wordAfter(first.text, 'duration')).toBe('90');
      expect(jsonAfter<Settled>(settled.text, 'result').ok).toBe(true);
      expect(wordAfter(settled.text, 'status')).toBe('2');
      expect(wordAfter(settled.text, 'duration')).toBe('45');
      expect(wordAfter(settled.text, 'screenshot')).toBe('false');
    });

    it('[API-02] the new options take effect: the report after relaunch has no screenshot, the one before has', () => {
      const nonce = run.scenario.nonce;
      expect(types(bySummary(bundles, `api-rl-before-${nonce}`))).toContain('screenshot');
      expect(types(bySummary(bundles, `api-rl-after-${nonce}`))).not.toContain('screenshot');
    });
  });

  describe('launch() after stop()', () => {
    let run: Run;
    let stopped: LogLine;
    let relaunched: LogLine;
    let summary: LogLine;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('api-launch-after-stop');
      const nonce = run.scenario.nonce;
      stopped = await apiMarker(log!, 'las stopped', nonce, 30_000, run.start);
      relaunched = await apiMarker(log!, 'las relaunched', nonce, 45_000, stopped.index, run.start);
      summary = await apiMarker(log!, 'las summary', nonce, 30_000, relaunched.index, run.start);
      bundles = await awaitBundles(1, 60_000);
      await stopApp();
      report('stopped', stopped.text.trim());
      report('relaunched', relaunched.text.trim());
      report('summary', summary.text.trim());
      report('bundles', bundles.map(b => ({ summary: b.request.summary, files: types(b) })));
    });

    it('[API-03b] launch() after stop() in the same process reaches Launched again', () => {
      expect(jsonAfter<Settled>(stopped.text, 'result')).toEqual({ ok: true, value: true });
      expect(wordAfter(stopped.text, 'status')).toBe('0');
      expect(jsonAfter<Settled>(relaunched.text, 'result').ok).toBe(true);
      expect(wordAfter(relaunched.text, 'status')).toBe('2');
      const events = jsonAfter<string[]>(summary.text, 'events').filter(e => /^(Launching|Launched|Stopping|Stopped)$/.test(e));
      expect(events).toEqual(['Launching', 'Launched', 'Stopping', 'Stopped', 'Launching', 'Launched']);
    });

    it('[API-03b][FLOW-41] capture resumes: the report filed after the second launch carries this session', () => {
      const nonce = run.scenario.nonce;
      const bundle = bySummary(bundles, `api-las-${nonce}`);
      expect(types(bundle)).toEqual(expect.arrayContaining(['video', 'screenshot', 'log']));
      const console = captureEvents(bundle, 'log').filter(e => e.message === `api-las console ${nonce}`);
      expect(console).toHaveLength(1);
    });
  });

  describe('a second launch() while Launched', () => {
    let run: Run;
    let result: LogLine;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('api-second-launch');
      const nonce = run.scenario.nonce;
      result = await apiMarker(log!, 'second result', nonce, 30_000, run.start);
      await apiMarker(log!, 'second uploaded', nonce, 10_000, result.index, run.start);
      bundles = await awaitBundles(1, 60_000);
      await stopApp();
      report('result', result.text.trim());
      report('bundles', bundles.map(b => ({ summary: b.request.summary })));
    });

    it('[API-01d] resolves, starts no second session, and keeps the first launch options', () => {
      const settled = jsonAfter<Settled>(result.text, 'result');
      report('second launch() settled', settled);
      expect(settled.ok).toBe(true);
      expect(wordAfter(result.text, 'status')).toBe('2');
      expect(jsonAfter<string[]>(result.text, 'events')).toEqual([]);
      expect(wordAfter(result.text, 'duration')).toBe('90');
      expect(bundles.map(b => b.request.summary)).toEqual([`api-second-${run.scenario.nonce}`]);
    });
  });
});
