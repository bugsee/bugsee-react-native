/**
 * bugsee/bugsee-react-native#86: what `<BugseeSecure>`'s clipping costs.
 *
 * Scenario `secure-perf` (scenarios/secure-visible.tsx): 20 `<BugseeSecure>`
 * in four horizontal ScrollViews, under two `overflow: 'hidden'` views, in a
 * vertical ScrollView, so every view has four clipping ancestors. Every tick
 * of the shared re-measure loop, which measures all 20 views and their
 * ancestors and publishes, is timed on the JS thread with `performance.now()`
 * for 40 s with nothing moving and all 20 views on screen (`static`: the
 * re-measuring alone, and the most clipping work), then for 40 s with every
 * ScrollView scrolled every 400 ms (`scrolling`: rectangles keep changing, so
 * they also cross the bridge, and views go partly and fully out of sight).
 *
 * The hook is the app's own (a `setInterval` wrapper around the 20 views'
 * mount), so the same test times any version of the package: the baseline is
 * this test against origin/main's `src/secure`. `E2E_PERF_LABEL` names the
 * build in the report line (e.g. `new`, `main`).
 */
import {
  TARGET_NAME,
  describeDevice,
  escape,
  must,
  report,
  startDeviceLog,
  startRun,
  stopApp,
  stopDeviceLog,
} from './harness';
import { type DeviceLog, resetScenario } from './scenario';

jest.setTimeout(6 * 60_000);

/** The budget for one tick of the loop, all 20 views included. */
const P95_BUDGET_MS = 2;
const MIN_TICKS = 300;

/**
 * Each of `static`, `scrolling` and `clipped` also reports `<mode>-frames`:
 * every frame callback of the per-frame re-measure that clipped views go on
 * (their ticks skip them). `clipped` has every view partly clipped and
 * moving, so all 20 are on it: the worst case. A frame mode's "ticks" are
 * frames.
 *
 * `watch` times, every frame for 20 s, the check each withdrawn view runs per
 * frame (BugseeSecure's frame callback), for all 20 views: what it costs if
 * every one of them were withdrawn at once. Its "ticks" are frames.
 */
const MODES = [
  'static',
  'static-frames',
  'scrolling',
  'scrolling-frames',
  'clipped',
  'clipped-frames',
  'watch',
] as const;

/** Frame modes run only while some view is clipped: only `clipped-frames` must have many. */
const minTicks = (mode: string): number => (mode.endsWith('-frames') && mode !== 'clipped-frames' ? 0 : MIN_TICKS);

describeDevice(`<BugseeSecure> re-measure cost on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  const results = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    log = await startDeviceLog('#86 perf', '#86 perf');
    const run = await startRun('secure-perf');
    const nonce = run.scenario.nonce;
    for (const mode of MODES) {
      const done = new RegExp(`BUGSEE_E2E secure-perf (result mode=${mode}|threw) .*nonce=${escape(nonce)}`);
      const line = must(await log.waitFor(done, 240_000, run.start), `the secure-perf ${mode} result`, run.start);
      const result = Object.fromEntries(
        [...line.text.matchAll(/(\w+)=(\S+)/g)].map(([, key, value]) => [key!, value!]),
      );
      results.set(mode, result);
      report('secure-perf', { label: process.env.E2E_PERF_LABEL ?? 'unlabelled', dev: run.dev, ...result });
    }
  });

  afterAll(async () => {
    try {
      await stopApp();
    } finally {
      stopDeviceLog(log);
      resetScenario();
    }
  });

  describe.each(MODES)('%s', (mode) => {
    it('timed the one shared loop over enough ticks', () => {
      const result = results.get(mode)!;
      expect(result.intervals).toBe('1');
      expect(result.secures).toBe('20');
      expect(Number(result.ticks)).toBeGreaterThanOrEqual(minTicks(mode));
    });

    it(`keeps p95 of a tick under ${P95_BUDGET_MS} ms`, () => {
      const result = results.get(mode)!;
      if (result.ticks === '0') {
        return;
      }
      expect(Number(result.p95)).toBeLessThan(P95_BUDGET_MS);
    });
  });
});

/**
 * Scenario `secure-perf-many`: 200 `<BugseeSecure>` in four still
 * ScrollViews, every one partly clipped or wholly out of sight. Once they
 * have settled, a frame costs only the four watched ScrollView contents
 * (`many-frames`), and a tick only its bounded turns of parked views
 * (`many`).
 */
describeDevice(`<BugseeSecure> cost of 200 still, clipped views on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  const results = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    log = await startDeviceLog('#86 perf many', '#86 perf many');
    const run = await startRun('secure-perf-many');
    const nonce = run.scenario.nonce;
    for (const mode of ['many', 'many-frames']) {
      const done = new RegExp(`BUGSEE_E2E secure-perf (result mode=${mode}|threw) .*nonce=${escape(nonce)}`);
      const line = must(await log.waitFor(done, 120_000, run.start), `the secure-perf ${mode} result`, run.start);
      const result = Object.fromEntries(
        [...line.text.matchAll(/(\w+)=(\S+)/g)].map(([, key, value]) => [key!, value!]),
      );
      results.set(mode, result);
      report('secure-perf', { label: process.env.E2E_PERF_LABEL ?? 'unlabelled', dev: run.dev, ...result });
    }
  });

  afterAll(async () => {
    try {
      await stopApp();
    } finally {
      stopDeviceLog(log);
      resetScenario();
    }
  });

  it('timed every tick and frame of 200 views', () => {
    expect(results.get('many')!.secures).toBe('200');
    expect(Number(results.get('many')!.ticks)).toBeGreaterThanOrEqual(MIN_TICKS);
    expect(Number(results.get('many-frames')!.ticks)).toBeGreaterThanOrEqual(MIN_TICKS);
  });

  // Every tick re-checks every parked view by measuring it alone: O(n) per
  // tick, the same per-view self-measure main makes every tick for every
  // view. Release keeps the 2 ms budget. Debug (React's dev build) spends
  // about 12 µs per view on it, so 200 views take ~2.5 ms there; main's
  // Debug p95 for these 200 views is in the PR's perf table (for 20 views it
  // was already 2.2 ms). The scoped Debug budget for this mode is 4 ms.
  const MANY_DEBUG_TICK_BUDGET_MS = 4;

  it('keeps p95 of a tick under 2 ms in Release, 4 ms in Debug', () => {
    const result = results.get('many')!;
    const budget = result.dev === 'true' ? MANY_DEBUG_TICK_BUDGET_MS : P95_BUDGET_MS;
    expect(Number(result.p95)).toBeLessThan(budget);
  });

  it('keeps a frame near nothing: p95 under 0.5 ms', () => {
    expect(Number(results.get('many-frames')!.p95)).toBeLessThan(0.5);
  });
});
