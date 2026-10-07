/**
 * Launch options: every key read back (N-06) and the option effects a device
 * can show offline (N-07).
 *
 *   api-opt-defaults   the app's own launch; logs getLaunchOptions() whole,
 *                      in chunks (the defaults the all-keys run must differ
 *                      from), and which foreign-platform keys it reports.
 *   api-opt-all        launches with every key of api-constants.ts READBACK_*
 *                      (half through the typed accessors, the rest through
 *                      setCustomOption), logs the read-back, refreshes a fresh
 *                      options object from it and logs what its getters
 *                      return (OPT-ACC-06), and uploads one report.
 *   api-opt-enums      relaunches once per enum value (ENUM_VALUES) and logs
 *                      each read-back (OPT-ACC-08).
 *   api-eff-<case>--<step>  launches with EFFECT_OPTIONS[<case>] and does
 *                      <step>'s work (see `runEffect`).
 */
import { AppState, Platform } from 'react-native';
import Bugsee, {
  BugseeLaunchOptions,
  IssueSeverity,
  createDefaultLaunchOptions,
} from '@bugsee/react-native';
import { blockMain, crashNative, nativeLog, setFlagSecure } from 'bugsee-e2e-native';

import { type ApiContext, delay, mark, settle } from './api-common';
import {
  ACCESSOR_KEYS,
  ANDROID_ENUM_VALUES,
  EFFECT_OPTIONS,
  ENUM_VALUES,
  READBACK_ANDROID,
  READBACK_IOS,
  READBACK_SHARED,
} from './api-constants';
import { stubUrl } from './stub';

export const OPTION_SCENARIOS = ['api-opt-defaults', 'api-opt-all', 'api-opt-enums'] as const;

const EFFECT_PREFIX = 'api-eff-';

export function isOptionScenario(name: string): boolean {
  return (OPTION_SCENARIOS as readonly string[]).includes(name) || effectOf(name) !== undefined;
}

/** `api-eff-<case>--<step>` as its case and step. */
export function effectOf(scenario: string): { case: string; step: string } | undefined {
  if (!scenario.startsWith(EFFECT_PREFIX)) {
    return undefined;
  }
  const [name, step = 'run'] = scenario.slice(EFFECT_PREFIX.length).split('--');
  if (name === undefined || !Object.prototype.hasOwnProperty.call(EFFECT_OPTIONS, name)) {
    return undefined;
  }
  return { case: name, step };
}

function readbackSet(): Record<string, unknown> {
  return { ...READBACK_SHARED, ...(Platform.OS === 'ios' ? READBACK_IOS : READBACK_ANDROID) };
}

type Typed = BugseeLaunchOptions & Record<string, unknown>;

/**
 * Writes the scenario's options onto App.tsx's typed launch options. For
 * api-opt-all, the accessor keys go through the accessors.
 */
export function optionLaunchOverrides(scenario: string, options: BugseeLaunchOptions): void {
  if (scenario === 'api-opt-all') {
    const accessors: Record<string, string> = {
      ...ACCESSOR_KEYS.shared,
      ...(Platform.OS === 'ios' ? ACCESSOR_KEYS.ios : ACCESSOR_KEYS.android),
    };
    const byKey = new Map(Object.entries(accessors).map(([name, key]) => [key, name]));
    for (const [key, value] of Object.entries(readbackSet())) {
      const accessor = byKey.get(key);
      if (accessor !== undefined) {
        (options as Typed)[accessor] = value;
      } else {
        options.setCustomOption(key, value);
      }
    }
    return;
  }
  const effect = effectOf(scenario);
  if (effect !== undefined) {
    for (const [key, value] of Object.entries(EFFECT_OPTIONS[effect.case]!)) {
      options.setCustomOption(key, value);
    }
  }
}

/** `values` in lines of at most 12 keys (logcat cuts a line near 4 KB). */
function markChunks(tag: string, nonce: string, values: Record<string, unknown>): void {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  const size = 12;
  const total = Math.ceil(entries.length / size);
  for (let i = 0; i < total; i += 1) {
    const chunk = Object.fromEntries(entries.slice(i * size, (i + 1) * size));
    mark(`${tag} chunk nonce=${nonce} part=${i + 1}/${total} values=${JSON.stringify(chunk)}`);
  }
}

