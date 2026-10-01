/**
 * Task 7.5a: JS exceptions end to end on Android — handled, unhandled,
 * rejection, ErrorBoundary and the root reporter — into retained bundles.
 *
 * Task 7.5b: the same file on iOS. On the simulator (`E2E_IOS_TARGET=simulator`)
 * the SDK compiles `logException` / `logUnhandledException` out (verified
 * facts), so one case replaces 1–13: the `BugseeRN exception handled sent`
 * line proves the call reached the SDK, and 15 s later there are zero
 * bundles. On the iPhone (`E2E_IOS_TARGET=device`, Debug, `DEAD_ENDPOINT`
 * retention) cases 1–13 apply with the iOS values stated below; gated
 * `E2E_RELEASE=1` needs `IOS_CONFIGURATION=Release`.
 *
 * Android preconditions: the debug app is installed on the WOD_LX1
 * (`AMRJCP4718402860`), Metro serves this checkout (`adb reverse tcp:8081
 * tcp:<E2E_METRO_PORT>`), airplane mode is on before the app starts, and
 * bundles are cleared. Gated release cases need `E2E_RELEASE=1` with the
 * minified release APK installed.
 *
 * iOS preconditions: Debug app on the pinned simulator (`IOS_SIMULATOR_ID`)
 * with Metro, or on the allowlisted iPhone XS. Retention is the dead
 * endpoint (no airplane mode). NSLog text is contiguous:
 * `BugseeRN exception handled sent bytes=` /
 * `BugseeRN exception unhandled sent bytes=` /
 * `BugseeRN exception unhandled completed`.
 *
 * Markers, from scenarios/exceptions.tsx:
 *   BUGSEE_E2E exc handled-sent / rejection-sent / prelaunch-sent nonce=<n>
 *   BUGSEE_E2E exc boundary-onError / boundary-fallback
 *   BUGSEE_E2E exc app-handler fatal=<bool>
 *
 * Cases 7 and 10 are `it.failing` on Android for documented 7.3.0 gaps
 * (labels ignored; unhandled also files an error report). Do not weaken them.
 * On iOS both are plain `it` (labels apply; Debug files no second report).
 *
 * Case 12's red-box line must stay on Android. Gated release R2/R3 (controller
 * ruling): R13's second Bugsee crash was not retained on SDK 7.3.0; logcat
 * still shows RN's JavascriptException, but exactly one Bugsee bundle is filed.
 * On iOS cases 9 and 12 recover after `terminateIosApp()`, then copying the
 * stored `override_report.plcrash` onto `live_report.plcrash` (the only file
 * beta3 claims at the next launch), then `exc-observe`. A SIGTERM alone
 * leaves the override unclaimed. A SIGABRT files a different native crash.
 */
import { writeFileSync } from 'node:fs';

import {
  type PulledBundle,
  airplane,
  crashOf,
  listAndroidBundles,
  pullAndroidBundles,
  removePulledBundles,
  terminateIosApp,
  promoteStoredIosCrash,
} from './bundles';
import { ANDROID_PACKAGE, iosTarget } from './device';
import {
  ON_ANDROID,
  ON_IOS,
  type Run,
  awaitBundles,
  bridgeLine,
  clearBundles,
  listBundles,
  TARGET_NAME,
  describeDevice,
  escape,
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
  pidOf,
  resetScenario,
} from './scenario';

const itAndroid = ON_ANDROID ? it : it.skip;
const ON_IOS_SIM = ON_IOS && iosTarget() === 'simulator';
const ON_IOS_DEVICE = ON_IOS && iosTarget() === 'device';
const itIosDevice = ON_IOS_DEVICE ? it : it.skip;
const describeIosSimulator = ON_IOS_SIM ? describe : describe.skip;
const describeIosDevice = ON_IOS_DEVICE ? describe : describe.skip;
const describeRelease =
  ON_ANDROID && process.env.E2E_RELEASE === '1' ? describe : describe.skip;
const describeIosRelease =
  ON_IOS_DEVICE && process.env.E2E_RELEASE === '1' ? describe : describe.skip;

jest.setTimeout(20 * 60_000);

let log: DeviceLog;

/** Synthetic debug id the scenario registers for nonce `n`. */
function debugIdFor(nonce: string): string {
  return `8a1c2f4e-0d3b-5e6f-9a7b-${nonce.padStart(12, '0').slice(-12)}`;
}

interface CrashException {
  readonly name?: unknown;
  readonly reason?: unknown;
  readonly domain?: unknown;
  readonly additional_signature?: unknown;
  readonly [key: string]: unknown;
}

interface JsPayload {
  readonly name?: unknown;
  readonly reason?: unknown;
  readonly frames?: ReadonlyArray<{
    readonly data?: { readonly member?: unknown; readonly source?: unknown };
    readonly debug_id?: unknown;
    readonly [key: string]: unknown;
  }>;
  readonly cause?: JsPayload;
  readonly signature?: unknown;
  readonly platform_os?: unknown;
  readonly debug_ids?: unknown;
  readonly [key: string]: unknown;
}

