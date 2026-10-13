/**
 * `<BugseeSecure>` publishes only what is on screen (bugsee/bugsee-react-native#86),
 * asserted by e2e/secure-visible.test.ts, and what that costs each re-measure,
 * asserted by e2e/secure-perf.test.ts.
 *
 *   secure-visible  one `<BugseeSecure>` in a ScrollView, scrolled fully in,
 *                   partly out, fully out and back; then two sibling "tabs",
 *                   each holding a `<BugseeSecure>`, the inactive one styled
 *                   `display: 'none'`. After each change it holds still and
 *                   logs `secure-visible phase=<phase>` with the window
 *                   rectangles (points) of the ScrollView's viewport and of a
 *                   transparent twin of each secure view on screen. The test
 *                   compares them with the rectangles native says it was
 *                   given (`BugseeRN secure published ... raw=`).
 *   secure-perf     20 `<BugseeSecure>` in four horizontal ScrollViews, under
 *                   two `overflow: 'hidden'` views, in a vertical ScrollView;
 *                   at rest all 20 are on screen. Every tick of the shared
 *                   re-measure loop is timed with `performance.now()` for 40 s
 *                   with nothing moving, then for 40 s with every ScrollView
 *                   scrolled every 400 ms (moving views partly and fully out
 *                   of sight), then for 40 s with all 20 taller than their
 *                   rows (every one partly clipped, so on the per-frame
 *                   re-measure) and nudged every 400 ms, each mode timing
 *                   both ticks and frame callbacks (`<mode>-frames`), then for
 *                   20 s the per-frame check a withdrawn
 *                   view runs (`isHidden`, props only) for all 20 every
 *                   frame, and each mode's percentiles logged as
 *                   `secure-perf result`.
 *
 * The perf hook is the app's own, not the package's: while the 20 views mount
 * (their layout effects start the loop's one interval), `setInterval` is
 * wrapped so the interval with the loop's period runs its callback timed. The
 * same hook therefore times any version of the package, which is how the
 * baseline is taken.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PixelRatio, ScrollView, StyleSheet, View } from 'react-native';
import { BugseeSecure } from '@bugsee/react-native';
// Deep-imported for secure-perf's `watch` mode only: the per-frame check a
// withdrawn view runs, timed on the same views (as scenarios/channel.ts does).
import { ancestryOfInstance, isHidden } from '@bugsee/react-native/src/secure/ancestry';

export const SECURE_VISIBLE_SCENARIOS = ['secure-visible', 'secure-perf', 'secure-perf-many'] as const;

export type SecureVisibleScenario = (typeof SECURE_VISIBLE_SCENARIOS)[number];

export function isSecureVisibleScenario(name: string): name is SecureVisibleScenario {
  return (SECURE_VISIBLE_SCENARIOS as readonly string[]).includes(name);
}

/** The package's `SECURE_REMEASURE_MS`: the period of the interval the perf hook times. */
const REMEASURE_MS = 100;
/** From a change to the marker: several re-measures, all settled. */
const SETTLE_MS = 1_200;
/** How long secure-perf times the loop for: 400 ticks at 100 ms, 300 at the least. */
const PERF_MS = 40_000;
const PERF_WARMUP_MS = 2_000;
/** How long secure-perf's `watch` mode times frames for. */
const WATCH_MS = 20_000;

