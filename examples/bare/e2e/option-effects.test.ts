/**
 * N-07: launch options proven by an effect a device shows offline (section
 * 1.4, the "N" rows; FLOW-44..47, FLOW-49).
 *
 * Every case launches `api-eff-<case>--<step>` (scenarios/api-options.ts):
 * the case's options from scenarios/api-constants.ts EFFECT_OPTIONS on top
 * of the app's own, then the step's work. A `-control` case does the same
 * work at the defaults, in the same suite run, and the effect is read
 * against it. Each case runs once per suite (cached), however many tests
 * read it.
 *
 * Targets: A = the Android handset, S = the iOS simulator, X = the iPhone.
 * A case that needs a crash reporter is A and X; an iOS-only key is S and X.
 *
 * Not here (MANUAL or out of reach offline): opt-ui-required, opt-ui-hidden,
 * opt-ui-style, opt-trigger-*, opt-video-fullscreen, opt-frustration,
 * opt-privacy-blur, opt-wifi-only (section 2.3); opt-broadcast, whose
 * receiver is not exported and needs a signature permission, so only the app
 * itself can send it (no in-app sender exists yet: reported as not covered).
 */
import { type PulledBundle, airplane, captureEvents, crashOf } from './bundles';
import { apiMarker, jsonAfter } from './api-markers';
import { ANDROID_PACKAGE, iosTarget } from './device';
import {
  ON_ANDROID,
  ON_IOS,
  type Run,
  TARGET_NAME,
  awaitBundles,
  clearBundles,
  describeDevice,
  listBundles,
  report,
  startRun,
  stopApp,
} from './harness';
import { LUMA_BRIGHT_MIN, LUMA_DARK_MAX, imageSize, regionLuma } from './media';
import { beginRetainingSuite, endRetainingSuite, frameCount } from './observe';
import { type DeviceLog, type LogLine, adbStatus, devicectl, devicePidsOfApp, pidOf } from './scenario';
import { centreRegion, uiDump } from './screen';
import { type StubServer, deviceStubUrl, releaseDeviceStub, startStubServerFor } from './stub-server';

jest.setTimeout(10 * 60_000);

const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';
const ON_IPHONE = ON_IOS && !ON_SIMULATOR;
type Target = 'A' | 'S' | 'X';
const HERE: Target = ON_ANDROID ? 'A' : ON_SIMULATOR ? 'S' : 'X';

/**
 * The native crash step: a SIGSEGV on Android, where a Debug build's red box
 * catches testNativeCrash()'s Java exception before it can kill the process;
 * testNativeCrash() (an NSException) on the iPhone.
 */
const NATIVE_CRASH = ON_ANDROID ? 'segv' : 'native';

/** `it` when this target is one of `targets`, else a skip that says where it runs. */
function on(targets: readonly Target[]): jest.It {
  return targets.includes(HERE) ? it : it.skip;
}

interface Outcome {
  readonly run: Run;
  readonly options: LogLine;
  readonly bundles: PulledBundle[];
}

