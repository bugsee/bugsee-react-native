/**
 * N-06: every manifest option key read back (section 1.4, proof class R),
 * the typed accessors (OPT-ACC-01..04, 06) and every enum value (OPT-ACC-08).
 *
 *   api-opt-defaults  the app's ordinary launch: getLaunchOptions() whole.
 *                     Each value the all-keys run sets must differ from it
 *                     (so a read-back cannot pass on a default), and no key
 *                     of the other platform may be in it (OPT-ACC-04).
 *   api-opt-all       launches with every key of this platform's
 *                     READBACK_SHARED + READBACK_<PLATFORM>
 *                     (scenarios/api-constants.ts) -- the accessor keys
 *                     through the typed accessors, the rest through
 *                     setCustomOption -- reads each back, refreshes a fresh
 *                     options object from the SDK and reads its getters, and
 *                     uploads one report, whose `environment.sdk.options`
 *                     must record each value. Android writes an enum there as
 *                     its constant's ORDINAL (bug 10, bugsee-android#216):
 *                     asserted as that rule, not hidden.
 *   api-opt-enums     relaunches once per internal value of each enum key
 *                     and reads each back.
 *
 * `config.data-encryption` (iOS) is read back by option-effects.test.ts
 * (`env-diff`), not here: it would encrypt this run's bundle. Likewise
 * `config.report-processing-in-process` (Android, OPT-081): off, it files no
 * report, and this run needs one.
 */
import { type PulledBundle } from './bundles';
import { apiMarker, jsonAfter } from './api-markers';
import {
  ACCESSOR_KEYS,
  ANDROID_ENUM_VALUES,
  ENUM_VALUES,
  READBACK_ANDROID,
  READBACK_IOS,
  READBACK_SHARED,
} from '../scenarios/api-constants';
import ENUMS from '../../../packages/react-native/src/options/option-enums.json';
import KEYS from '../../../packages/react-native/src/options/option-keys.json';
import ANDROID_MANIFEST from '../../../packages/react-native/src/options/android-options-manifest.json';
import { ON_IOS, type Run, TARGET_NAME, awaitBundles, describeDevice, listBundles, report, startRun, stopApp } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog } from './scenario';

jest.setTimeout(8 * 60_000);

const OWN_SET: Record<string, unknown> = { ...READBACK_SHARED, ...(ON_IOS ? READBACK_IOS : READBACK_ANDROID) };
const FOREIGN_KEYS: readonly string[] = ON_IOS ? KEYS.android : KEYS.ios;
const PLATFORM_NAME: 'android' | 'ios' = ON_IOS ? 'ios' : 'android';

/**
 * Known product bugs a read-back or the environment record pins (it.failing).
 * iOS bug 5: beta3..beta5 drop `capture.network.body-size-limit` -- read back
 * as the default 20480, absent from `environment.sdk.options` (XS, beta5,
 * 2026-10-07). Filed: https://github.com/bugsee/bugsee-cocoa/issues/197
 */
const KNOWN_READBACK: Record<'android' | 'ios', Record<string, string>> = {
  android: {},
  ios: { 'com.bugsee.option.capture.network.body-size-limit': 'bugsee-cocoa#197' },
};
const ACCESSORS: Record<string, string> = { ...ACCESSOR_KEYS.shared, ...(ON_IOS ? ACCESSOR_KEYS.ios : ACCESSOR_KEYS.android) };

/** Android enum keys and their enum, from the SDK's option manifest. */
const ANDROID_ENUM_OF: Record<string, keyof typeof ENUMS> = Object.fromEntries(
  (ANDROID_MANIFEST.options as Array<{ key: string; type: string; enum?: { name: string } }>)
    .filter(o => o.type === 'enum' && o.enum !== undefined)
    .map(o => [o.key, o.enum!.name as keyof typeof ENUMS]),
);

/** The ordinal Android 7.3.0 records for an enum value (constants in value order). */
function androidOrdinal(key: string, value: number): number {
  const values = Object.values(ENUMS[ANDROID_ENUM_OF[key]!] as Record<string, number>).sort((a, b) => a - b);
  return values.indexOf(value);
}

/** Every `<tag> chunk ... values={...}` part of a run, merged. */
function chunks(log: DeviceLog, tag: string, nonce: string, from: number): Record<string, unknown> {
  const lines = log.all(new RegExp(`BUGSEE_E2E api ${tag} chunk nonce=${nonce} part=`), from);
  const parts = lines.map(line => /part=(\d+)\/(\d+)/.exec(line.text)!);
  const total = Number(parts[0]?.[2] ?? 0);
  if (lines.length !== total || total === 0) {
    throw new Error(`expected ${total} ${tag} chunk(s), got ${lines.length}`);
  }
  return Object.assign({}, ...lines.map(line => jsonAfter<Record<string, unknown>>(line.text, 'values')));
}

