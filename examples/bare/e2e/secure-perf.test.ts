/**
 * bugsee/bugsee-react-native#86: what `<BugseeSecure>`'s clipping costs.
 *
 * Scenario `secure-perf` (scenarios/secure-visible.tsx): 20 `<BugseeSecure>`
 * in four horizontal ScrollViews, under two `overflow: 'hidden'` views, in a
 * vertical ScrollView that is scrolled every 400 ms, so every view has four
 * clipping ancestors and rectangles keep changing (and crossing the bridge).
 * Every tick of the shared re-measure loop, which measures all 20 views and
 * their ancestors and publishes, is timed on the JS thread with
 * `performance.now()` for 35 s.
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

describeDevice(`<BugseeSecure> re-measure cost on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let result: Record<string, string>;

  beforeAll(async () => {
    log = await startDeviceLog('#86 perf', '#86 perf');
    const run = await startRun('secure-perf');
    const nonce = run.scenario.nonce;
    const done = new RegExp(`BUGSEE_E2E secure-perf (result|threw) .*nonce=${escape(nonce)}`);
    const line = must(
      await log.waitFor(done, 120_000, run.start),
      'the secure-perf result',
      run.start,
    );
    result = Object.fromEntries(
      [...line.text.matchAll(/(\w+)=(\S+)/g)].map(([, key, value]) => [key!, value!]),
    );
    report('secure-perf', { label: process.env.E2E_PERF_LABEL ?? 'unlabelled', dev: run.dev, ...result });
  });

  afterAll(async () => {
    try {
      await stopApp();
    } finally {
      stopDeviceLog(log);
      resetScenario();
    }
  });

  it('timed the one shared loop over enough ticks', () => {
    expect(result.intervals).toBe('1');
    expect(result.secures).toBe('20');
    expect(Number(result.ticks)).toBeGreaterThanOrEqual(MIN_TICKS);
  });

  it(`keeps p95 of a tick under ${P95_BUDGET_MS} ms`, () => {
    expect(Number(result.p95)).toBeLessThan(P95_BUDGET_MS);
  });
});