/**
 * Before launch(): net-on-launch owns its launch. It calls launch() and, in
 * the same JS turn, starts a request the stub holds for 4 s -- the window
 * `capture.network.on-launch` exists for (iOS: interception installed on
 * the launching thread, BGSCaptureCoordinator.m) -- then waits for
 * Launched and uploads. Returns whether it launched.
 */
export async function preLaunchOptions(scenario: string, nonce: string, context: ApiContext): Promise<boolean> {
  const effect = effectOf(scenario);
  if (effect?.case !== 'net-on-launch' && effect?.case !== 'net-on-launch-control') {
    return false;
  }
  const launched = Bugsee.launch(context.token, context.options());
  const request = fetch(stubUrl(`/delay/4000/status/200/api-onlaunch-${nonce}`)).catch(() => undefined);
  mark(`eff launch-and-fetch nonce=${nonce}`);
  const result = await settle(() => launched);
  console.log(`BUGSEE_E2E launch() resolved ${String(JSON.parse(result).value)}`);
  await request;
  await runEffect(effect.case, 'run', nonce);
  return true;
}

export async function runOptionScenario(scenario: string, nonce: string, context: ApiContext): Promise<void> {
  if (scenario === 'api-opt-defaults') {
    const effective = await Bugsee.getLaunchOptions();
    mark(`opt defaults nonce=${nonce} keys=${Object.keys(effective).length}`);
    markChunks('opt defaults', nonce, effective);
    mark(`opt defaults done nonce=${nonce}`);
    return;
  }
  if (scenario === 'api-opt-all') {
    return optAll(nonce);
  }
  if (scenario === 'api-opt-enums') {
    return optEnums(nonce, context);
  }
  const effect = effectOf(scenario);
  if (effect !== undefined) {
    await runEffect(effect.case, effect.step, nonce);
  }
}

async function optAll(nonce: string): Promise<void> {
  const effective = await Bugsee.getLaunchOptions();
  const set = readbackSet();
  const picked = Object.fromEntries(Object.keys(set).map(key => [key, effective[key] ?? null]));
  mark(`opt all nonce=${nonce} keys=${Object.keys(effective).length} set=${Object.keys(set).length}`);
  markChunks('opt all', nonce, picked);
  // OPT-ACC-06: a fresh object, refreshed from what the SDK reports, answers
  // every accessor with the native value.
  const fresh = createDefaultLaunchOptions() as unknown as Typed;
  BugseeLaunchOptions.refreshFrom(fresh, effective);
  const accessors: Record<string, string> = {
    ...ACCESSOR_KEYS.shared,
    ...(Platform.OS === 'ios' ? ACCESSOR_KEYS.ios : ACCESSOR_KEYS.android),
  };
  const getters = Object.fromEntries(Object.keys(accessors).map(name => [name, fresh[name] ?? null]));
  mark(`opt getters nonce=${nonce} values=${JSON.stringify(getters)}`);
  await delay(2_000);
  Bugsee.upload(`api-opt-all-${nonce}`, '');
  mark(`opt all uploaded nonce=${nonce}`);
}

async function optEnums(nonce: string, context: ApiContext): Promise<void> {
  const table = { ...ENUM_VALUES, ...(Platform.OS === 'android' ? ANDROID_ENUM_VALUES : {}) };
  const results: Record<string, Record<string, unknown>> = {};
  for (const [key, values] of Object.entries(table)) {
    results[key] = {};
    for (const value of values) {
      const settled = await settle(() => Bugsee.relaunch({ ...context.options(), [key]: value }));
      const effective = await Bugsee.getLaunchOptions();
      results[key]![String(value)] = JSON.parse(settled).ok === true ? (effective[key] ?? null) : `relaunch ${settled}`;
    }
    mark(`opt enum nonce=${nonce} key=${key} readback=${JSON.stringify(results[key])}`);
  }
  mark(`opt enums done nonce=${nonce} status=${await Bugsee.getStatus()}`);
}

async function quietFetch(url: string, init?: RequestInit): Promise<string> {
  try {
    const response = await fetch(url, init);
    await response.text();
    return String(response.status);
  } catch (error) {
    return `threw:${String(error)}`;
  }
}

/**
 * `<case>--<step>`. Steps that end the process (crash) or wait for the e2e
 * to act (idle, ready) say so with a marker first.
 */