function exceptionOf(crash: Record<string, unknown>): CrashException {
  const exception = crash.exception;
  if (exception === null || typeof exception !== 'object') {
    throw new Error(`crash.json has no exception object: ${JSON.stringify(crash)}`);
  }
  return exception as CrashException;
}

/** JSON.parse of `exception.reason`, after asserting it starts with `{`. */
function payloadOf(bundle: PulledBundle): JsPayload {
  const crash = crashOf(bundle);
  if (crash === undefined) {
    throw new Error(`bundle ${bundle.file} has no crash capture`);
  }
  const reason = exceptionOf(crash).reason;
  if (typeof reason !== 'string' || !reason.startsWith('{')) {
    throw new Error(
      `bundle ${bundle.file} exception.reason is not JSON text: ${String(reason).slice(0, 120)}`,
    );
  }
  return JSON.parse(reason) as JsPayload;
}

function bundlesWithReason(
  bundles: readonly PulledBundle[],
  reason: string,
): PulledBundle[] {
  return bundles.filter(b => {
    try {
      return payloadOf(b).reason === reason;
    } catch {
      return false;
    }
  });
}

function rawCrashContains(bundle: PulledBundle, needle: string): boolean {
  const text = bundle.captures.get('crash');
  return text !== undefined && text.includes(needle);
}

async function recoverStoredCrash(): Promise<{ observe: Run; bundles: PulledBundle[] }> {
  await terminateIosApp();
  await promoteStoredIosCrash();
  let observe = await startRun('exc-observe');
  let bundles = await awaitBundles(1, 20_000);
  if (bundles.length === 0) {
    // The first launch sometimes claims nothing after an earlier crash in the
    // same install. Promote again when the override is still on disk.
    await terminateIosApp();
    try {
      await promoteStoredIosCrash();
    } catch {
      return { observe, bundles };
    }
    observe = await startRun('exc-observe');
    bundles = await awaitBundles(1, 45_000);
  }
  return { observe, bundles };
}

function innermost(payload: JsPayload): JsPayload {
  let node: JsPayload = payload;
  while (node.cause !== undefined) {
    node = node.cause;
  }
  return node;
}

/**
 * Epoch logcat: `<sec>.<ms>  <pid>  <tid> <level> <tag>: <msg>`.
 * Returns [pid, tid] or undefined.
 */
function pidTidOf(line: LogLine): { pid: string; tid: string } | undefined {
  const match = /^\s*\d+\.\d+\s+(\d+)\s+(\d+)\s+\w\s+\S+\s*:/.exec(line.text);
  if (match === null) {
    return undefined;
  }
  return { pid: match[1]!, tid: match[2]! };
}

async function awaitProcessGone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await pidOf()) === undefined) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function processAliveAfter(ms: number): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, ms));
  return (await pidOf()) !== undefined;
}

