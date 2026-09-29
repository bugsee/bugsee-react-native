/**
 * Task 5.4: attributes and user identity round-trip on an Android handset,
 * and into the retained report.
 *
 * Tasks 5.1 and 5.2 unit-tested the JS validation and the bridge's
 * set-then-verify against fakes. What only a device shows is what the real
 * SDK keeps: that every accepted type reads back as the report will carry it
 * (Android stores a fractional number as a 32-bit float, so `0.1` reads
 * `0.10000000149011612`, and an integral number must cross as `Long` or
 * `9007199254740991` rounds up), that the report's `manifest.json` `attrs`
 * and `request.json` `email` agree with the reads, and that both survive a
 * process restart and a clear sticks.
 *
 * Preconditions, as for data.test.ts: the debug build is installed on the
 * handset named in device.ts, and Metro is running with
 * `adb reverse tcp:8081 tcp:8081`. Retention is airplane mode (bundles.ts).
 *
 * Every value is synthetic: until bugsee-android#186 ships, the Android SDK
 * writes attribute values and the identifier to its internal log. Nothing
 * here asserts on `log.internal`, either way.
 *
 * Markers, from scenarios/attributes.ts (console.log, tag ReactNativeJS):
 *   BUGSEE_E2E attr <label> <json>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type PulledBundle, airplane, removePulledBundles } from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
  ON_IOS,
  type Run,
  awaitBundles,
  clearBundles,
  describeDevice,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import { type DeviceLog, Logcat, adb, adbStatus, pidOf, resetScenario } from './scenario';

jest.setTimeout(5 * 60_000);

type Value = string | number | boolean;

/** A logged read: `typeof` the value, and the value unless it was undefined. */
interface Read {
  readonly type: string;
  readonly value?: unknown;
}

const UNDEFINED: Read = { type: 'undefined' };

function readOf(value: Value): Read {
  return { type: typeof value, value };
}

interface Row {
  readonly name: string;
  /** `resolved`, or the rejection code. */
  readonly set: 'resolved' | 'E_ATTRIBUTE_BAD_ARGUMENT' | 'E_ATTRIBUTE_REJECTED';
  /** What `getAttribute` reads straight after the set. */
  readonly read: Read;
}

/**
 * The Android column of the Phase 5 table. Written out here rather than
 * imported from the scenario, so the app sending the wrong value fails.
 */
function androidRows(nonce: string): Row[] {
  const resolved = (name: string, value: Value): Row => ({
    name,
    set: 'resolved',
    read: readOf(value),
  });
  const badArgument = (name: string): Row => ({
    name,
    set: 'E_ATTRIBUTE_BAD_ARGUMENT',
    read: UNDEFINED,
  });
  return [
    resolved('e2e_str', `blue-${nonce}`),
    resolved('e2e_empty', ''),
    resolved('e2e_int', 42),
    resolved('e2e_neg', -7),
    resolved('e2e_int64', 2147483648),
    resolved('e2e_safe', 9007199254740991),
    resolved('e2e_half', 1.5),
    resolved('e2e_tenth', 0.10000000149011612),
    resolved('e2e_true', true),
    resolved('e2e_false', false),
    resolved('e2e_mid', 'm'.repeat(800)),
    resolved('e2e_900', 'n'.repeat(900)),
    resolved('e2e_long', 'x'.repeat(1024)),
    badArgument('e2e_too_long'),
    badArgument('e2e_huge'),
    badArgument('e2e_over_long'),
  ];
}

/** Every resolved row but the cleared `e2e_neg`, as a name -> value map. */
function expectedAttrs(nonce: string): Record<string, Value> {
  const attrs: Record<string, Value> = {};
  for (const row of androidRows(nonce)) {
    if (row.set === 'resolved' && row.name !== 'e2e_neg') {
      attrs[row.name] = row.read.value as Value;
    }
  }
  return attrs;
}

/** The integral rows, whose raw JSON must have no fraction and no exponent. */
const INTEGRAL_RAW: Array<[string, string]> = [
  ['e2e_int', '42'],
  ['e2e_int64', '2147483648'],
  ['e2e_safe', '9007199254740991'],
];

