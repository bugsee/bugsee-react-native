/**
 * Task 5.4: attributes and user identity round-trip on an Android handset,
 * and into the retained report. Task 5.5: the same five cases on the iOS
 * simulator.
 *
 * Tasks 5.1 and 5.2 unit-tested the JS validation and the bridge's
 * set-then-verify against fakes. What only a device shows is what the real
 * SDK keeps: that every accepted type reads back as the report will carry it
 * (Android stores a fractional number as a 32-bit float, so `0.1` reads
 * `0.10000000149011612`; iOS keeps the JS double as given, so `0.1` reads
 * `0.1`. An integral number must cross as `Long`/`NSNumber` or
 * `9007199254740991` rounds up on either platform), that the report's
 * `manifest.json` `attrs` and `request.json` `email` agree with the reads,
 * and that both survive a process restart and a clear sticks.
 *
 * The two platforms disagree on the 800-1024 character band: Android's
 * `NSKeyedArchiver`-free bridge keeps a 1024-character string, but iOS
 * archives the value and silently drops it past `BGSRNAttributeArchiveLimit`
 * bytes -- `+setAttribute:withValue:` still returns `YES`, so
 * `BGSRNAttributes setValue:forKey:setter:getter:` reads it back and rejects
 * with `E_ATTRIBUTE_REJECTED` when the read-back disagrees. 800 characters
 * fits on both; 1024 fits only on Android
 * (`testAn800CharacterAsciiStringFitsTheArchiveLimit`,
 * `testA1024CharacterAsciiStringExceedsTheArchiveLimit`). There is no
 * 900-character row: by controller ruling (2026-09-29, after this task's
 * first pass), that length sits in an ambiguous zone where the real
 * `7.0.0-beta3` binary keeps the value even though the archive math both
 * `testA900CharacterAsciiStringExceedsTheArchiveLimit` and the SDK source's
 * own check independently say it should not -- the iOS SDK team has been
 * asked why, and the row is omitted rather than asserted either way.
 *
 * **iOS SDK regression, confirmed and fixed upstream:**
 * https://github.com/bugsee/bugsee-cocoa/pull/164 (base `nextgen`; there is
 * no separate issue -- the PR is the record). Root cause: nextgen lacked
 * Android's `initializeReport`, so global attributes and the identifier were
 * never copied into a new report (`BGSManifestCreator.userAttributes` is
 * legacy and unused on this path). So a live `Bugsee.upload()` report's
 * `manifest.json` `attrs` and `request.json` `email` never carry the global
 * attributes or user identifier at all on iOS 7.0.0-beta3, even though
 * `getAttribute`/`getAllAttributes`/`getUserIdentifier` all read them back
 * correctly right up to the `upload()` call. Case 3's `manifest.attrs`/
 * `email` assertions therefore run as `it.failing` on iOS only, so the suite
 * stays green while asserting the CORRECT (currently unmet) behaviour, and
 * turns red -- forcing an update -- once the RN pin moves to an iOS beta
 * containing bugsee-cocoa#164. Whether a bundle was retained at all, and
 * whether it's this run's own report, is asserted separately in a plain
 * `it` that is never `.failing` -- so a harness regression (no bundle
 * pulled, or the wrong one) fails loudly instead of being swallowed as "the
 * known SDK bug failing as expected".
 *
 * Android preconditions, as for data.test.ts: the debug build is installed on
 * the handset named in device.ts, and Metro is running with
 * `adb reverse tcp:8081 tcp:8081`. Retention is airplane mode (bundles.ts).
 *
 * iOS preconditions, as for report-handler.test.ts and data.test.ts: the
 * Debug app is installed on the booted simulator (IOS_SIMULATOR_ID) and Metro
 * is running. Retention goes through the closed loopback endpoint
 * (bundles.ts, DEAD_ENDPOINT). The identifier and attributes live in the
 * simulator's Keychain, which -- unlike the SDK's own data directory --
 * survives `clearIosBundles`/app reinstall, and is only erased with the
 * simulator itself. That is exactly why the precondition marker
 * (`pre-all`/`pre-id`, asserted empty by every case) matters more here than
 * on Android: a value an earlier run left in the Keychain would otherwise
 * silently pass this run. `afterAll` clears both through the SDK's own JS API
 * (a real `attributes-persist` run) and, only as a last resort if that was
 * not seen to take, resets the whole simulator Keychain
 * (`xcrun simctl keychain <device> reset`) -- the iOS analogue of Android's
 * `pm clear` fallback.
 *
 * Every value is synthetic: until bugsee-android#186 ships, the Android SDK
 * writes attribute values and the identifier to its internal log. Nothing
 * here asserts on `log.internal`, either way.
 *
 * Markers, from scenarios/attributes.ts (console.log, tag ReactNativeJS on
 * Android; mirrored to the simulator's console-pty stream on iOS):
 *   BUGSEE_E2E attr <label> <json>
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type PulledBundle, airplane, removePulledBundles, terminateIosApp } from './bundles';
import { ANDROID_PACKAGE, IOS_SIMULATOR_ID } from './device';
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
import {
  type DeviceLog,
  Logcat,
  SimulatorConsole,
  adb,
  adbStatus,
  pidOf,
  resetScenario,
} from './scenario';

const execFileAsync = promisify(execFile);

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
    resolved('e2e_long', 'x'.repeat(1024)),
    badArgument('e2e_too_long'),
    badArgument('e2e_huge'),
    badArgument('e2e_over_long'),
  ];
}

/**
 * The iOS column of the Phase 5 table. Diverges from Android on exactly two
 * rows: `e2e_tenth` reads back the JS double unwidened (`0.1`), and
 * `e2e_long` is an archived-size drop -- `+setAttribute:withValue:` returns
 * `YES`, but `BGSRNAttributes`'s read-back verification catches it, so the
 * bridge rejects with `E_ATTRIBUTE_REJECTED` and the value never lands
 * (`read: UNDEFINED`). `e2e_mid` (800 chars) is the matching acceptance: it
 * fits under the archive limit on both platforms. There is no `e2e_900` row
 * (controller ruling): that length is kept on the real device even though
 * the archive math predicts a drop, an open question for the iOS SDK team.
 */