/** A value read back over the bridge: numbers may come back as floats (0.5) or ints. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-6;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

describeDevice(`every launch option read back on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let defaults: Record<string, unknown>;
  let all: Record<string, unknown>;
  let getters: Record<string, unknown>;
  let bundle: PulledBundle;
  let enumsRun: Run;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-06');
    const defaultsRun = await startRun('api-opt-defaults');
    await apiMarker(log, 'opt defaults done', defaultsRun.scenario.nonce, 30_000, defaultsRun.start);
    defaults = chunks(log, 'opt defaults', defaultsRun.scenario.nonce, defaultsRun.start);
    await stopApp();

    const allRun = await startRun('api-opt-all');
    const nonce = allRun.scenario.nonce;
    const getterLine = await apiMarker(log, 'opt getters', nonce, 30_000, allRun.start);
    all = chunks(log, 'opt all', nonce, allRun.start);
    getters = jsonAfter(getterLine.text, 'values');
    await apiMarker(log, 'opt all uploaded', nonce, 15_000, getterLine.index, allRun.start);
    const allBundles = await awaitBundles(1, 90_000);
    report('all-keys run bundles', allBundles.map(b => ({ summary: b.request.summary, type: b.request.type })));
    report('all-keys run files on device', await listBundles());
    bundle = allBundles.find(b => b.request.summary === `api-opt-all-${nonce}`)!;
    await stopApp();

    enumsRun = await startRun('api-opt-enums');
    await apiMarker(log, 'opt enums done', enumsRun.scenario.nonce, 120_000, enumsRun.start);
    await stopApp();
    report('defaults', defaults);
    report('getters', getters);
  });

  afterAll(() => endRetainingSuite(log));

  it(`[OPT-ACC-04] the defaults name no ${ON_IOS ? 'Android' : 'iOS'}-only key`, () => {
    expect(Object.keys(defaults).filter(key => FOREIGN_KEYS.includes(key))).toEqual([]);
  });

  for (const [key, value] of Object.entries(OWN_SET)) {
    const id = optId(key);
    const via = Object.values(ACCESSORS).includes(key) ? 'a typed accessor' : 'setCustomOption';
    const known = KNOWN_READBACK[PLATFORM_NAME][key];
    (known !== undefined ? it.failing : it)(`[${id}] ${key.replace('com.bugsee.option.', '')} = ${JSON.stringify(value)} (set through ${via}) reads back, and is not the default`, () => {
      if (key in defaults) {
        expect({ key, default: defaults[key], differs: !same(defaults[key], value) }).toEqual({ key, default: defaults[key], differs: true });
      }
      expect({ key, readback: all[key], matches: same(all[key], value) }).toEqual({ key, readback: all[key], matches: true });
    });
  }

  it('[OPT-ACC-06] a fresh options object refreshed from getLaunchOptions() answers every accessor with the native value', () => {
    for (const [name, key] of Object.entries(ACCESSORS)) {
      expect({ name, value: getters[name], matches: same(getters[name], OWN_SET[key]) }).toEqual({ name, value: getters[name], matches: true });
    }
  });

  it(`[OPT-ACC-01][OPT-ACC-0${ON_IOS ? 3 : 2}] the report's environment records every value set`, () => {
    expect(bundle).toBeDefined();
    const recorded = (bundle.request.environment as { sdk?: { options?: Record<string, unknown> } }).sdk?.options ?? {};
    report('environment.sdk.options keys', Object.keys(recorded).length);
    const misses: Array<Record<string, unknown>> = [];
    for (const [key, value] of Object.entries(OWN_SET)) {
      const candidates = [key, key.replace(/\./g, ':'), key.replace('com.bugsee.option.', '')];
      const found = candidates.find(candidate => candidate in recorded);
      let expected: unknown = value;
      if (!ON_IOS && ANDROID_ENUM_OF[key] !== undefined) {
        // Bug 10 (bugsee-android#216): Android records the ordinal.
        expected = androidOrdinal(key, value as number);
      }
      if (found === undefined || !same(recorded[found], expected)) {
        misses.push({ key, expected, recorded: found === undefined ? '(absent)' : recorded[found] });
      }
    }
    report('environment record misses', misses);
    // The known bugs are pinned on their own below.
    expect(misses.filter(miss => KNOWN_READBACK[PLATFORM_NAME][miss.key as string] === undefined)).toEqual([]);
  });

  for (const [key, bug] of Object.entries(KNOWN_READBACK[PLATFORM_NAME])) {
    it.failing(`[${optId(key)}] ${key.replace('com.bugsee.option.', '')} is recorded in the report's environment [known: ${bug}]`, () => {
      const recorded = (bundle.request.environment as { sdk?: { options?: Record<string, unknown> } }).sdk?.options ?? {};
      const found = [key, key.replace(/\./g, ':'), key.replace('com.bugsee.option.', '')].find(candidate => candidate in recorded);
      expect(found === undefined ? '(absent)' : recorded[found]).toEqual(OWN_SET[key]);
    });
  }

  it('[OPT-ACC-08][API-44] every enum value reads back as its internal value, not an ordinal', () => {
    const table = { ...ENUM_VALUES, ...(ON_IOS ? {} : ANDROID_ENUM_VALUES) };
    for (const [key, values] of Object.entries(table)) {
      const line = log!.all(new RegExp(`BUGSEE_E2E api opt enum nonce=${enumsRun.scenario.nonce} key=${key.replace(/\./g, '\\.')} `), enumsRun.start)[0];
      expect({ key, logged: line !== undefined }).toEqual({ key, logged: true });
      const readback = jsonAfter<Record<string, unknown>>(line!.text, 'readback');
      report(`enum ${key}`, readback);
      for (const value of values) {
        expect({ key, value, readback: readback[String(value)] }).toEqual({ key, value, readback: value });
      }
    }
  });
});

/** The plan's OPT-<nnn> id for a key: its position in option-keys.json (shared, ios, android). */
function optId(key: string): string {
  const order = [...KEYS.shared, ...KEYS.ios, ...KEYS.android];
  const at = order.indexOf(key);
  return at === -1 ? 'OPT-ACC-07' : `OPT-${String(at + 1).padStart(3, '0')}`;
}