describeDevice(`JS exceptions on ${TARGET_NAME}`, () => {
  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '7.5b');
      return;
    }
    if (!ON_ANDROID) {
      return;
    }
    log = await Logcat.start();
    useLog(log, '7.5a');
    await airplane(true);
  });

  afterAll(async () => {
    if (!ON_ANDROID && !ON_IOS) {
      return;
    }
    try {
      if (ON_IOS) {
        await terminateIosApp().catch(() => {});
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
    } finally {
      try {
        if (ON_ANDROID) {
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
              const dump = process.env.E2E_LOGCAT_DUMP;
              if (dump) {
                writeFileSync(dump, log.lines.map(line => line.text).join('\n'));
              }
            }
          } finally {
            resetScenario();
          }
        }
      }
    }
  });

  describe('exc-handled', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let handled: PulledBundle;
    let handledCrash: Record<string, unknown>;
    let handledPayload: JsPayload;
    let objectBundle: PulledBundle;
    let threadLine: LogLine | undefined;
    let threadComm: string | undefined;

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      await clearBundles();
      run = await startRun('exc-handled');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());
      expect(run.dev).toBe(true);

      must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E exc handled-sent nonce=${nonce}`),
          30_000,
          run.launched.index,
        ),
        'the handled-sent marker',
        run.start,
      );

      const sent = must(
        await log.waitFor(bridgeLine('exception handled sent'), 15_000, run.start),
        'exception handled sent',
        run.start,
      );
      threadLine = sent;
      const ids = pidTidOf(sent);
      if (ids !== undefined) {
        threadComm = (
          await adb('shell', 'cat', `/proc/${ids.pid}/task/${ids.tid}/comm`)
        ).trim();
        report('handled sent line', sent.text.trim());
        report('handled sent tid/comm', { tid: ids.tid, comm: threadComm });
      }

      bundles = await awaitBundles(2);
      report(
        'handled bundle files',
        bundles.map(b => ({ file: b.file, type: b.request.type })),
      );

      const handledOnes = bundlesWithReason(bundles, `E2E handled ${nonce}`);
      expect(handledOnes).toHaveLength(1);
      handled = handledOnes[0]!;
      handledCrash = crashOf(handled)!;
      handledPayload = payloadOf(handled);

      const objectOnes = bundlesWithReason(bundles, `obj-${nonce}`);
      expect(objectOnes).toHaveLength(1);
      objectBundle = objectOnes[0]!;
      report('handled payload', handledPayload);
    });

    itAndroid(
      'a handled exception is an error report named ReactNativeWebException',
      () => {
        expect(handled.request.type).toBe('error');
        expect(handledCrash.handled).toBe(true);
        expect(exceptionOf(handledCrash).name).toBe(
          'com.bugsee.reactnative.ReactNativeWebException',
        );
      },
    );

    itAndroid('the reason is the JS payload', () => {
      expect(handledPayload.name).toBe('TypeError');
      expect(handledPayload.frames?.[0]?.data?.member).toBe('bugseeE2EThrowSite');
      expect(handledPayload.signature).toMatch(/^[0-9a-f]{40}$/);
      expect(handledPayload.platform_os).toBe('android');
      expect(handledPayload.cause).toEqual(
        expect.objectContaining({
          name: 'RangeError',
          reason: `inner ${nonce}`,
        }),
      );
    });

    itAndroid('debug IDs travel as a map and on each frame of the bundle', () => {
      const ID = debugIdFor(nonce);
      const frame0 = handledPayload.frames?.[0];
      expect(frame0).toBeDefined();
      // On Metro/Android, fileKey === cleanSource, so frames[0].data.source is K.
      const K = frame0!.data?.source;
      expect(typeof K).toBe('string');
      expect(handledPayload.debug_ids).toEqual({ [K as string]: ID });
      for (const frame of handledPayload.frames ?? []) {
        if (frame.data?.source === K) {
          expect(frame.debug_id).toBe(ID);
        }
      }
      report('debug_ids', handledPayload.debug_ids);
      report('handled sent line', threadLine?.text.trim());
      report('thread BugseeRN-exceptions', threadComm);
      // Linux TASK_COMM_LEN is 16 (15 printable): `BugseeRN-exceptions` → `BugseeRN-except`.
      expect(threadComm).toBe('BugseeRN-except');
      expect(threadLine).toBeDefined();
    });

    itAndroid('the payload carries nothing else of the error', () => {
      for (const bundle of bundles) {
        expect(rawCrashContains(bundle, `tok-${nonce}`)).toBe(false);
        expect(rawCrashContains(bundle, `pw-${nonce}`)).toBe(false);
      }
      const objectPayload = payloadOf(objectBundle);
      expect(objectPayload.reason).toBe(`obj-${nonce}`);
      expect(objectPayload.name).toBe('Error');
    });

    itAndroid('the domain reaches the report', () => {
      expect(exceptionOf(handledCrash).domain).toBe(`e2e-${nonce}`);
    });

    itAndroid('the client signature carries the JS signature', () => {
      expect(exceptionOf(handledCrash).additional_signature).toBe(
        handledPayload.signature,
      );
    });

    itAndroid.failing('labels reach the report', () => {
      const labels = handled.request.labels;
      report('case 7 actual labels', labels);
      expect(labels).toEqual(expect.arrayContaining([`lbl-${nonce}`]));
    });
  });

  describe('exc-rejection', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      await clearBundles();
      run = await startRun('exc-rejection');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E exc rejection-sent nonce=${nonce}`),
          20_000,
          run.launched.index,
        ),
        'the rejection-sent marker',
        run.start,
      );
      bundles = await awaitBundles(1);
    });

    itAndroid('an unhandled rejection is one error report', () => {
      const matches = bundlesWithReason(bundles, `E2E rejection ${nonce}`);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.request.type).toBe('error');
    });
  });

  describe('exc-fatal', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let crashBundle: PulledBundle;
    let sent: LogLine;
    let completed: LogLine;
    let appHandler: LogLine;
    let alive: boolean;

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      await clearBundles();
      run = await startRun('exc-fatal');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());
      expect(run.dev).toBe(true);

      sent = must(
        await log.waitFor(bridgeLine('exception unhandled sent'), 20_000, run.launched.index),
        'exception unhandled sent',
        run.start,
      );
      completed = must(
        await log.waitFor(
          bridgeLine('exception unhandled completed'),
          10_000,
          sent.index,
        ),
        'exception unhandled completed',
        run.start,
      );
      appHandler = must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E exc app-handler fatal=true`),
          10_000,
          completed.index,
        ),
        'app-handler fatal=true',
        run.start,
      );
      alive = await processAliveAfter(3_000);
      report('fatal log order', {
        sent: sent.text.trim(),
        completed: completed.text.trim(),
        appHandler: appHandler.text.trim(),
        alive,
      });

      // 7.3.0 also files an error report for the same incident (case 10).
      // Wait for at least the crash, then a short beat for the extra error.
      await awaitBundles(1, 30_000);
      await new Promise(resolve => setTimeout(resolve, 3_000));
      bundles = await pullAndroidBundles();
      report(
        'fatal bundles',
        bundles.map(b => ({ file: b.file, type: b.request.type })),
      );

      const crashes = bundlesWithReason(bundles, `E2E fatal ${nonce}`).filter(
        b => b.request.type === 'crash',
      );
      expect(crashes.length).toBeGreaterThanOrEqual(1);
      crashBundle = crashes[0]!;
    });

    itAndroid('a fatal JS error is reported as a crash, then RN\'s handler runs', () => {
      expect(crashBundle.request.type).toBe('crash');
      expect(payloadOf(crashBundle).reason).toBe(`E2E fatal ${nonce}`);
      expect(sent.index).toBeLessThan(completed.index);
      expect(completed.index).toBeLessThan(appHandler.index);
      expect(alive).toBe(true);
    });

    itAndroid.failing(
      'the fatal error files no second report for the incident',
      () => {
        const others = bundles.filter(b => {
          if (b.file === crashBundle.file) {
            return false;
          }
          try {
            return payloadOf(b).reason === `E2E fatal ${nonce}` || rawCrashContains(b, `E2E fatal ${nonce}`);
          } catch {
            return rawCrashContains(b, `E2E fatal ${nonce}`);
          }
        });
        report(
          'case 10 extra bundles',
          others.map(b => ({
            file: b.file,
            type: b.request.type,
            name: crashOf(b) !== undefined ? exceptionOf(crashOf(b)!).name : undefined,
          })),
        );
        expect(others).toHaveLength(0);
      },
    );
  });

  describe('exc-boundary', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let onError: LogLine;
    let fallback: LogLine;

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      await clearBundles();
      run = await startRun('exc-boundary');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      onError = must(
        await log.waitFor(/BUGSEE_E2E exc boundary-onError/, 20_000, run.launched.index),
        'boundary-onError',
        run.start,
      );
      fallback = must(
        await log.waitFor(/BUGSEE_E2E exc boundary-fallback/, 10_000, onError.index),
        'boundary-fallback',
        run.start,
      );
      bundles = await awaitBundles(1);
    });

    itAndroid(
      'a boundary catches, reports as handled and renders the fallback',
      () => {
        const matches = bundlesWithReason(bundles, `E2E boundary ${nonce}`);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.request.type).toBe('error');
        const payload = payloadOf(matches[0]!);
        const inner = innermost(payload);
        expect(inner.name).toBe('ErrorBoundary Error');
        expect(
          (inner.frames ?? []).some(f => f.data?.member === 'BugseeE2EThrower'),
        ).toBe(true);
        expect(onError).toBeDefined();
        expect(fallback).toBeDefined();
      },
    );
  });

  describe('exc-root', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let sent: LogLine;
    let redBox: LogLine;

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      await clearBundles();
      run = await startRun('exc-root');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      sent = must(
        await log.waitFor(bridgeLine('exception unhandled sent'), 30_000, run.launched.index),
        'exception unhandled sent (root)',
        run.start,
      );
      // RN red box: ReactNativeJS E-level line carrying the message.
      redBox = must(
        await log.waitFor(
          new RegExp(`ReactNativeJS\\s*:\\s*.*E2E boundary ${escape(nonce)}`),
          20_000,
          sent.index,
        ),
        'RN red-box line for the root render error',
        run.start,
      );
      // Confirm it is an E-level line (epoch: ... E ReactNativeJS: ...).
      expect(redBox.text).toMatch(/\sE\s+ReactNativeJS\s*:/);
      report('root red-box', redBox.text.trim());

      // Poll until a crash with this reason exists (error twin may appear first
      // or never). Do not require a second bundle.
      const deadline = Date.now() + 30_000;
      for (;;) {
        bundles = await pullAndroidBundles();
        const crashMatch = bundlesWithReason(bundles, `E2E boundary ${nonce}`).find(
          b => b.request.type === 'crash',
        );
        if (crashMatch !== undefined || Date.now() >= deadline) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      report(
        'root bundles',
        bundles.map(b => ({
          file: b.file,
          type: b.request.type,
          name: crashOf(b) ? exceptionOf(crashOf(b)!).name : undefined,
        })),
      );
    });

    itAndroid(
      'a render error with no boundary is reported once, as a crash, by the root reporter',
      () => {
        // Brief: exactly one bundle with that reason *and* type crash.
        const crashes = bundlesWithReason(bundles, `E2E boundary ${nonce}`).filter(
          b => b.request.type === 'crash',
        );
        expect(crashes).toHaveLength(1);
        expect(sent.index).toBeLessThan(redBox.index);
      },
    );
  });

  describe('exc-prelaunch', () => {
    let run: Run;
    let nonce: string;
    let preSent: LogLine;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      if (!ON_ANDROID) {
        return;
      }
      await clearBundles();
      run = await startRun('exc-prelaunch');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      preSent = must(
        log.all(new RegExp(`BUGSEE_E2E exc prelaunch-sent nonce=${nonce}`), run.start)[0],
        'prelaunch-sent (must precede Launched)',
        run.start,
      );
      expect(preSent.index).toBeLessThan(run.launched.index);

      await new Promise(resolve => setTimeout(resolve, 10_000));
      const names = await listAndroidBundles();
      bundles = names.length === 0 ? [] : await pullAndroidBundles();
      report('prelaunch bundle count', bundles.length);
    });

    itAndroid('nothing reported before launch reaches a bundle', () => {
      expect(preSent.index).toBeLessThan(run.launched.index);
      for (const bundle of bundles) {
        const crashText = bundle.captures.get('crash') ?? '';
        expect(crashText.includes(`pre-${nonce}`)).toBe(false);
        try {
          expect(payloadOf(bundle).reason).not.toBe(`pre-${nonce}`);
        } catch {
          // no crash capture — fine
        }
      }
    });
  });

  describeRelease('gated E2E_RELEASE=1', () => {
    let run: Run;
    let nonce: string;
    let observe: Run;
    let bundles: PulledBundle[];
    let gone: boolean;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-fatal');
      nonce = run.scenario.nonce;
      report('release banner', run.banner.text.trim());
      expect(run.dev).toBe(false);

      must(
        await log.waitFor(/FATAL EXCEPTION/, 30_000, run.launched.index),
        'FATAL EXCEPTION',
        run.start,
      );
      must(
        await log.waitFor(
          /com\.facebook\.react\.common\.JavascriptException/,
          10_000,
          run.launched.index,
        ),
        'JavascriptException',
        run.start,
      );
      gone = await awaitProcessGone(15_000);
      report('release pid gone', gone);
      expect(gone).toBe(true);

      observe = await startRun('exc-observe');
      report('observe banner', observe.banner.text.trim());
      // Wait for recovery / bundling. One retained Bugsee bundle (R13's second
      // Bugsee crash is not retained on SDK 7.3.0 — controller ruling).
      await new Promise(resolve => setTimeout(resolve, 5_000));
      bundles = await awaitBundles(1, 60_000);
      report(
        'R1–R3 bundles',
        bundles.map(b => {
          const crash = crashOf(b);
          return {
            file: b.file,
            type: b.request.type,
            name: crash !== undefined ? exceptionOf(crash).name : undefined,
            reason:
              crash !== undefined && typeof exceptionOf(crash).reason === 'string'
                ? String(exceptionOf(crash).reason).slice(0, 80)
                : undefined,
          };
        }),
      );
    });

    itAndroid('ours survives R8', () => {
      const ours = bundles.filter(b => {
        if (b.request.type !== 'crash') {
          return false;
        }
        const crash = crashOf(b);
        if (crash === undefined) {
          return false;
        }
        if (exceptionOf(crash).name !== 'com.bugsee.reactnative.ReactNativeWebException') {
          return false;
        }
        try {
          return payloadOf(b).reason === `E2E fatal ${nonce}`;
        } catch {
          return false;
        }
      });
      expect(ours).toHaveLength(1);
      report('R1 ours', ours.map(b => b.file));
    });

    // Controller ruling (task 7.5a): R13's second Bugsee crash was not retained
    // on SDK 7.3.0. Logcat still shows RN's JavascriptException and the process
    // dies; Bugsee keeps exactly one crash — ReactNativeWebException.
    itAndroid('RN JavascriptException is not a second Bugsee bundle', () => {
      const rnNamed = bundles.filter(b => {
        const crash = crashOf(b);
        if (crash === undefined) {
          return false;
        }
        return String(exceptionOf(crash).name ?? '').includes('JavascriptException');
      });
      expect(rnNamed).toHaveLength(0);
      expect(bundles).toHaveLength(1);
      const only = bundles[0]!;
      expect(only.request.type).toBe('crash');
      expect(exceptionOf(crashOf(only)!).name).toBe(
        'com.bugsee.reactnative.ReactNativeWebException',
      );
      report('R2 single bundle', { file: only.file, type: only.request.type });
    });

    // Not it.failing on release: debug case 10 stays it.failing for the
    // crash+error double-file; release retains one bundle for the incident.
    itAndroid('exactly one bundle contains the fatal reason', () => {
      const withFatal = bundles.filter(b => rawCrashContains(b, `E2E fatal ${nonce}`));
      expect(withFatal).toHaveLength(1);
      report('R3 fatal bundles', withFatal.map(b => b.file));
    });
  });

  // --- Task 7.5b: iOS simulator documented behaviour -------------------------

  describeIosSimulator('simulator slice (logException compiled out)', () => {
    it('the simulator slice reports no JS exception', async () => {
      await clearBundles();
      const run = await startRun('exc-handled');
      const nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());
      expect(run.dev).toBe(true);

      must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E exc handled-sent nonce=${nonce}`),
          30_000,
          run.launched.index,
        ),
        'the handled-sent marker',
        run.start,
      );

      const sent = must(
        await log.waitFor(bridgeLine('exception handled sent'), 15_000, run.start),
        'exception handled sent',
        run.start,
      );
      report('simulator handled sent', sent.text.trim());
      expect(sent.text).toMatch(/BugseeRN exception handled sent bytes=\d+/);

      await new Promise(resolve => setTimeout(resolve, 15_000));
      const names = await listBundles();
      report('simulator bundle count after 15s', names.length);
      expect(names).toHaveLength(0);
    });
  });

  // --- Task 7.5b: iPhone Debug cases 1–13 ------------------------------------

  describeIosDevice('exc-handled (iPhone)', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let handled: PulledBundle;
    let handledCrash: Record<string, unknown>;
    let handledPayload: JsPayload;
    let objectBundle: PulledBundle;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-handled');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());
      expect(run.dev).toBe(true);

      must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E exc handled-sent nonce=${nonce}`),
          30_000,
          run.launched.index,
        ),
        'the handled-sent marker',
        run.start,
      );
      must(
        await log.waitFor(bridgeLine('exception handled sent'), 15_000, run.start),
        'exception handled sent',
        run.start,
      );

      bundles = await awaitBundles(2);
      report(
        'handled bundle files',
        bundles.map(b => ({ file: b.file, type: b.request.type })),
      );

      const handledOnes = bundlesWithReason(bundles, `E2E handled ${nonce}`);
      expect(handledOnes).toHaveLength(1);
      handled = handledOnes[0]!;
      handledCrash = crashOf(handled)!;
      handledPayload = payloadOf(handled);

      const objectOnes = bundlesWithReason(bundles, `obj-${nonce}`);
      expect(objectOnes).toHaveLength(1);
      objectBundle = objectOnes[0]!;
      report('handled payload', handledPayload);
      report('handled crash keys', {
        managed: handledCrash.managed,
        type: handledCrash.type,
        handled: handledCrash.handled,
      });
    });

    itIosDevice(
      'a handled exception is an error report named ReactNativeWebException',
      () => {
        expect(handled.request.type).toBe('error');
        expect(exceptionOf(handledCrash).name).toBe('ReactNativeWebException');
        expect(handledCrash.managed).toBe(true);
        expect(handledCrash.type).toBe('ios');
      },
    );

    itIosDevice('the reason is the JS payload', () => {
      expect(handledPayload.name).toBe('TypeError');
      expect(handledPayload.frames?.[0]?.data?.member).toBe('bugseeE2EThrowSite');
      expect(handledPayload.signature).toMatch(/^[0-9a-f]{40}$/);
      expect(handledPayload.platform_os).toBe('ios');
      expect(handledPayload.cause).toEqual(
        expect.objectContaining({
          name: 'RangeError',
          reason: `inner ${nonce}`,
        }),
      );
    });

    itIosDevice('debug IDs travel as a map and on each frame of the bundle', () => {
      const ID = debugIdFor(nonce);
      const frame0 = handledPayload.frames?.[0];
      expect(frame0).toBeDefined();
      const K = frame0!.data?.source;
      expect(typeof K).toBe('string');
      expect(handledPayload.debug_ids).toEqual({ [K as string]: ID });
      for (const frame of handledPayload.frames ?? []) {
        if (frame.data?.source === K) {
          expect(frame.debug_id).toBe(ID);
        }
      }
      report('debug_ids', handledPayload.debug_ids);
    });

    itIosDevice('the payload carries nothing else of the error', () => {
      for (const bundle of bundles) {
        expect(rawCrashContains(bundle, `tok-${nonce}`)).toBe(false);
        expect(rawCrashContains(bundle, `pw-${nonce}`)).toBe(false);
      }
      const objectPayload = payloadOf(objectBundle);
      expect(objectPayload.reason).toBe(`obj-${nonce}`);
      expect(objectPayload.name).toBe('Error');
    });

    itIosDevice('the domain reaches the report', () => {
      const opts = handledCrash.exceptionLoggingOptions as
        | Record<string, unknown>
        | undefined;
      expect(opts).toBeDefined();
      expect(opts!.exceptionDomain).toBe(`e2e-${nonce}`);
      expect(opts!.includeVideo).toBe(true);
    });

    itIosDevice('the client signature carries the JS signature', () => {
      expect(exceptionOf(handledCrash).additional_signature).toBe(
        handledPayload.signature,
      );
    });

    itIosDevice('labels reach the report', () => {
      const labels = handled.request.labels;
      report('case 7 iOS labels', labels);
      expect(labels).toEqual(expect.arrayContaining([`lbl-${nonce}`]));
    });
  });

  describeIosDevice('exc-rejection (iPhone)', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-rejection');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E exc rejection-sent nonce=${nonce}`),
          20_000,
          run.launched.index,
        ),
        'the rejection-sent marker',
        run.start,
      );
      bundles = await awaitBundles(1);
    });

    itIosDevice('an unhandled rejection is one error report', () => {
      const matches = bundlesWithReason(bundles, `E2E rejection ${nonce}`);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.request.type).toBe('error');
    });
  });

  describeIosDevice('exc-fatal (iPhone)', () => {
    let run: Run;
    let observe: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let crashBundle: PulledBundle;
    let sent: LogLine;
    let completed: LogLine;
    let appHandler: LogLine;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-fatal');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());
      expect(run.dev).toBe(true);

      sent = must(
        await log.waitFor(bridgeLine('exception unhandled sent'), 20_000, run.launched.index),
        'exception unhandled sent',
        run.start,
      );
      completed = must(
        await log.waitFor(
          bridgeLine('exception unhandled completed'),
          10_000,
          sent.index,
        ),
        'exception unhandled completed',
        run.start,
      );
      appHandler = must(
        await log.waitFor(
          new RegExp(`BUGSEE_E2E exc app-handler fatal=true`),
          10_000,
          completed.index,
        ),
        'app-handler fatal=true',
        run.start,
      );
      report('fatal log order', {
        sent: sent.text.trim(),
        completed: completed.text.trim(),
        appHandler: appHandler.text.trim(),
      });
      expect(sent.index).toBeLessThan(completed.index);
      expect(completed.index).toBeLessThan(appHandler.index);

      // Stored, not sent. Terminate, then put the stored override where the
      // next launch claims it (`live_report.plcrash`).
      await recoverStoredCrash().then(recovered => {
        observe = recovered.observe;
        bundles = recovered.bundles;
      });
      report(
        'fatal recovered bundles',
        bundles.map(b => {
          const crash = crashOf(b);
          const exception = crash?.exception;
          const reason =
            exception !== null && typeof exception === 'object'
              ? String((exception as { reason?: unknown }).reason).slice(0, 160)
              : undefined;
          const name =
            exception !== null && typeof exception === 'object'
              ? (exception as { name?: unknown }).name
              : undefined;
          return {
            file: b.file,
            type: b.request.type,
            name,
            reason,
            hasFatal: rawCrashContains(b, `E2E fatal ${nonce}`),
          };
        }),
      );

      const crashes = bundlesWithReason(bundles, `E2E fatal ${nonce}`).filter(
        b => b.request.type === 'crash',
      );
      expect(crashes).toHaveLength(1);
      crashBundle = crashes[0]!;
    });

    itIosDevice(
      'a fatal JS error is reported as a crash, then RN\'s handler runs',
      () => {
        expect(crashBundle.request.type).toBe('crash');
        expect(payloadOf(crashBundle).reason).toBe(`E2E fatal ${nonce}`);
        expect(sent.index).toBeLessThan(completed.index);
        expect(completed.index).toBeLessThan(appHandler.index);
      },
    );

    itIosDevice('the fatal error files no second report for the incident', () => {
      const others = bundles.filter(b => {
        if (b.file === crashBundle.file) {
          return false;
        }
        try {
          return (
            payloadOf(b).reason === `E2E fatal ${nonce}` ||
            rawCrashContains(b, `E2E fatal ${nonce}`)
          );
        } catch {
          return rawCrashContains(b, `E2E fatal ${nonce}`);
        }
      });
      report(
        'case 10 iOS extra bundles',
        others.map(b => ({
          file: b.file,
          type: b.request.type,
          name: crashOf(b) !== undefined ? exceptionOf(crashOf(b)!).name : undefined,
        })),
      );
      expect(others).toHaveLength(0);
      expect(bundles).toHaveLength(1);
    });
  });

  describeIosDevice('exc-boundary (iPhone)', () => {
    let run: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let onError: LogLine;
    let fallback: LogLine;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-boundary');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      onError = must(
        await log.waitFor(/BUGSEE_E2E exc boundary-onError/, 20_000, run.launched.index),
        'boundary-onError',
        run.start,
      );
      fallback = must(
        await log.waitFor(/BUGSEE_E2E exc boundary-fallback/, 10_000, onError.index),
        'boundary-fallback',
        run.start,
      );
      bundles = await awaitBundles(1);
    });

    itIosDevice(
      'a boundary catches, reports as handled and renders the fallback',
      () => {
        const matches = bundlesWithReason(bundles, `E2E boundary ${nonce}`);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.request.type).toBe('error');
        const payload = payloadOf(matches[0]!);
        const inner = innermost(payload);
        expect(inner.name).toBe('ErrorBoundary Error');
        expect(
          (inner.frames ?? []).some(f => f.data?.member === 'BugseeE2EThrower'),
        ).toBe(true);
        expect(onError).toBeDefined();
        expect(fallback).toBeDefined();
      },
    );
  });

  describeIosDevice('exc-root (iPhone)', () => {
    let run: Run;
    let observe: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let sent: LogLine;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-root');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      sent = must(
        await log.waitFor(bridgeLine('exception unhandled sent'), 30_000, run.launched.index),
        'exception unhandled sent (root)',
        run.start,
      );
      must(
        await log.waitFor(
          bridgeLine('exception unhandled completed'),
          15_000,
          sent.index,
        ),
        'exception unhandled completed (root)',
        run.start,
      );
      report('root unhandled sent', sent.text.trim());

      const recovered = await recoverStoredCrash();
      observe = recovered.observe;
      bundles = recovered.bundles;
      report(
        'root recovered bundles',
        bundles.map(b => ({
          file: b.file,
          type: b.request.type,
          name: crashOf(b) ? exceptionOf(crashOf(b)!).name : undefined,
        })),
      );
    });

    itIosDevice(
      'a render error with no boundary is reported once, as a crash, by the root reporter',
      () => {
        const crashes = bundlesWithReason(bundles, `E2E boundary ${nonce}`).filter(
          b => b.request.type === 'crash',
        );
        expect(crashes).toHaveLength(1);
        expect(bundles).toHaveLength(1);
      },
    );
  });

  describeIosDevice('exc-prelaunch (iPhone)', () => {
    let run: Run;
    let nonce: string;
    let preSent: LogLine;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-prelaunch');
      nonce = run.scenario.nonce;
      report('banner', run.banner.text.trim());

      preSent = must(
        log.all(new RegExp(`BUGSEE_E2E exc prelaunch-sent nonce=${nonce}`), run.start)[0],
        'prelaunch-sent (must precede Launched)',
        run.start,
      );
      expect(preSent.index).toBeLessThan(run.launched.index);

      await new Promise(resolve => setTimeout(resolve, 10_000));
      const names = await listBundles();
      bundles = names.length === 0 ? [] : await awaitBundles(names.length, 5_000);
      report('prelaunch bundle count', bundles.length);
    });

    itIosDevice('nothing reported before launch reaches a bundle', () => {
      expect(preSent.index).toBeLessThan(run.launched.index);
      for (const bundle of bundles) {
        const crashText = bundle.captures.get('crash') ?? '';
        expect(crashText.includes(`pre-${nonce}`)).toBe(false);
        try {
          expect(payloadOf(bundle).reason).not.toBe(`pre-${nonce}`);
        } catch {
          // no crash capture — fine
        }
      }
    });
  });

  describeIosRelease('gated E2E_RELEASE=1 (iPhone Release)', () => {
    let run: Run;
    let observe: Run;
    let nonce: string;
    let bundles: PulledBundle[];
    let consoleEnded: boolean;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('exc-fatal');
      nonce = run.scenario.nonce;
      report('release banner', run.banner.text.trim());
      expect(run.dev).toBe(false);

      must(
        await log.waitFor(bridgeLine('exception unhandled sent'), 30_000, run.launched.index),
        'exception unhandled sent (release)',
        run.start,
      );

      // Release: the process dies; the console stream ends with it.
      const ended = run.launch?.ended;
      if (ended === undefined) {
        throw new Error('iOS release run has no launch.ended promise');
      }
      const race = await Promise.race([
        ended.then(() => 'ended' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 30_000)),
      ]);
      consoleEnded = race === 'ended';
      report('release console ended', consoleEnded);
      expect(consoleEnded).toBe(true);

      // The process died on RCTFatal. beta3 still only claims
      // live_report.plcrash at the next launch; the stored JS exception is
      // override_report.plcrash until it is copied there.
      await promoteStoredIosCrash().catch(error => report('release promote', String(error).slice(0, 180)));
      observe = await startRun('exc-observe');
      report('release observe banner', observe.banner.text.trim());
      await new Promise(resolve => setTimeout(resolve, 5_000));
      bundles = await awaitBundles(1, 60_000);
      report(
        'iOS release bundles',
        bundles.map(b => {
          const crash = crashOf(b);
          return {
            file: b.file,
            type: b.request.type,
            name: crash !== undefined ? exceptionOf(crash).name : undefined,
            reason:
              crash !== undefined && typeof exceptionOf(crash).reason === 'string'
                ? String(exceptionOf(crash).reason).slice(0, 80)
                : undefined,
          };
        }),
      );
    });

    itIosDevice('exactly one ReactNativeWebException crash for the fatal', () => {
      const ours = bundles.filter(b => {
        if (b.request.type !== 'crash') {
          return false;
        }
        const crash = crashOf(b);
        if (crash === undefined) {
          return false;
        }
        if (exceptionOf(crash).name !== 'ReactNativeWebException') {
          return false;
        }
        try {
          return payloadOf(b).reason === `E2E fatal ${nonce}`;
        } catch {
          return false;
        }
      });
      expect(ours).toHaveLength(1);

      const rctFatal = bundles.filter(b => {
        const crash = crashOf(b);
        if (crash === undefined) {
          return false;
        }
        return String(exceptionOf(crash).name ?? '').includes('RCTFatalException');
      });
      if (rctFatal.length > 0) {
        throw new Error(
          `second RCTFatalException bundle arrived: ${rctFatal.map(b => b.file).join(', ')}`,
        );
      }
      expect(bundles).toHaveLength(1);
      report('iOS release single bundle', { file: ours[0]!.file });
    });
  });
});