function iosRows(nonce: string): Row[] {
  const resolved = (name: string, value: Value): Row => ({
    name,
    set: 'resolved',
    read: readOf(value),
  });
  const rejected = (name: string): Row => ({
    name,
    set: 'E_ATTRIBUTE_REJECTED',
    read: UNDEFINED,
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
    resolved('e2e_tenth', 0.1),
    resolved('e2e_true', true),
    resolved('e2e_false', false),
    resolved('e2e_mid', 'm'.repeat(800)),
    rejected('e2e_long'),
    badArgument('e2e_too_long'),
    badArgument('e2e_huge'),
    badArgument('e2e_over_long'),
  ];
}

/** The platform's column of the Phase 5 table. */
function rows(nonce: string): Row[] {
  return ON_IOS ? iosRows(nonce) : androidRows(nonce);
}

/** Every resolved row but the cleared `e2e_neg`, as a name -> value map. */
function expectedAttrs(nonce: string): Record<string, Value> {
  const attrs: Record<string, Value> = {};
  for (const row of rows(nonce)) {
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

/** iOS: the pid an NSLog line's `BareExample[<pid>:<tid>]` prefix carries. */
const IOS_PID_LINE = /BareExample\[(\d+):/;

/** The app's current pid -- `pidof` on Android, the run's own banner line on iOS. */
async function currentPid(bannerText: string): Promise<string | undefined> {
  return ON_IOS ? IOS_PID_LINE.exec(bannerText)?.[1] : pidOf();
}

describeDevice(`attributes and identity round-trip on ${ON_IOS ? 'the iOS simulator' : 'an Android handset'}`, () => {
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
  async function persistRun(): Promise<{ marks: Map<string, unknown>; run: Run }> {
    const persist = await startRun('attributes-persist');
    const found = await collect('attributes-persist', persist.scenario.nonce, persist.start);
    leftClean =
      JSON.stringify(found.get('cleared-all')) === '{}' &&
      JSON.stringify(found.get('cleared-id')) === JSON.stringify(UNDEFINED);
    return { marks: found, run: persist };
  }

  beforeAll(async () => {
    log = ON_IOS ? SimulatorConsole.start() : await Logcat.start();
    useLog(log, '5.5');
    if (!ON_IOS) {
      // 9.3.2: offline before the app starts, so the report is retained.
      await airplane(true);
    }
    // iOS retention goes through startRun's DEAD_ENDPOINT instead (no
    // airplane mode on the simulator); see bundles.ts.
    await clearBundles();

    run = await startRun('attributes');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    marks = await collect('attributes', nonce, run.start);
    firstPid = await currentPid(run.banner.text);
    for (const [label, value] of marks) {
      report(`attr ${label}`, value);
    }

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    for (const bundle of bundles) {
      report(`${bundle.file} manifest attrs`, bundle.manifest.attrs);
      report(`${bundle.file} request email`, bundle.request.email);
    }

    // Case 5's restart: a real separate process. Android's launchScenario
    // force-stops before starting; iOS's SimulatorConsole.launch() passes
    // `--terminate-running-process` to the same effect.
    const persisted = await persistRun();
    persistMarks = persisted.marks;
    secondPid = await currentPid(persisted.run.banner.text);
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
          report('cleanup run', cleanup === undefined ? '(none)' : Object.fromEntries(cleanup.marks));
        }
        if (!leftClean) {
          if (ON_IOS) {
            // Last resort: the identifier and attributes live in the
            // simulator's Keychain, which survives clearIosBundles and an app
            // reinstall -- only erasing the simulator (or its Keychain)
            // clears it.
            const { stdout, stderr } = await execFileAsync('xcrun', [
              'simctl',
              'keychain',
              IOS_SIMULATOR_ID,
              'reset',
            ]);
            report('simctl keychain reset (cleanup fallback)', (stdout + stderr).trim());
          } else {
            // Last resort: the attributes and identifier live in the app's
            // shared preferences.
            const cleared = await adbStatus('shell', 'pm', 'clear', ANDROID_PACKAGE);
            report('pm clear (cleanup fallback)', cleared.output.trim());
          }
        }
      } finally {
        if (ON_IOS) {
          await terminateIosApp();
        } else {
          await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
        }
        await clearBundles().catch(() => {});
      }
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

  /**
   * Asserted before anything else in every case: the run started from no
   * attributes and no identifier, so a value an earlier run left behind
   * cannot pass for this one.
   */
  function assertPrecondition(): void {
    expect(mark(marks, 'pre-all')).toStrictEqual({});
    expect(mark(marks, 'pre-id')).toStrictEqual(UNDEFINED);
  }

  /**
   * `bundles[0]` only -- deliberately asserts nothing. Exactly one bundle,
   * and that it's this run's own report, is asserted once, in a plain `it`
   * that is never `.failing` (below): if this helper itself threw and were
   * called from inside `it.failing`'s case 3, a harness regression (no
   * bundle pulled, a stale one from an earlier run) would be swallowed as
   * "the known SDK bug failing as expected" and the suite would stay green
   * for the wrong reason.
   */
  function theBundle(): PulledBundle {
    return bundles[0]!;
  }

  it('every accepted type reads back as the report will carry it', () => {
    assertPrecondition();
    for (const row of rows(nonce)) {
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

  /**
   * Deliberately a plain `it`, never `.failing`, on either platform: whether
   * a bundle was retained at all, and whether it's this run's own report,
   * is a harness/retention fact, not part of the iOS SDK bug below. Asserted
   * here so a regression in either (upload never fired, a stale bundle left
   * behind, `awaitBundles` timing out and returning `[]` instead of
   * throwing) fails loudly -- the same two facts `report-handler.test.ts`'s
   * `rh-live` case asserts in its own first plain `it`, for the same reason.
   */
  it("the retained report exists, and is this run's own", () => {
    assertPrecondition();
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.request.summary).toBe(`attrs-${nonce}`);
  });

  /**
   * Confirmed iOS SDK regression, fixed upstream in
   * https://github.com/bugsee/bugsee-cocoa/pull/164 (base `nextgen`; there
   * is no separate issue -- the PR is the record). Root cause: nextgen
   * lacked Android's `initializeReport`, so global attributes and the
   * identifier were never copied into a new report --
   * `BGSManifestCreator.userAttributes` is legacy and unused on this path.
   * So on iOS 7.0.0-beta3, a live `Bugsee.upload()` report's
   * `manifest.json` `attrs` comes back `{}` and `request.json` has no
   * `email` key, even though `getAttribute`/`getAllAttributes`/
   * `getUserIdentifier` all read them back correctly right up to the
   * `upload()` call (case 1 above).
   *
   * `it.failing` (a Jest built-in): the body below asserts the CORRECT
   * behaviour -- unweakened, identical in shape to Android's -- and this
   * test passes exactly because those assertions currently fail on iOS.
   * Remove `.failing` when fixed, i.e. once the RN pin moves to an iOS beta
   * containing bugsee-cocoa#164. Android runs the same body as a normal
   * `it`, since it has no such bug.
   *
   * ONLY the two SDK-bug assertions (`manifest.attrs` contents and
   * `request.json` `email`) live in this block -- the bundle's existence
   * and identity are already asserted above, in the plain `it` that
   * precedes this one, precisely so this `.failing` cannot mask a harness
   * regression as "the known SDK bug failing as expected".
   */
  const case3 = ON_IOS ? it.failing : it;
  case3('the retained report carries the attributes and the identifier', () => {
    assertPrecondition();
    const bundle = theBundle();
    expect(bundle.manifest.attrs).toStrictEqual(expectedAttrs(nonce));
    for (const [name, value] of Object.entries(expectedAttrs(nonce))) {
      expect({ name, type: typeof bundle.manifest.attrs[name] }).toEqual({ name, type: typeof value });
    }

    // What JSON.parse cannot tell apart: an integer stays an integer (no
    // `.0`, no exponent), and Android's 0.1 is the float's widening (iOS
    // keeps the JS double as given).
    const raw = readFileSync(join(bundle.dir, 'manifest.json'), 'utf8');
    for (const [name, text] of INTEGRAL_RAW) {
      expect({ name, raw: new RegExp(`"${name}"\\s*:\\s*${text}\\s*[,}]`).test(raw) }).toEqual({
        name,
        raw: true,
      });
    }
    const tenthText = ON_IOS ? '0\\.1' : '0\\.10000000149011612';
    expect(raw).toMatch(new RegExp(`"e2e_tenth"\\s*:\\s*${tenthText}\\s*[,}]`));
    expect(raw).not.toMatch(/"e2e_neg"/);
    if (ON_IOS) {
      // Rejected on iOS: never lands in the retained report either.
      expect(raw).not.toMatch(/"e2e_long"/);
    }

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
