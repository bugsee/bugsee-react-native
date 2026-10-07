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
import { type PulledBundle, captureEvents, crashOf, relayTexts } from './bundles';
import { apiMarker, jsonAfter } from './api-markers';
import { ANDROID_PACKAGE, iosTarget } from './device';
import {
  ON_ANDROID,
  ON_IOS,
  RELEASE,
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

  on(['A', 'X'])('[OPT-025] detect.crash=false: neither a JS fatal nor a native crash is reported', async () => {
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
    const named = (text: string) => (text.match(/"(symbol|symbol_name|method|function)":"[^"]+"/g) ?? []).length;
    report('named frames', { symbolicated: named(symbolicated), control: named(control) });
    expect(named(symbolicated)).toBeGreaterThan(named(control));
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

  on(['X'])('[OPT-068] detect.kill: a SIGKILL is reported at the next launch', async () => {
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

  on(['A', 'S', 'X'])('[OPT-029][OPT-030][FLOW-44] detect.hang: a 6 s main-thread block is reported; with hang detection off it is not', async () => {
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

  on(['A', 'S', 'X'])('[OPT-033][FLOW-45] detect.http-errors: a 500 response is reported; without the option it is not', async () => {
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

  on(['A', 'S', 'X'])('[OPT-007] capture.network.body-without-type: a response body with no Content-Type is kept only with the option', async () => {
    const bodyOf = async (name: string): Promise<string> => {
      const outcome = await uploaded(name, 'bytes', true);
      const events = networkOf(own(outcome, name)).filter(e => String(e.url ?? '').includes(`api-bytes-${outcome.run.scenario.nonce}`));
      report(`${name} events`, events.map(e => JSON.stringify(e).slice(0, 400)));
      expect(events.length).toBeGreaterThan(0);
      return JSON.stringify(events);
    };
    const kept = await bodyOf('body-no-type');
    const control = await bodyOf('body-no-type-control');
    // The stub's /bytes/64 body is 64 x "x", with no Content-Type.
    expect(kept).toContain('x'.repeat(32));
    expect(control).not.toContain('x'.repeat(32));
  });

  on(['A', 'S', 'X'])('[OPT-009] capture.network.on-launch: a request in flight before Launched is captured only with the option', async () => {
    const has = async (name: string): Promise<boolean> => {
      const outcome = await uploaded(name);
      return networkOf(own(outcome, name)).some(e => String(e.url ?? '').includes(`api-onlaunch/${outcome.run.scenario.nonce}`));
    };
    const onLaunch = await has('net-on-launch');
    const control = await has('net-on-launch-control');
    report('on-launch captured', { onLaunch, control });
    expect(onLaunch).toBe(true);
    expect(control).toBe(false);
  });

  on(RELEASE ? [] : ['S', 'X'])('[OPT-062] capture.websocket=false: the Metro websocket is absent from the capture; the control has it', async () => {
    const sockets = async (name: string): Promise<string[]> => {
      const outcome = await uploaded(name);
      return networkOf(own(outcome, name)).map(e => String(e.url ?? '')).filter(url => /^wss?:/.test(url));
    };
    const off = await sockets('websocket-off');
    const control = await sockets('websocket-control');
    report('websocket urls', { off, control });
    expect(control.length).toBeGreaterThan(0);
    expect(off).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Notify flush, breadcrumb extras, report UI fields

  on(['A', 'S', 'X'])('[OPT-022] config.notify-flush-delay holds a notification back from the relay', async () => {
    const delayOf = async (name: string): Promise<number> => {
      await clearBundles();
      const { run } = await launch(name, 'notify');
      await apiMarker(log!, `eff notified case=${name}`, run.scenario.nonce, 15_000, run.start);
      const sent = Date.now();
      let seen = -1;
      while (Date.now() - sent < 40_000) {
        if ((await relayTexts(ON_IOS)).some(t => t.includes(`api-flush-${run.scenario.nonce}`))) {
          seen = Date.now() - sent;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await stopApp();
      return seen;
    };
    const delayed = await delayOf('notify-flush');
    const control = await delayOf('notify-flush-control');
    report('relay delay ms', { delayed, control });
    expect(control).toBeGreaterThanOrEqual(0);
    expect(delayed).toBeGreaterThanOrEqual(control + 5_000);
  });

  on(['A', 'S'])('[OPT-002] capture.breadcrumbs.extras adds SDK breadcrumbs the control does not record', async () => {
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
    const ids = (xml: string) => [...new Set([...xml.matchAll(/resource-id="([^"]+)"/g)].map(m => m[1]!))].sort();
    const added = ids(fields).filter(id => !ids(control).includes(id));
    report('dialog resource ids added by the options', added);
    expect(added.some(id => /label/i.test(id))).toBe(true);
    expect(added.some(id => /priority|severity/i.test(id))).toBe(true);
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

  on(['S', 'X'])('[OPT-054] capture.logs.oslog: os_log lines reach the report only with the option', async () => {
    const lines = async (name: string): Promise<string[]> => {
      const outcome = await uploaded(name, 'oslog');
      return captureEvents(own(outcome, name), 'log')
        .map(e => String(e.message ?? ''))
        .filter(m => m.includes(`api-oslog`) && m.includes(outcome.run.scenario.nonce));
    };
    const oslog = await lines('oslog');
    const control = await lines('oslog-control');
    report('os_log lines', { oslog, control });
    expect(oslog.length).toBeGreaterThan(0);
    expect(control).toEqual([]);
  });

  on(['S', 'X'])('[OPT-059][OPT-060] capture.video.max-frame-rate and min-frame-rate bound the frame count', async () => {
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
    expect(min).toBeGreaterThan(still);
  });

  // -------------------------------------------------------------------------
  // Android: all sources, FLAG_SECURE, handler timeout

  on(['A'])('[OPT-070] capture.logs.allsources: another process\'s logcat line reaches the report only with the option', async () => {
    const has = async (name: string): Promise<boolean> => {
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
      return captureEvents(own(outcome, name), 'log').some(e => String(e.message ?? '').includes(`api-other ${outcome.run.scenario.nonce}`));
    };
    const all = await has('allsources');
    const control = await has('allsources-control');
    report('other-process line captured', { all, control });
    expect(all).toBe(true);
    expect(control).toBe(false);
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
    expect(lowered).toBe(5_000);
    expect(control).toBe(25_000);
  });

  it.skip('[OPT-098][FLOW-05b] reporting.triggers.broadcast: not covered -- the receiver is not exported and needs a signature permission; no in-app sender exists', () => {});
});