function mark(message: string): void {
  console.log(`BUGSEE_E2E ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type Measurable = { measureInWindow(cb: (x: number, y: number, w: number, h: number) => void): void };

/** `x,y,w,h` in window points, or `none` when there is nothing to measure. */
function measured(view: Measurable | null): Promise<string> {
  return new Promise(resolve => {
    if (view === null) {
      resolve('none');
      return;
    }
    view.measureInWindow((x, y, w, h) => resolve(`${x},${y},${w},${h}`));
  });
}

const VIEWPORT = { position: 'absolute', top: 120, left: 0, right: 0, height: 300 } as const;
const SCROLLED = { position: 'absolute', top: 100, left: 40, width: 200, height: 100 } as const;
const TABS = { position: 'absolute', top: 460, left: 0, right: 0, height: 200 } as const;
const TAB_A = { position: 'absolute', top: 20, left: 40, width: 120, height: 60 } as const;
const TAB_B = { position: 'absolute', top: 100, left: 200, width: 120, height: 60 } as const;

/** Scroll offsets: fully in, top half cut off by the viewport, fully out. */
const PHASES = [
  ['visible', 0],
  ['partial', 150],
  ['out', 600],
  ['back', 0],
] as const;

function SecureVisibleProbe({ nonce }: { nonce: string }) {
  const scroll = useRef<ScrollView>(null);
  const twin = useRef<View>(null);
  const twinA = useRef<View>(null);
  const twinB = useRef<View>(null);
  const [tab, setTab] = useState<'A' | 'B'>('A');

  useEffect(() => {
    const logPhase = async (phase: string, tabNow: 'A' | 'B') => {
      const viewport = await measured(scroll.current as unknown as Measurable | null);
      const self = await measured(twin.current);
      const tabRect = await measured(tabNow === 'A' ? twinA.current : twinB.current);
      mark(
        `secure-visible phase=${phase} viewport=${viewport} self=${self} tab=${tabNow}:${tabRect} ` +
          `ratio=${PixelRatio.get()} nonce=${nonce}`,
      );
    };
    (async () => {
      await sleep(1500);
      for (const [phase, y] of PHASES) {
        scroll.current?.scrollTo({ y, animated: false });
        await sleep(SETTLE_MS);
        await logPhase(phase, 'A');
      }
      setTab('B');
      await sleep(SETTLE_MS);
      await logPhase('tab-b', 'B');
      setTab('A');
      await sleep(SETTLE_MS);
      await logPhase('tab-a', 'A');
      mark(`secure-visible done nonce=${nonce}`);
    })().catch((error: unknown) => {
      mark(`secure-visible threw ${String(error)} nonce=${nonce}`);
    });
  }, [nonce]);

  return (
    <View style={styles.stage}>
      <ScrollView ref={scroll} style={VIEWPORT} contentContainerStyle={styles.tall}>
        <BugseeSecure style={SCROLLED} />
        <View ref={twin} collapsable={false} pointerEvents="none" style={SCROLLED} />
      </ScrollView>
      <View style={TABS}>
        <View style={[StyleSheet.absoluteFill, { display: tab === 'A' ? 'flex' : 'none' }]}>
          <BugseeSecure style={TAB_A} />
          <View ref={twinA} collapsable={false} pointerEvents="none" style={TAB_A} />
        </View>
        <View style={[StyleSheet.absoluteFill, { display: tab === 'B' ? 'flex' : 'none' }]}>
          <BugseeSecure style={TAB_B} />
          <View ref={twinB} collapsable={false} pointerEvents="none" style={TAB_B} />
        </View>
      </View>
    </View>
  );
}

/** Tick durations (ms) of the timed interval. */
const tickDurations: number[] = [];
let timedIntervals = 0;
/** Ends the window in which new intervals are timed. */
let endTimingWindow: (() => void) | undefined;

/**
 * Wraps `setInterval` until the returned function is called: an interval
 * with the loop's period runs its callback timed.
 */
function timeLoopIntervals(): () => void {
  const real = globalThis.setInterval;
  const wrapped = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== REMEASURE_MS) {
      return real(callback, ms, ...args);
    }
    timedIntervals += 1;
    return real(() => {
      const start = performance.now();
      callback(...args);
      tickDurations.push(performance.now() - start);
    }, ms);
  }) as typeof setInterval;
  globalThis.setInterval = wrapped;
  return () => {
    globalThis.setInterval = real;
  };
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

const ROWS = 4;
const PER_ROW = 5;

/** A view inside each secure view: the same ancestors, one host deeper. */
const insides: Array<View | null> = [];

function PerfSecures({ rows, tall }: { rows: { current: Array<ScrollView | null> }; tall: boolean }) {
  // After every child's layout effect: the loop's interval has started.
  useLayoutEffect(() => {
    endTimingWindow?.();
    endTimingWindow = undefined;
  }, []);
  return (
    <>
      {Array.from({ length: ROWS }, (_, row) => (
        <ScrollView
          key={row}
          ref={view => {
            rows.current[row] = view;
          }}
          horizontal
          style={styles.row}
          contentContainerStyle={styles.wide}>
          {Array.from({ length: PER_ROW }, (__, i) => (
            <BugseeSecure
              key={i}
              style={[styles.perfSecure, { left: 10 + 78 * i }, tall ? styles.perfSecureTall : null]}>
              <View
                ref={inside => {
                  insides[row * PER_ROW + i] = inside;
                }}
                collapsable={false}
                style={styles.fill}
              />
            </BugseeSecure>
          ))}
        </ScrollView>
      ))}
    </>
  );
}

function SecurePerfProbe({ nonce }: { nonce: string }) {
  const outer = useRef<ScrollView>(null);
  const rows = useRef<Array<ScrollView | null>>([]);
  const [mountedSecures, setMountedSecures] = useState(false);
  // secure-perf's `clipped` mode: every view taller than its row, so all 20
  // are cut by their row's viewport and on the per-frame re-measure.
  const [tall, setTall] = useState(false);

  useEffect(() => {
    endTimingWindow = timeLoopIntervals();
    setMountedSecures(true);
  }, []);

  useEffect(() => {
    if (!mountedSecures) {
      return undefined;
    }
    let cancelled = false;
    let scroller: ReturnType<typeof setInterval> | undefined;
    const offsets = [0, 250, 700, 1200];
    let step = 0;
    const f = (value: number) => value.toFixed(3);
    const report = (mode: string, durations: readonly number[]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
      mark(
        `secure-perf result mode=${mode} ticks=${sorted.length} intervals=${timedIntervals} ` +
          `secures=${ROWS * PER_ROW} p50=${f(percentile(sorted, 50))} p95=${f(percentile(sorted, 95))} ` +
          `p99=${f(percentile(sorted, 99))} max=${f(sorted[sorted.length - 1] ?? Number.NaN)} mean=${f(mean)} ` +
          `dev=${String(__DEV__)} nonce=${nonce}`,
      );
    };
    // Ticks of the shared interval, and every frame callback: the package's
    // per-frame re-measure is the only one requesting frames in these modes.
    const timeFor = async (mode: string) => {
      tickDurations.length = 0;
      const frameDurations: number[] = [];
      const realFrame = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = (callback =>
        realFrame(timestamp => {
          const start = performance.now();
          callback(timestamp);
          frameDurations.push(performance.now() - start);
        })) as typeof requestAnimationFrame;
      try {
        await sleep(PERF_MS);
      } finally {
        globalThis.requestAnimationFrame = realFrame;
      }
      report(mode, tickDurations);
      report(`${mode}-frames`, frameDurations);
    };
    (async () => {
      await sleep(PERF_WARMUP_MS);
      // Nothing moves: the cost of re-measuring alone.
      await timeFor('static');
      if (cancelled) {
        return;
      }
      // Everything moves every 400 ms: re-measuring plus the publishes.
      scroller = setInterval(() => {
        step += 1;
        outer.current?.scrollTo({ y: offsets[step % offsets.length], animated: false });
        rows.current.forEach((row, index) => row?.scrollTo({ x: ((step + index) % 3) * 300, animated: false }));
      }, 400);
      await timeFor('scrolling');
      clearInterval(scroller);
      if (cancelled) {
        return;
      }
      // All 20 partly clipped and moving: every one on the per-frame
      // re-measure, the worst case.
      setTall(true);
      outer.current?.scrollTo({ y: 0, animated: false });
      rows.current.forEach(row => row?.scrollTo({ x: 0, animated: false }));
      await sleep(PERF_WARMUP_MS);
      const nudges = [0, 20, 40];
      scroller = setInterval(() => {
        step += 1;
        outer.current?.scrollTo({ y: nudges[step % nudges.length], animated: false });
        rows.current.forEach((row, index) => row?.scrollTo({ x: ((step + index) % 2) * 20, animated: false }));
      }, 400);
      await timeFor('clipped');
      clearInterval(scroller);
      setTall(false);
      await sleep(PERF_WARMUP_MS);
      if (cancelled) {
        return;
      }
      // What 20 withdrawn views would cost every frame: one isHidden each,
      // props reads only, outside any measure pass, as BugseeSecure's frame
      // callback runs it.
      const ancestries = insides.map(inside => ancestryOfInstance(inside as object));
      const watched = ancestries.length;
      tickDurations.length = 0;
      const until = Date.now() + WATCH_MS;
      await new Promise<void>(resolve => {
        const frame = () => {
          const start = performance.now();
          for (const ancestry of ancestries) {
            isHidden(ancestry);
          }
          tickDurations.push(performance.now() - start);
          if (Date.now() < until && !cancelled) {
            requestAnimationFrame(frame);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(frame);
      });
      const sorted = [...tickDurations].sort((a, b) => a - b);
      const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
      mark(
        `secure-perf result mode=watch ticks=${sorted.length} intervals=${timedIntervals} ` +
          `secures=${watched} p50=${f(percentile(sorted, 50))} p95=${f(percentile(sorted, 95))} ` +
          `p99=${f(percentile(sorted, 99))} max=${f(sorted[sorted.length - 1] ?? Number.NaN)} mean=${f(mean)} ` +
          `dev=${String(__DEV__)} nonce=${nonce}`,
      );
    })().catch((error: unknown) => {
      mark(`secure-perf threw ${String(error)} nonce=${nonce}`);
    });
    return () => {
      cancelled = true;
      clearInterval(scroller);
    };
  }, [mountedSecures, nonce]);

  return (
    <View style={styles.stage}>
      <ScrollView ref={outer} style={styles.fill} contentContainerStyle={styles.perfTall}>
        <View style={styles.clipOuter}>
          <View style={styles.clipInner}>
            {mountedSecures && <PerfSecures rows={rows} tall={tall} />}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** secure-perf-many: ScrollViews, and secure views in each. */
const MANY_SCROLLS = 4;
const MANY_PER_SCROLL = 50;

function ManySecures() {
  // After every child's layout effect: the loop's interval has started.
  useLayoutEffect(() => {
    endTimingWindow?.();
    endTimingWindow = undefined;
  }, []);
  return (
    <>
      {Array.from({ length: MANY_SCROLLS }, (_, scroll) => (
        <ScrollView key={scroll} style={styles.manyScroll} contentContainerStyle={styles.manyContent}>
          {Array.from({ length: MANY_PER_SCROLL }, (__, i) => (
            <BugseeSecure key={i} style={styles.manySecure} />
          ))}
        </ScrollView>
      ))}
    </>
  );
}

/**
 * secure-perf-many: 200 `<BugseeSecure>` in four still ScrollViews, each
 * 100 dp tall with 50 views 40 dp tall stacked in it, so every view is
 * partly clipped or wholly out of sight and nothing moves. Ticks and frame
 * callbacks are timed for 40 s after the views have settled.
 */
function SecurePerfManyProbe({ nonce }: { nonce: string }) {
  const [mountedSecures, setMountedSecures] = useState(false);

  useEffect(() => {
    endTimingWindow = timeLoopIntervals();
    setMountedSecures(true);
  }, []);

  useEffect(() => {
    if (!mountedSecures) {
      return undefined;
    }
    let cancelled = false;
    const f = (value: number) => value.toFixed(3);
    const report = (mode: string, durations: readonly number[]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
      mark(
        `secure-perf result mode=${mode} ticks=${sorted.length} intervals=${timedIntervals} ` +
          `secures=${MANY_SCROLLS * MANY_PER_SCROLL} p50=${f(percentile(sorted, 50))} ` +
          `p95=${f(percentile(sorted, 95))} p99=${f(percentile(sorted, 99))} ` +
          `max=${f(sorted[sorted.length - 1] ?? Number.NaN)} mean=${f(mean)} dev=${String(__DEV__)} nonce=${nonce}`,
      );
    };
    (async () => {
      await sleep(PERF_WARMUP_MS);
      tickDurations.length = 0;
      const frameDurations: number[] = [];
      const realFrame = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = (callback =>
        realFrame(timestamp => {
          const start = performance.now();
          callback(timestamp);
          frameDurations.push(performance.now() - start);
        })) as typeof requestAnimationFrame;
      try {
        await sleep(PERF_MS);
      } finally {
        globalThis.requestAnimationFrame = realFrame;
      }
      if (cancelled) {
        return;
      }
      report('many', tickDurations);
      report('many-frames', frameDurations);
    })().catch((error: unknown) => {
      mark(`secure-perf threw ${String(error)} nonce=${nonce}`);
    });
    return () => {
      cancelled = true;
    };
  }, [mountedSecures, nonce]);

  return <View style={styles.stage}>{mountedSecures && <ManySecures />}</View>;
}

export function SecureVisibleStage({ scenario, nonce }: { scenario: SecureVisibleScenario; nonce: string }) {
  if (scenario === 'secure-visible') {
    return <SecureVisibleProbe nonce={nonce} />;
  }
  return scenario === 'secure-perf' ? <SecurePerfProbe nonce={nonce} /> : <SecurePerfManyProbe nonce={nonce} />;
}

const styles = StyleSheet.create({
  stage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF' },
  fill: { flex: 1 },
  tall: { height: 2000 },
  perfTall: { height: 3000 },
  clipOuter: { overflow: 'hidden', margin: 10, height: 2800 },
  clipInner: { overflow: 'hidden', margin: 10, flex: 1 },
  row: { height: 70, flexGrow: 0, marginBottom: 10 },
  wide: { width: 1500, height: 70 },
  perfSecure: { position: 'absolute', top: 10, width: 70, height: 40, backgroundColor: '#EEEEEE' },
  perfSecureTall: { height: 80 },
  manyScroll: { height: 100, flexGrow: 0, marginBottom: 20 },
  manyContent: { height: 2000 },
  manySecure: { height: 40, backgroundColor: '#EEEEEE' },
});
