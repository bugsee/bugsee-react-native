/**
 * N-05 (FLOW-13, G16): the console level map, and the native-only log stream
 * filtered exactly once.
 *
 * Scenario `api-console-levels` (scenarios/api-ui.ts) installs a log filter
 * that counts its own lines, then calls console.error/warn/log/info/debug
 * once each, then `rctLog('warn', ...)` -- an RCTLog warning with no console
 * call behind it (iOS `_RCTLogNativeInternal`; Android `FLog`, logcat tag
 * `unknown:ReactNative`) -- and uploads.
 *
 * The console patch maps error 1, warn 2, log 3, info 3, debug 4 (Custom,
 * source 98). The native-only line on iOS is forwarded by the bridge's
 * RCTLog hook at warn -> 2 (Custom); on Android it is a logcat line the SDK
 * reads itself. Either way: one line in the report, one filter call.
 *
 * Debug build: RN also echoes console.* through RCTLog / logcat, which the
 * bridge must not count twice (console-dedup.test.ts proves the dedup; this
 * proves the levels survive it).
 */
import { type PulledBundle, captureEvents } from './bundles';
import { apiMarker, jsonAfter } from './api-markers';
import { ON_IOS, type Run, TARGET_NAME, awaitBundles, describeDevice, report, startRun, stopApp } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';

jest.setTimeout(5 * 60_000);

const EXPECTED: Record<string, number> = { error: 1, warn: 2, log: 3, info: 3, debug: 4 };

describeDevice(`console levels and the native-only log stream on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let counts: Record<string, number>;
  let bundle: PulledBundle;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-05');
    run = await startRun('api-console-levels');
    const line: LogLine = await apiMarker(log, 'levels counts', run.scenario.nonce, 30_000, run.start);
    counts = jsonAfter<Record<string, number>>(line.text, 'counts');
    await apiMarker(log, 'levels uploaded', run.scenario.nonce, 10_000, line.index, run.start);
    const bundles = await awaitBundles(1, 60_000);
    bundle = bundles.find(b => b.request.summary === `api-levels-${run.scenario.nonce}`)!;
    await stopApp();
    report('filter counts', counts);
    report(
      'report lines',
      captureEvents(bundle, 'log')
        .filter(e => String(e.message ?? '').includes(run.scenario.nonce))
        .map(e => ({ message: e.message, level: e.level, source: e.source })),
    );
  });

  afterAll(() => endRetainingSuite(log));

  function linesOf(kind: string): Array<Record<string, unknown>> {
    return captureEvents(bundle, 'log').filter(e => String(e.message ?? '').includes(`api-lvl ${kind} ${run.scenario.nonce}`));
  }

  for (const [method, level] of Object.entries(EXPECTED)) {
    it(`[FLOW-13] console.${method} lands once, as Custom (98) at level ${level}, and is filtered once`, () => {
      const lines = linesOf(method);
      expect(lines.map(e => ({ level: e.level, source: e.source }))).toEqual([{ level, source: 98 }]);
      expect(counts[method]).toBe(1);
    });
  }

  /**
   * iOS (XS, beta5, Debug, 2026-10-07): the line lands three times -- once
   * as the bridge's Custom (98) line at Warning (2), and twice more as
   * source 2 at level 4, RN's own stderr/os_log output of the RCTLog, which
   * the SDK captures -- and the log filter runs three times (counts.rct 3).
   * BGSRNConsoleCapture.mm forwards a native RCTLog line without arming the
   * echo drop it arms for console.* lines. A wrapper bug (G16), to fix:
   * sdk-issues-filed.md "to fix (wrapper)". Android: once.
   */
  const itNativeOnly = ON_IOS ? it.failing : it;
  itNativeOnly('[FLOW-13] a native RCTLog warning with no console call lands once and is filtered once', () => {
    const lines = linesOf('rct');
    report('native-only line', lines);
    expect(lines).toHaveLength(1);
    expect(counts.rct).toBe(1);
    if (ON_IOS) {
      // The bridge's RCTLog hook: warn -> Warning (2), Custom.
      expect({ level: lines[0]!.level, source: lines[0]!.source }).toEqual({ level: 2, source: 98 });
    }
  });
});