describeDevice(`launch option effects on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let stub: StubServer | undefined;
  let stubUrl: string | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-07');
  });

  afterAll(async () => {
    if (stub !== undefined) {
      await releaseDeviceStub(ON_IOS ? 'ios' : 'android').catch(() => {});
      await stub.close();
    }
    await endRetainingSuite(log);
  });

  async function useStub(): Promise<string> {
    if (stubUrl === undefined) {
      stub = await startStubServerFor(ON_IOS ? 'ios' : 'android');
      stubUrl = await deviceStubUrl(stub, ON_IOS ? 'ios' : 'android');
    }
    return stubUrl;
  }

  /** Starts `api-eff-<name>--<step>` and waits for its options marker. */
  async function launch(name: string, step: string, withStub = false): Promise<{ run: Run; options: LogLine }> {
    const run = await startRun(`api-eff-${name}--${step}`, withStub ? { stub: await useStub() } : {});
    const options = await apiMarker(log!, `eff options case=${name} step=${step}`, run.scenario.nonce, 30_000, run.start);
    report(`${name}--${step} options`, jsonAfter(options.text, 'values'));
    return { run, options };
  }

  async function waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const alive = ON_ANDROID ? (await pidOf()) !== undefined : ON_IPHONE ? (await devicePidsOfApp()).length > 0 : false;
      if (!alive) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  const cache = new Map<string, Promise<Outcome>>();

  /** One uploading run of `<name>--<step>`: the case's own upload and whatever else it filed. */
  function uploaded(name: string, step = 'run', withStub = false): Promise<Outcome> {
    const key = `${name}--${step}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => {
          await clearBundles();
          const { run, options } = await launch(name, step, withStub);
          await apiMarker(log!, `eff uploaded case=${name}`, run.scenario.nonce, 40_000, run.start);
          const bundles = await awaitBundles(1, 60_000);
          await stopApp();
          report(`${key} bundles`, bundles.map(b => ({ summary: b.request.summary, type: b.request.type })));
          return { run, options, bundles };
        })(),
      );
    }
    return cache.get(key)!;
  }

  function own(outcome: Outcome, name: string): PulledBundle {
    const summary = `api-eff-${name}-${outcome.run.scenario.nonce}`;
    const found = outcome.bundles.filter(b => b.request.summary === summary);
    if (found.length !== 1) {
      throw new Error(`expected one ${summary}, got ${JSON.stringify(outcome.bundles.map(b => b.request.summary))}`);
    }
    return found[0]!;
  }

  function networkOf(bundle: PulledBundle): Array<Record<string, unknown>> {
    return captureEvents(bundle, 'network');
  }

  // -------------------------------------------------------------------------
  // Crash detection off, early crash, Mach exceptions, on-device symbolication

  /**
   * Android 7.3.0: with detect.crash=false the JS fatal is not reported, but
   * a native SIGSEGV still is, at the next launch ("Native crash: null
   * pointer dereference", crash.tombstone; WOD_LX1, 2026-10-07): the NDK
   * crash path does not honour the option. To file (bugsee-android).
   */
  (HERE === 'A' ? it.failing : on(['X']))(`[OPT-025] detect.crash=false: neither a JS fatal nor a native crash is reported${HERE === 'A' ? ' [known: Android NDK crashes ignore detect.crash=false (to file)]' : ''}`, async () => {
    await clearBundles();
    const js = await launch('crash-off', 'js');
    expect(jsonAfter(js.options.text, 'values')).toEqual({ 'com.bugsee.option.detect.crash': false });
    await apiMarker(log!, 'eff throwing case=crash-off', js.run.scenario.nonce, 10_000, js.run.start);
    await new Promise(resolve => setTimeout(resolve, 8_000));
    await stopApp();
    const native = await launch('crash-off', NATIVE_CRASH);
    await apiMarker(log!, 'eff crashing case=crash-off', native.run.scenario.nonce, 10_000, native.run.start);
    expect(await waitForExit(20_000)).toBe(true);
    await stopApp();
    const idle = await launch('crash-off', 'idle');
    await apiMarker(log!, 'eff idle case=crash-off', idle.run.scenario.nonce, 10_000, idle.run.start);
    await new Promise(resolve => setTimeout(resolve, 15_000));
    const names = await listBundles();
    const bundles = names.length === 0 ? [] : await awaitBundles(names.length, 1_000);
    await stopApp();
    report('bundles after a JS fatal and a native crash with detect.crash=false', bundles.map(b => ({ type: b.request.type, summary: b.request.summary })));
    expect(bundles.filter(b => b.request.type === 'crash')).toEqual([]);
  });

  on(['A', 'X'])('[OPT-026] detect.early-crash: a crash within a second of launch is recovered at the next launch', async () => {
    await clearBundles();
    const crash = await launch('early-crash', NATIVE_CRASH);
    await apiMarker(log!, 'eff crashing case=early-crash', crash.run.scenario.nonce, 10_000, crash.run.start);
    expect(await waitForExit(20_000)).toBe(true);
    await stopApp();
    await launch('early-crash', 'idle');
    const bundles = await awaitBundles(1, 60_000);
    await stopApp();
    const crashes = bundles.filter(b => b.request.type === 'crash');
    report('early crash recovered', crashes.map(b => ({ summary: b.request.summary, exception: (crashOf(b)?.exception as { name?: unknown } | undefined)?.name })));
    expect(crashes).toHaveLength(1);
  });

  on(['X'])('[OPT-055] capture.mach-exceptions=false: a SIGSEGV is still recovered, as a signal', async () => {
    await clearBundles();
    const crash = await launch('mach-off', 'segv');
    await apiMarker(log!, 'eff crashing case=mach-off', crash.run.scenario.nonce, 10_000, crash.run.start);
    expect(await waitForExit(20_000)).toBe(true);
    await stopApp();
    await launch('mach-off', 'idle');
    const bundles = await awaitBundles(1, 60_000);
    await stopApp();
    const crashes = bundles.filter(b => b.request.type === 'crash');
    expect(crashes).toHaveLength(1);
    const text = JSON.stringify(crashOf(crashes[0]!));
    report('mach-off crash (head)', text.slice(0, 600));
    expect(text).toMatch(/SIGSEGV/);
  });

  on(['X'])('[OPT-056] capture.on-device-symbolication names the frames the control leaves bare', async () => {
    const frames = async (name: string): Promise<string> => {
      await clearBundles();
      const crash = await launch(name, 'native');
      await apiMarker(log!, `eff crashing case=${name}`, crash.run.scenario.nonce, 10_000, crash.run.start);
      expect(await waitForExit(20_000)).toBe(true);
      await stopApp();
      await launch(name, 'idle');
      const bundles = (await awaitBundles(1, 60_000)).filter(b => b.request.type === 'crash');
      await stopApp();
      expect(bundles).toHaveLength(1);
      return JSON.stringify(crashOf(bundles[0]!));
    };
    const symbolicated = await frames('ondevice-sym');
    const control = await frames('ondevice-sym-control');
    // testNativeCrash() raises from -[BugseeModule testCrash]: a symbolicated
    // report names that frame; an unsymbolicated one has only its address.
    const named = (text: string) => /testCrash/.test(text);
    report('crash text heads', { symbolicated: symbolicated.slice(0, 1200), control: control.slice(0, 1200) });
    report('names testCrash', { symbolicated: named(symbolicated), control: named(control) });
    expect(named(symbolicated)).toBe(true);
    expect(named(control)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Exit and kill detection

  on(['A'])('[OPT-094][OPT-027][FLOW-46] detect.exit.user_requested: a force-stop is reported at the next launch, not without it', async () => {
    const after = async (name: string): Promise<PulledBundle[]> => {
      await clearBundles();
      const first = await launch(name, 'idle');
      await apiMarker(log!, `eff idle case=${name}`, first.run.scenario.nonce, 10_000, first.run.start);
      await new Promise(resolve => setTimeout(resolve, 5_000));
      await adbStatus('shell', 'am', 'force-stop', ANDROID_PACKAGE);
      await new Promise(resolve => setTimeout(resolve, 2_000));
      await launch(name, 'idle');
      await new Promise(resolve => setTimeout(resolve, 20_000));
      const names = await listBundles();
      const bundles = names.length === 0 ? [] : await awaitBundles(names.length, 1_000);
      await stopApp();
      report(`${name} bundles`, bundles.map(b => ({ type: b.request.type, summary: b.request.summary, crash: JSON.stringify(crashOf(b) ?? {}).slice(0, 200) })));
      return bundles;
    };
    const exit = await after('exit');
    const control = await after('exit-control');
    expect(control).toEqual([]);
    expect(exit.length).toBeGreaterThan(0);
  });

  /**
   * iOS 7.0.0-beta5: nothing in the library reads detect.kill -- it is only
   * registered (BGSOptionsDescriptors.m) -- and a SIGKILL while running
   * files nothing at the next launch (XS, 2026-10-07). To file (bugsee-cocoa).
   */
  (HERE === 'X' ? it.failing : it.skip)('[OPT-068] detect.kill: a SIGKILL is reported at the next launch [known: iOS beta5 never reads detect.kill (to file)]', async () => {
    await clearBundles();
    const first = await launch('kill', 'idle');
    await apiMarker(log!, 'eff idle case=kill', first.run.scenario.nonce, 10_000, first.run.start);
    await new Promise(resolve => setTimeout(resolve, 5_000));
    for (const pid of await devicePidsOfApp()) {
      await devicectl('process', 'signal', '--pid', String(pid), '--signal', 'SIGKILL');
    }
    expect(await waitForExit(15_000)).toBe(true);
    await launch('kill', 'idle');
    await new Promise(resolve => setTimeout(resolve, 20_000));
    const names = await listBundles();
    const bundles = names.length === 0 ? [] : await awaitBundles(names.length, 1_000);
    await stopApp();
    report('kill bundles', bundles.map(b => ({ type: b.request.type, summary: b.request.summary })));
    expect(bundles.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Hang and HTTP error detection

  // The simulator slice files no error report (no exception reporter): A and X.
  on(['A', 'X'])('[OPT-029][OPT-030][FLOW-44] detect.hang: a 6 s main-thread block is reported; with hang detection off it is not', async () => {
    const blocked = async (name: string, waitMs: number): Promise<PulledBundle[]> => {
      await clearBundles();
      const { run } = await launch(name, 'block');
      await apiMarker(log!, `eff blocked case=${name}`, run.scenario.nonce, 30_000, run.start);
      const deadline = Date.now() + waitMs;
      while ((await listBundles()).length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      const names = await listBundles();
      const bundles = names.length === 0 ? [] : await awaitBundles(names.length, 1_000);
      await stopApp();
      report(`${name} bundles`, bundles.map(b => ({ type: b.request.type, summary: b.request.summary })));
      return bundles;
    };
    const hang = await blocked('hang', 40_000);
    const control = await blocked('hang-control', 20_000);
    expect(hang.length).toBeGreaterThan(0);
    expect(control).toEqual([]);
  });

  on(['A', 'X'])('[OPT-033][FLOW-45] detect.http-errors: a 500 response is reported; without the option it is not', async () => {
    const fetched = async (name: string, waitMs: number): Promise<PulledBundle[]> => {
      await clearBundles();
      const { run } = await launch(name, 'fetch', true);
      const line = await apiMarker(log!, `eff fetched case=${name}`, run.scenario.nonce, 30_000, run.start);
      expect(line.text).toMatch(/ s500=500 /);
      const deadline = Date.now() + waitMs;
      while ((await listBundles()).length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      const names = await listBundles();
      const bundles = names.length === 0 ? [] : await awaitBundles(names.length, 1_000);
      await stopApp();
      report(`${name} bundles`, bundles.map(b => ({ type: b.request.type, summary: b.request.summary })));
      return bundles;
    };
    const errors = await fetched('http-errors', 40_000);
    const control = await fetched('http-errors-control', 15_000);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors.map(b => b.request))).toMatch(/500/);
    expect(control).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Network capture options

  on(['A', 'S', 'X'])('[OPT-008][FLOW-49] capture.network.default-sanitizer: Authorization and Cookie are redacted by default, kept when off', async () => {
    const headersOf = async (name: string): Promise<string> => {
      const outcome = await uploaded(name, 'headers', true);
      const events = networkOf(own(outcome, name)).filter(e => String(e.url ?? '').includes(`api-san-${outcome.run.scenario.nonce}`));
      report(`${name} request events`, events.map(e => JSON.stringify(e).slice(0, 400)));
      expect(events.length).toBeGreaterThan(0);
      return JSON.stringify(events);
    };
    const off = await headersOf('sanitizer-off');
    const control = await headersOf('sanitizer-control');
    expect(off).toMatch(/api-secret-/);
    expect(control).not.toMatch(/api-secret-/);
  });

  /**
   * iOS 7.0.0-beta5 records the response twice under one URLSession event id
   * ("complete", body null, then "complete" with the body), and the second
   * carries the untyped body with body-without-type at its default (false)
   * as well as with it on (XS, 2026-10-07): the option never withholds it.
   * BGSNetworkHelperMethods.m gates only the first. To file (bugsee-cocoa).
   */
  (ON_IOS ? it.failing : on(['A']))(`[OPT-007] capture.network.body-without-type: a response body with no Content-Type is kept only with the option${ON_IOS ? ' [known: iOS keeps untyped bodies with the option off (to file)]' : ''}`, async () => {
    const bodyOf = async (name: string): Promise<string> => {
      const outcome = await uploaded(name, 'bytes', true);
      const events = networkOf(own(outcome, name)).filter(e => String(e.url ?? '').includes(`api-bytes-${outcome.run.scenario.nonce}`));
      // The response body fields only (Android `body`, iOS `custom.body`).
      const bodies = events.map(e => (e.custom as { body?: unknown } | undefined)?.body ?? e.body ?? null);
      report(`${name} events`, events.map(e => ({ mechanism: e.mechanism, id: e.id, type: e.type, status: e.status, body: String(JSON.stringify((e.custom as { body?: unknown } | undefined)?.body ?? e.body ?? null)).slice(0, 120), noBody: (e.custom as { no_body_reason?: unknown } | undefined)?.no_body_reason })));
      expect(events.length).toBeGreaterThan(0);
      return JSON.stringify(bodies);
    };
    const kept = await bodyOf('body-no-type');
    const control = await bodyOf('body-no-type-control');
    // The stub's /bytes/64 body is 64 x "x", with no Content-Type.
    expect(kept).toContain('x'.repeat(32));
    expect(control).not.toContain('x'.repeat(32));
  });

  // iOS records the same two "complete" events with and without the option
  // (XS: no "before" either way), so the difference is Android's only;
  // iOS is read back by N-06.
  on(['A'])('[OPT-009] capture.network.on-launch: a request started in launch()\'s own turn is captured from its start only with the option', async () => {
    const has = async (name: string): Promise<boolean> => {
      const outcome = await uploaded(name, 'run', true);
      const events = networkOf(own(outcome, name)).filter(e => String(e.url ?? '').includes(`api-onlaunch-${outcome.run.scenario.nonce}`));
      report(`${name} events`, events.map(e => ({ mechanism: e.mechanism, id: e.id, type: e.type, status: e.status, timestamp: e.timestamp })));
      // Both runs record the response; only on-launch records the request
      // being started, issued in launch()'s own JS turn (WOD_LX1: "before"
      // with the option, "complete" alone without).
      return events.some(e => e.type === 'before');
    };
    const onLaunch = await has('net-on-launch');
    const control = await has('net-on-launch-control');
    report('on-launch: request start captured', { onLaunch, control });
    expect(onLaunch).toBe(true);
    expect(control).toBe(false);
  });

  /**
   * Not covered: React Native's WebSocket is SocketRocket, which the iOS SDK
   * does not intercept -- the control run (capture.websocket at its default,
   * on) records no websocket event for Metro's /hot socket on the XS, so
   * turning the option off has nothing to remove. Read back by N-06.
   */
  it.skip('[OPT-062] capture.websocket=false: not observable -- the SDK records no React Native (SocketRocket) websocket even with the option on', () => {});

  // -------------------------------------------------------------------------
  // Notify flush, breadcrumb extras, report UI fields

  /**
   * Not covered offline: the delay is a coalesce window before the relay's
   * POST ("still persisted first", Options.NotifyFlushDelay; iOS "int ms"),
   * so the relay file is written at once with or without it (simulator: 177
   * and 141 ms). Only an upload shows it: staging (S-14).
   */
  it.skip('[OPT-022] config.notify-flush-delay: not observable offline -- it delays the relay POST, not the relay file', () => {});

  // Android only: there the app is driven to the background and back; iOS
  // runs undriven differ only by chance (simulator: 2 crumbs with extras, 12
  // without, the control's being http crumbs).
  /** Android 7.3.0 records no SDK breadcrumb at all (sdk-breadcrumbs.test.ts, N-11): nothing to add to. */
  (HERE === 'A' ? it.failing : it.skip)('[OPT-002] capture.breadcrumbs.extras adds SDK breadcrumbs the control does not record [known: Android 7.3.0 records no SDK breadcrumbs (to file)]', async () => {
    // Android is sent to the background and back; iOS is not driven
    // (switching apps loses the run's console) and uploads after 4 s.
    const step = ON_ANDROID ? 'background' : 'run';
    const crumbsOf = async (name: string): Promise<Array<Record<string, unknown>>> => {
      const key = `${name}--${step}`;
      if (!cache.has(key)) {
        cache.set(
          key,
          (async () => {
            await clearBundles();
            const { run } = await launch(name, step);
            if (ON_ANDROID) {
              await apiMarker(log!, `eff ready case=${name}`, run.scenario.nonce, 15_000, run.start);
              await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_HOME');
              await new Promise(resolve => setTimeout(resolve, 3_000));
              await adbStatus('shell', 'am', 'start', '-n', `${ANDROID_PACKAGE}/.MainActivity`);
            }
            await apiMarker(log!, `eff uploaded case=${name}`, run.scenario.nonce, 40_000, run.start);
            const bundles = await awaitBundles(1, 60_000);
            await stopApp();
            return { run, options: run.launched, bundles };
          })(),
        );
      }
      const outcome = await cache.get(key)!;
      return captureEvents(own(outcome, name), 'breadcrumbs');
    };
    const extras = await crumbsOf('crumb-extras');
    const control = await crumbsOf('crumb-extras-control');
    const kinds = (crumbs: Array<Record<string, unknown>>) => [...new Set(crumbs.map(c => `${String(c.type)}/${String(c.category)}`))].sort();
    report('crumb kinds', { extras: kinds(extras), control: kinds(control), counts: { extras: extras.length, control: control.length } });
    expect(extras.length).toBeGreaterThan(control.length);
  });

  on(['A'])('[OPT-045][OPT-047] reporting.ui.labels-enabled and priority-selector-enabled add fields to the dialog', async () => {
    const dialog = async (name: string): Promise<string> => {
      await clearBundles();
      const { run } = await launch(name, 'dialog');
      await apiMarker(log!, `eff dialog case=${name}`, run.scenario.nonce, 15_000, run.start);
      await new Promise(resolve => setTimeout(resolve, 5_000));
      const { xml } = await uiDump();
      await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      await stopApp();
      return xml;
    };
    const fields = await dialog('ui-fields');
    const control = await dialog('ui-fields-control');
    // The dialog's views carry no resource ids: compare what they show.
    const texts = (xml: string) => [...new Set([...xml.matchAll(/ text="([^"]+)"/g)].map(m => m[1]!))].sort();
    const added = texts(fields).filter(text => !texts(control).includes(text));
    report('dialog texts added by the options', { added, control: texts(control) });
    // The labels field and the five severity names (the device's locale).
    expect(added.length).toBeGreaterThanOrEqual(6);
  });

  // -------------------------------------------------------------------------
  // iOS environment, os_log, frame-rate bounds

  on(['S', 'X'])('[OPT-050][OPT-052][OPT-053][OPT-058][OPT-063][OPT-064][OPT-065] the iOS environment options change the report environment', async () => {
    const env = async (name: string) => {
      const outcome = await uploaded(name);
      return { outcome, environment: own(outcome, name).request.environment as Record<string, unknown> };
    };
    const set = await env('env-diff');
    const control = await env('env-diff-control');
    const text = JSON.stringify(set.environment);
    const controlText = JSON.stringify(control.environment);
    const paths = (o: unknown, prefix = ''): string[] =>
      o !== null && typeof o === 'object' && !Array.isArray(o)
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => paths(v, prefix === '' ? k : `${prefix}.${k}`))
        : [prefix];
    const added = paths(set.environment).filter(p => !paths(control.environment).includes(p));
    report('environment paths only with the options', added);
    expect(jsonAfter<Record<string, unknown>>(set.outcome.options.text, 'values')['com.bugsee.option.config.data-encryption']).toBe(1);
    expect(text).toContain('api-e2e-target');
    expect(text).toContain('api-e2e-type');
    expect(controlText).not.toContain('api-e2e-target');
    expect(added.length).toBeGreaterThan(0);
  });

  on(['S', 'X'])('[OPT-054] capture.logs.oslog is accepted and ignored, as beta5 documents: no os_log line reaches the report either way', async () => {
    const lines = async (name: string): Promise<string[]> => {
      const outcome = await uploaded(name, 'oslog');
      return captureEvents(own(outcome, name), 'log')
        .map(e => String(e.message ?? ''))
        .filter(m => m.includes(`api-oslog`) && m.includes(outcome.run.scenario.nonce));
    };
    const oslog = await lines('oslog');
    const control = await lines('oslog-control');
    report('os_log lines', { oslog, control });
    // iOS 7.0.0-beta5 documents the option as "PERMANENTLY DISABLED --
    // accepted and ignored" (BugseeOptions.h; BGSOSLogInterceptor is never
    // started, for battery). Asserted as documented: no os_log line either way.
    expect(oslog).toEqual([]);
    expect(control).toEqual([]);
  });

  on(['S', 'X'])('[OPT-059][OPT-060] capture.video.max-frame-rate caps the frame count (min-frame-rate recorded)', async () => {
    const frames = async (name: string, step = 'run') => {
      const outcome = await uploaded(name, step);
      const video = (own(outcome, name).binaries.get('video') ?? [])[0];
      expect(video).toBeDefined();
      return frameCount(video!);
    };
    const max = await frames('fps-max');
    const moving = await frames('fps-control', 'moving');
    const min = await frames('fps-min');
    const still = await frames('fps-control', 'static');
    report('frames', { max, moving, min, still });
    expect(max).toBeLessThan(0.6 * moving);
    // min-frame-rate is recorded, not asserted: on a still screen the video
    // decodes to the same frame count with and without it (12 and 12 on the
    // XS), and a decoded count cannot tell a floor the encoder collapsed
    // from one never applied. MANUAL / staging for the floor.
    report('min-frame-rate on a still screen', { withFloor: min, without: still });
  });

  // -------------------------------------------------------------------------
  // Android: all sources, FLAG_SECURE, handler timeout

  on(['A'])('[OPT-070] capture.logs.allsources: another process\'s logcat line reaches the report only with the option', async () => {
    const has = async (name: string): Promise<{ other: boolean; tags: string[] }> => {
      const key = `${name}--ready`;
      if (!cache.has(key)) {
        cache.set(
          key,
          (async () => {
            await clearBundles();
            const { run, options } = await launch(name, 'ready');
            await apiMarker(log!, `eff ready case=${name}`, run.scenario.nonce, 15_000, run.start);
            await adbStatus('shell', 'log', '-p', 'w', '-t', 'ApiOther', `api-other ${run.scenario.nonce}`);
            await apiMarker(log!, `eff uploaded case=${name}`, run.scenario.nonce, 30_000, run.start);
            const bundles = await awaitBundles(1, 60_000);
            await stopApp();
            return { run, options, bundles };
          })(),
        );
      }
      const outcome = await cache.get(key)!;
      const lines = captureEvents(own(outcome, name), 'log').filter(e => e.source === 3);
      return { other: lines.some(e => String(e.message ?? '').includes(`api-other ${outcome.run.scenario.nonce}`)), tags: [...new Set(lines.map(e => String(e.tag)))] };
    };
    const all = await has('allsources');
    const control = await has('allsources-control');
    const extra = all.tags.filter(tag => !control.tags.includes(tag));
    report('logcat with all sources', { otherProcessLine: { all: all.other, control: control.other }, tagsOnlyWithAllSources: extra, counts: { all: all.tags.length, control: control.tags.length } });
    // "All possible logging sources (system, radio, etc.)" (Options.java):
    // more logcat buffers, so tags the default sources never carry. (An app
    // reads only its own UID's lines, so another process's line is reported,
    // not required.)
    expect(extra.length).toBeGreaterThan(0);
  });

  on(['A'])('[OPT-071] capture.respect-flag-secure: a FLAG_SECURE window is blacked out by default and recorded when off', async () => {
    const centre = async (name: string): Promise<number> => {
      const outcome = await uploaded(name, 'secure');
      const shot = (own(outcome, name).binaries.get('screenshot') ?? [])[0];
      expect(shot).toBeDefined();
      return regionLuma(shot!, centreRegion(await imageSize(shot!)));
    };
    const respected = await centre('flag-secure');
    const ignored = await centre('flag-secure-off');
    report('screenshot centre luma', { respected, ignored });
    expect(respected).toBeLessThanOrEqual(LUMA_DARK_MAX);
    expect(ignored).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
  });

  on(['A'])('[OPT-080] config.report-handler-callback-timeout lowers the live handler deadline', async () => {
    const deadline = async (name: string): Promise<number> => {
      const outcome = await uploaded(name, 'handler');
      const lines = log!.all(/BugseeRN.*report handler rh-\d+ phase=\w+ deadline=(\d+)/, outcome.run.start);
      expect(lines.length).toBeGreaterThan(0);
      return Number(/deadline=(\d+)/.exec(lines[0]!.text)![1]);
    };
    const lowered = await deadline('handler-timeout');
    const control = await deadline('handler-timeout-control');
    report('handler deadlines ms', { lowered, control });
    // ReportHandlerDeadlines.liveMs: the JS deadline sits a second inside the
    // SDK's own per-callback timeout, and never above 25 s.
    expect(lowered).toBe(4_000);
    expect(control).toBe(25_000);
  });

  /**
   * Out of process, Android assembles the report through JobScheduler. On
   * the WOD_LX1 (7.3.0, 2026-10-07) no report is filed within 90 s, in
   * airplane mode or with the network on (dead endpoint): the option is read
   * back as set, but the upload never becomes a bundle. To file
   * (bugsee-android), pending the SDK team's view of the job's constraints.
   */
  const outOfProcess = async (): Promise<Outcome & { bundles: PulledBundle[] }> => {
    const key = 'out-of-process--run';
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => {
          await clearBundles();
          await airplane(false);
          try {
            const { run, options } = await launch('out-of-process', 'run');
            await apiMarker(log!, 'eff uploaded case=out-of-process', run.scenario.nonce, 40_000, run.start);
            const bundles = await awaitBundles(1, 90_000);
            await stopApp();
            report('out-of-process bundles', bundles.map(b => b.request.summary));
            return { run, options, bundles };
          } finally {
            await airplane(true);
          }
        })(),
      );
    }
    return cache.get(key)!;
  };

  on(['A'])('[OPT-081] config.report-processing-in-process=false reads back as set', async () => {
    const { options } = await outOfProcess();
    expect(jsonAfter(options.text, 'values')).toEqual({ 'com.bugsee.option.config.report-processing-in-process': false });
  });

  (HERE === 'A' ? it.failing : it.skip)('[OPT-081] config.report-processing-in-process=false still files the report (network on, dead endpoint) [known: Android 7.3.0 files no report out of process (to file)]', async () => {
    const { run, bundles } = await outOfProcess();
    expect(bundles.map(b => b.request.summary)).toContain(`api-eff-out-of-process-${run.scenario.nonce}`);
  });

  it.skip('[OPT-098][FLOW-05b] reporting.triggers.broadcast: not covered -- the receiver is not exported and needs a signature permission; no in-app sender exists', () => {});
});