async function runEffect(name: string, step: string, nonce: string): Promise<void> {
  const effective = await Bugsee.getLaunchOptions();
  const picked = Object.fromEntries(Object.keys(EFFECT_OPTIONS[name]!).map(key => [key, effective[key] ?? null]));
  mark(`eff options case=${name} step=${step} nonce=${nonce} values=${JSON.stringify(picked)}`);
  const upload = (suffix = '') => {
    Bugsee.upload(`api-eff-${name}${suffix}-${nonce}`, '');
    mark(`eff uploaded case=${name} nonce=${nonce}`);
  };
  switch (step) {
    case 'js':
      mark(`eff throwing case=${name} nonce=${nonce}`);
      setTimeout(() => Bugsee.testJsCrash(), 300);
      return;
    case 'native':
      mark(`eff crashing case=${name} nonce=${nonce}`);
      setTimeout(() => Bugsee.testNativeCrash(), 300);
      return;
    case 'segv':
      mark(`eff crashing case=${name} nonce=${nonce}`);
      setTimeout(() => crashNative('segv'), 300);
      return;
    case 'idle':
      mark(`eff idle case=${name} nonce=${nonce}`);
      return;
    case 'block':
      mark(`eff blocking case=${name} nonce=${nonce}`);
      await blockMain(6_000);
      mark(`eff blocked case=${name} nonce=${nonce}`);
      return;
    case 'fetch': {
      const failing = await quietFetch(stubUrl(`/status/500/api-http-${nonce}`));
      const missing = await quietFetch(stubUrl(`/status/404/api-http-${nonce}`));
      mark(`eff fetched case=${name} nonce=${nonce} s500=${failing} s404=${missing}`);
      return;
    }
    case 'headers': {
      const status = await quietFetch(stubUrl(`/status/200/api-san-${nonce}`), {
        headers: { Authorization: `Bearer api-secret-${nonce}`, Cookie: `api-cookie=${nonce}` },
      });
      mark(`eff fetched case=${name} nonce=${nonce} status=${status}`);
      await delay(2_000);
      upload();
      return;
    }
    case 'bytes': {
      const status = await quietFetch(stubUrl(`/bytes/64?api-bytes-${nonce}`));
      mark(`eff fetched case=${name} nonce=${nonce} status=${status}`);
      await delay(2_000);
      upload();
      return;
    }
    case 'notify':
      Bugsee.notify(`api-flush-${nonce}`, `api-flush-body-${nonce}`, IssueSeverity.Medium);
      mark(`eff notified case=${name} nonce=${nonce} at=${Date.now()}`);
      return;
    case 'background': {
      // The e2e sends the app to the background and back; upload on return.
      let wasBackground = false;
      const subscription = AppState.addEventListener('change', state => {
        mark(`eff appstate case=${name} nonce=${nonce} state=${state}`);
        if (state === 'background') {
          wasBackground = true;
        }
        if (state === 'active' && wasBackground) {
          subscription.remove();
          setTimeout(() => upload(), 3_000);
        }
      });
      mark(`eff ready case=${name} nonce=${nonce}`);
      return;
    }
    case 'dialog':
      Bugsee.showReportDialog(`api-eff-${name}-${nonce}`, '');
      mark(`eff dialog case=${name} nonce=${nonce}`);
      return;
    case 'oslog':
      nativeLog('error', `api-oslog error ${nonce}`);
      nativeLog('info', `api-oslog info ${nonce}`);
      await delay(2_000);
      upload();
      return;
    case 'ready':
      // The e2e writes something from outside the app, then the scenario uploads.
      mark(`eff ready case=${name} nonce=${nonce}`);
      await delay(8_000);
      upload();
      return;
    case 'secure': {
      const on = await setFlagSecure(true);
      mark(`eff flag-secure case=${name} nonce=${nonce} on=${String(on)}`);
      await delay(3_000);
      upload();
      await delay(3_000);
      await setFlagSecure(false);
      return;
    }
    case 'handler':
      Bugsee.setReportHandler({
        onAfterReportCreated: async report => {
          mark(`eff handler case=${name} nonce=${nonce} report=${report.id}`);
        },
      });
      await delay(1_000);
      upload();
      return;
    default:
      // `run`: a few seconds of screen, then one plain upload.
      await delay(4_000);
      upload();
  }
}
