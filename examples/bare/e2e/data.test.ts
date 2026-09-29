/**
 * Task 4.3: log lines, events and traces in an Android retained bundle.
 * Task 4.4: the same four cases on the iOS simulator (see device.ts/bundles.ts),
 * and on an iPhone (Task 3.H).
 *
 * Tasks 4.1 and 4.2 unit-tested `Bugsee.log`, `event` and `trace` against
 * mocks. What only a device shows is what the SDK then writes: that a line
 * lands as `Custom` at the level it was sent at, that event params survive
 * the bridge with their types and nesting (an integer stays an integer), that
 * a trace keeps its value's type (a boolean does not become `1`), and that
 * nothing sent before `launch()` reaches the bundle.
 *
 * Android preconditions, as for wrapper-channel.test.ts: the debug build is
 * installed on the handset named in device.ts, and Metro is running with
 * `adb reverse tcp:8081 tcp:8081`. Retention is airplane mode (bundles.ts).
 *
 * iOS preconditions, as for report-handler.test.ts (Task 3.4f) and
 * wrapper-channel.test.ts (Task 3.5d): the Debug app is installed on the
 * booted simulator (IOS_SIMULATOR_ID) with Metro running, or on the iPhone
 * (IOS_DEVICE_ID, Task 3.H). There is no airplane mode to switch, so
 * retention goes through the closed loopback endpoint (bundles.ts,
 * DEAD_ENDPOINT) instead.
 *
 * Two iOS notes:
 * - Case 4: the pre-launch drop is the SDK's own launch gate
 *   (`bugseeAvailableForUserDumps`) for `event` and `trace`, since both are
 *   no-ops unless the SDK is Launched or Launching -- not the channel
 *   holder's gate, which is what drops the pre-launch log line on both
 *   platforms (no wrapper is registered before `launch()` calls
 *   `setWrapperInfo`).
 * - Cases 2 and 3: iOS writes `displayId: 0` on every user event and trace;
 *   this test does not assert on `displayId`.
 *
 * Markers, from scenarios/data.ts (console.log, tag ReactNativeJS on Android;
 * mirrored to the simulator's console-pty stream on iOS):
 *   BUGSEE_E2E data pre-sent nonce=<n>   the pre-launch log/event/trace ran
 *   BUGSEE_E2E data sent nonce=<n>       everything after Launched ran
 */
import {
  type PulledBundle,
  airplane,
  captureEvents,
  removePulledBundles,
  terminateIosApp,
} from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
  ON_IOS,
  type Run,
  awaitBundles,
  clearBundles,
  TARGET_NAME,
  describeDevice,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import {
  type DeviceLog,
  type LogLine,
  Logcat,
  IosConsole,
  adb,
  resetScenario,
} from './scenario';

jest.setTimeout(5 * 60_000);

type Entry = Record<string, unknown>;

/**
 * What scenarios/data.ts sends as `data-<n>`'s params, without the
 * `skipped: undefined` member, which JS omits before it crosses. Written out
 * here rather than imported: the scenario is app code, and an e2e that
 * compared the app against itself could not fail.
 */
function paramsFor(nonce: string): Entry {
  return {
    str: `s-${nonce}`,
    int: 3,
    neg: -7,
    frac: 1.5,
    big: 9007199254740991,
    yes: true,
    no: false,
    nil: null,
    nested: { list: [1, 'two', { deep: false }], empty: {} },
  };
}

function has(entry: Entry, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entry, key);
}

function textOf(entry: Entry, key: string): string {
  const value = entry[key];
  return typeof value === 'string' ? value : '';
}

/** The capture's raw text, failing loudly if the bundle has none. */
function rawCapture(bundle: PulledBundle, type: string): string {
  const text = bundle.captures.get(type);
  if (text === undefined) {
    throw new Error(
      `bundle ${bundle.file} has no ${type} capture; ` +
        `manifest files: ${JSON.stringify(bundle.manifest.files)}`,
    );
  }
  return text;
}