const MARKER = /BUGSEE_E2E attr (\S+) (.*)$/;

describeDevice('attributes and identity round-trip on an Android handset', () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];
  /** Every `attr` marker of the `attributes` run, by label. */
  let marks: Map<string, unknown>;
  /** Every `attr` marker of the `attributes-persist` run, by label. */
  let persistMarks: Map<string, unknown>;
  let firstPid: string | undefined;
  let secondPid: string | undefined;
  /** Whether a persist run was seen to leave `{}` and no identifier behind. */
  let leftClean = false;

  /** The run's markers from `from`, up to its `done` (or `failed`) line. */
  async function collect(scenario: string, runNonce: string, from: number): Promise<Map<string, unknown>> {
    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E attr (done|failed) \\{"scenario":"${scenario}","nonce":"${runNonce}"`),
        60_000,
        from,
      ),
      `the ${scenario} scenario finishing (nonce ${runNonce})`,
      from,
    );
    const found = new Map<string, unknown>();
    for (const line of log.all(MARKER, from)) {
      const [, label, json] = MARKER.exec(line.text)!;
      if (found.has(label!)) {
        throw new Error(`marker ${label} logged twice in one run:\n${log.tail(from)}`);
      }
      found.set(label!, JSON.parse(json!));
    }
    const failed = found.get('failed');
    if (failed !== undefined) {
      throw new Error(`the ${scenario} scenario threw: ${JSON.stringify(failed)}\n${log.tail(from)}`);
    }
    return found;
  }

  function mark(from: Map<string, unknown>, label: string): unknown {
    if (!from.has(label)) {
      throw new Error(`no ${label} marker; saw ${JSON.stringify([...from.keys()])}`);
    }
    return from.get(label);
  }

  /** A run of `attributes-persist`: what survived, then the clear. */
  async function persistRun(): Promise<Map<string, unknown>> {
    const persist = await startRun('attributes-persist');
    const found = await collect('attributes-persist', persist.scenario.nonce, persist.start);
    leftClean =
      JSON.stringify(found.get('cleared-all')) === '{}' &&
      JSON.stringify(found.get('cleared-id')) === JSON.stringify(UNDEFINED);
    return found;
  }

  beforeAll(async () => {
    if (ON_IOS) {
      throw new Error('Task 5.4 is the Android run; the iOS column is Task 5.5');
    }
    log = await Logcat.start();
    useLog(log, '5.4');
    // 9.3.2: offline before the app starts, so the report is retained.
    await airplane(true);
    await clearBundles();

    run = await startRun('attributes');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    marks = await collect('attributes', nonce, run.start);
    firstPid = await pidOf();
    for (const [label, value] of marks) {
      report(`attr ${label}`, value);
    }

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    for (const bundle of bundles) {
      report(`${bundle.file} manifest attrs`, bundle.manifest.attrs);
      report(`${bundle.file} request email`, bundle.request.email);
    }

    // Case 5's restart: a fresh process (launchScenario force-stops first).
    persistMarks = await persistRun();
    secondPid = await pidOf();
    report('pids', { first: firstPid, second: secondPid });
    for (const [label, value] of persistMarks) {
      report(`persist ${label}`, value);
    }
  });

  afterAll(async () => {
    // Always, and in this order: leave no attribute or identifier behind
    // (re-running the clearing scenario if the last one was not seen to take),
    // stop the app, drop what it retained, then bring the network back -- the
    // handset is shared.
    try {
      try {
        if (!leftClean && log !== undefined) {
          const cleanup = await persistRun().catch(error => {
            report('cleanup run failed', String(error));
            return undefined;
          });
          report('cleanup run', cleanup === undefined ? '(none)' : Object.fromEntries(cleanup));
        }
        if (!leftClean) {
          // Last resort: the attributes and identifier live in the app's
          // shared preferences.
          const cleared = await adbStatus('shell', 'pm', 'clear', ANDROID_PACKAGE);
          report('pm clear (cleanup fallback)', cleared.output.trim());
        }
      } finally {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
        await clearBundles().catch(() => {});
      }
    } finally {
      try {
        await airplane(false);
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

  /**
   * Asserted before anything else in every case: the run started from no
   * attributes and no identifier, so a value an earlier run left behind
   * cannot pass for this one.
   */
  function assertPrecondition(): void {
    expect(mark(marks, 'pre-all')).toStrictEqual({});
    expect(mark(marks, 'pre-id')).toStrictEqual(UNDEFINED);
  }

  function theBundle(): PulledBundle {
    expect(bundles).toHaveLength(1);
    return bundles[0]!;
  }

  it('every accepted type reads back as the report will carry it', () => {
    assertPrecondition();
    for (const row of androidRows(nonce)) {
      const set = mark(marks, `set:${row.name}`) as { result: string; code?: string };
      expect({ name: row.name, set: set.result === 'resolved' ? 'resolved' : set.code }).toEqual({
        name: row.name,
        set: row.set,
      });
      const read = mark(marks, `get:${row.name}`) as Read;
      // `===` and `typeof`, member by member, so the failure names the row.
      expect({ name: row.name, type: read.type }).toEqual({ name: row.name, type: row.read.type });
      expect({ name: row.name, same: read.value === row.read.value, value: read.value }).toEqual({
        name: row.name,
        same: true,
        value: row.read.value,
      });
    }
  });

  it('a cleared attribute is gone', () => {
    assertPrecondition();
    // Precondition: it really was set.
    expect(mark(marks, 'get:e2e_neg')).toStrictEqual(readOf(-7));

    expect(mark(marks, 'cleared:e2e_neg')).toStrictEqual(UNDEFINED);
    const all = mark(marks, 'all') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(all, 'e2e_neg')).toBe(false);
    // And the rest are all still there, as read.
    expect(all).toStrictEqual(expectedAttrs(nonce));
  });

  it('the retained report carries the attributes and the identifier', () => {
    assertPrecondition();
    const bundle = theBundle();
    expect(bundle.manifest.attrs).toStrictEqual(expectedAttrs(nonce));
    for (const [name, value] of Object.entries(expectedAttrs(nonce))) {
      expect({ name, type: typeof bundle.manifest.attrs[name] }).toEqual({ name, type: typeof value });
    }

    // What JSON.parse cannot tell apart: an integer stays an integer (no
    // `.0`, no exponent), and 0.1 is the float's widening.
    const raw = readFileSync(join(bundle.dir, 'manifest.json'), 'utf8');
    for (const [name, text] of INTEGRAL_RAW) {
      expect({ name, raw: new RegExp(`"${name}"\\s*:\\s*${text}\\s*[,}]`).test(raw) }).toEqual({
        name,
        raw: true,
      });
    }
    expect(raw).toMatch(/"e2e_tenth"\s*:\s*0\.10000000149011612\s*[,}]/);
    expect(raw).not.toMatch(/"e2e_neg"/);

    expect(bundle.request.email).toBe(`e2e-user-${nonce}`);
  });

  it('an empty identifier clears it', () => {
    assertPrecondition();
    // Precondition: there was one to clear, and setting it again works.
    expect(mark(marks, 'id-set')).toStrictEqual(readOf(`e2e-user-${nonce}`));
    expect(mark(marks, 'id-empty')).toStrictEqual(UNDEFINED);
    expect(mark(marks, 'id-final')).toStrictEqual(readOf(`e2e-user-${nonce}`));
  });

  it('attributes and identity survive a restart, and clearing them sticks', () => {
    assertPrecondition();
    // A real restart: another process.
    expect(firstPid).toBeDefined();
    expect(secondPid).toBeDefined();
    expect(secondPid).not.toBe(firstPid);

    expect(mark(persistMarks, 'persist-all')).toStrictEqual(mark(marks, 'all'));
    expect(mark(persistMarks, 'persist-id')).toStrictEqual(mark(marks, 'id-final'));
    expect(mark(persistMarks, 'persist-id')).toStrictEqual(readOf(`e2e-user-${nonce}`));

    expect(mark(persistMarks, 'cleared-all')).toStrictEqual({});
    expect(mark(persistMarks, 'cleared-id')).toStrictEqual(UNDEFINED);
  });
});
