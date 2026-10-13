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

jest.setTimeout(4 * 60_000);

/** The budget for one tick of the loop, all 20 views included. */
const P95_BUDGET_MS = 2;
const MIN_TICKS = 300;

const MODES = ['static', 'scrolling'] as const;

describeDevice(`<BugseeSecure> re-measure cost on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  const results = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    log = await startDeviceLog('#86 perf', '#86 perf');
    const run = await startRun('secure-perf');
    const nonce = run.scenario.nonce;
    for (const mode of MODES) {
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

  describe.each(MODES)('%s', (mode) => {
    it('timed the one shared loop over enough ticks', () => {
      const result = results.get(mode)!;
      expect(result.intervals).toBe('1');
      expect(result.secures).toBe('20');
      expect(Number(result.ticks)).toBeGreaterThanOrEqual(MIN_TICKS);
    });

    it(`keeps p95 of a tick under ${P95_BUDGET_MS} ms`, () => {
      expect(Number(results.get(mode)!.p95)).toBeLessThan(P95_BUDGET_MS);
    });
  });
});