describeDevice(`log, event and trace in a retained bundle on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];
  /** The pre-launch probe's own marker -- case 4's precondition. */
  let preSent: LogLine | undefined;

  beforeAll(async () => {
    if (ON_IOS) {
      // No network switch to throw: every iOS launch carries DEAD_ENDPOINT
      // (startIosRun), which is what retains its bundle.
      log = IosConsole.start();
      useLog(log, '4.4');
    } else {
      log = await Logcat.start();
      useLog(log, '4.3');
      // 9.3.2: offline before the app starts, so the report is retained.
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('data');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    preSent = log.all(new RegExp(`BUGSEE_E2E data pre-sent nonce=${nonce}`), run.start)[0];

    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E data sent nonce=${nonce}`), 15_000, run.launched.index),
      'the post-launch data being sent',
      run.start,
    );

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    for (const bundle of bundles) {
      report(`${bundle.file} manifest files`, bundle.manifest.files);
      for (const type of ['events.user', 'traces.user']) {
        report(`${type} raw`, bundle.captures.get(type) ?? '(none)');
      }
      report(
        'log events for this run',
        captureEvents(bundle, 'log').filter(e => textOf(e, 'message').includes(nonce)),
      );
    }
  });

  afterAll(async () => {
    // Always, and in this order: stop the app, drop what it retained, then
    // bring the network back -- the handset is shared.
    try {
      if (ON_IOS) {
        await terminateIosApp();
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
      await clearBundles().catch(() => {});
    } finally {
      try {
        if (!ON_IOS) {
          await airplane(false);
        }
      } finally {
        try {
          const { removed, kept } = removePulledBundles();
          report('pulled bundle roots', { removed: removed.length, kept });
        } finally {
          try {
            if (log !== undefined) {
              log.stop();
            }
          } finally {
            resetScenario();
          }
        }
      }
    }
  });

  function theBundle(): PulledBundle {
    expect(bundles).toHaveLength(1);
    return bundles[0]!;
  }

  it('lines land as Custom at the level they were sent at', () => {
    const events = captureEvents(theBundle(), 'log');
    const expected: Array<[string, number]> = [1, 2, 3, 4, 5].map(level => [
      `BUGSEE_E2E data log L${level} ${nonce}`,
      level,
    ]);
    expected.push([`BUGSEE_E2E data log default ${nonce}`, 3]);

    for (const [message, level] of expected) {
      const matches = events.filter(event => event.message === message);
      expect({ message, count: matches.length }).toEqual({ message, count: 1 });
      const [event] = matches as [Entry];
      expect({ message, level: event.level, source: event.source, tag: has(event, 'tag') }).toEqual({
        message,
        level,
        source: 98,
        tag: false,
      });
    }
  });

  it("an event's params survive the bridge", () => {
    const bundle = theBundle();
    const events = captureEvents(bundle, 'events.user');

    const named = events.filter(event => event.name === `data-${nonce}`);
    expect(named).toHaveLength(1);
    expect(named[0]!.params).toStrictEqual(paramsFor(nonce));

    // Integers, with no exponent and no `.0` -- what JSON.parse above cannot
    // tell apart.
    const raw = rawCapture(bundle, 'events.user');
    expect(raw).toMatch(/"big":9007199254740991[,}]/);
    expect(raw).toMatch(/"int":3[,}]/);

    const bare = events.filter(event => event.name === `data-bare-${nonce}`);
    expect(bare).toHaveLength(1);
    expect(has(bare[0]!, 'params')).toBe(false);
  });

  it('traces keep their value and their type', () => {
    const traces = captureEvents(theBundle(), 'traces.user');
    const sent: Array<[string, string | number | boolean]> = [
      [`data-num-${nonce}`, 42],
      [`data-frac-${nonce}`, 0.25],
      [`data-str-${nonce}`, 'on'],
      [`data-bool-${nonce}`, true],
    ];
    for (const [name, value] of sent) {
      const entries = traces.filter(trace => trace.name === name);
      expect({ name, found: entries.length > 0 }).toEqual({ name, found: true });
      // Every entry: snapshot replay may repeat one, and each must hold the
      // value sent, with its type.
      expect({ name, types: entries.map(entry => typeof entry.value) }).toEqual({
        name,
        types: entries.map(() => typeof value),
      });
      expect({ name, values: entries.map(entry => entry.value) }).toEqual({
        name,
        values: entries.map(() => value),
      });
    }
  });

  it('nothing sent before launch reaches the bundle', () => {
    // Precondition: the pre-launch log/event/trace really ran, and really ran
    // before the SDK was Launched -- not merely assumed from source order.
    const marker = must(preSent, `the pre-launch data probe marker (nonce ${nonce})`, run.start);
    expect(marker.index).toBeLessThan(run.launched.index);

    const bundle = theBundle();
    const lines = captureEvents(bundle, 'log');
    const events = captureEvents(bundle, 'events.user');
    const traces = captureEvents(bundle, 'traces.user');

    // Precondition: the same bundle holds this run's post-launch data, so an
    // empty or wrongly scoped capture cannot pass vacuously.
    expect(lines.some(line => textOf(line, 'message').includes(nonce))).toBe(true);
    expect(events.some(event => textOf(event, 'name').includes(nonce))).toBe(true);
    expect(traces.some(trace => textOf(trace, 'name').includes(nonce))).toBe(true);

    const pre = `pre-${nonce}`;
    const leaked = {
      lines: lines.filter(line => textOf(line, 'message').includes(pre)),
      events: events.filter(event => textOf(event, 'name').includes(pre)),
      traces: traces.filter(trace => textOf(trace, 'name').includes(pre)),
    };
    report('case 4 pre-launch matches', leaked);
    expect(leaked).toEqual({ lines: [], events: [], traces: [] });
  });
});
