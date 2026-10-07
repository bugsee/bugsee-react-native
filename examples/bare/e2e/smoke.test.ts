/**
 * The smoke set S1-S8 (beta campaign N-01, plan 1.9): one case per
 * version-sensitive surface, run against examples/bare or any app that runs
 * smoke/scenarios.tsx -- a generated app on another React Native version, an
 * Expo app, a packed-tarball install -- named through device.ts's
 * `E2E_APP_ID`, `E2E_IOS_BUNDLE_ID`, `E2E_IOS_EXECUTABLE` and `E2E_APP_DIR`.
 *
 *   S1 launch -> Launched within 10 s of the JS bundle running; banner = pin
 *      (startRun); environment.sdk.wrapper names this wrapper, its version,
 *      React Native, the JS engine and the build configuration
 *   S2 Bugsee.log + console.log + event + trace land in one retained bundle
 *   S3 logException -> an error bundle with debug_ids on every frame
 *      (A and X: the simulator slice compiles logException out)
 *   S4 upload() files one report with its fields, as the id it was assembled as
 *   S5 a view-tree request is answered by JS within 450 ms with a managed tree
 *   S6 <BugseeSecure> is masked in the report screenshot
 *   S7 a JS fatal -> one crash, recovered at the next launch (A and X)
 *   S8 Release only: the runtime debug id = the composed Hermes map's
 *
 * Environment:
 *   E2E_SMOKE        which cases, e.g. `S1,S3,S8` (default: all that apply)
 *   E2E_JS_ENGINE    `hermes` (default) or `jsc`: what S1 expects
 *   E2E_RELEASE=1    a Release build is installed: S8 runs, the rest expect dev=false
 *   BUGSEE_COMPOSED_MAP  S8's composed map (default, Android: the app's
 *                    android/app/build/generated/sourcemaps/react/release/index.android.bundle.map;
 *                    iOS: required)
 *   E2E_SMOKE_ROOT=1 run examples/bare's smoke root (SmokeApp.tsx) instead of App
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type PulledBundle, captureEvents, crashOf } from './bundles';
import { APP_DIR, iosTarget } from './device';
import {
  ON_IOS,
  type Run,
  TARGET_NAME,
  awaitBundles,
  bridgeLine,
  clearBundles,
  describeDevice,
  must,
  report,
  startRun,
  stopApp,
} from './harness';
import { COLOUR_TOLERANCE, colourOf, colourPixels } from './media';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';
import { SMOKE_OPEN_COLOUR, SMOKE_SECURE_COLOUR, smokeDebugIdFor } from '../smoke/constants';

jest.setTimeout(8 * 60_000);

export const SMOKE_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'] as const;
type SmokeId = (typeof SMOKE_IDS)[number];

/** `E2E_SMOKE`: a comma list of S1..S8; unset means all. Anything else throws. */
export function parseSmokeSelection(raw: string | undefined): Set<SmokeId> {
  if (raw === undefined || raw.trim() === '') {
    return new Set(SMOKE_IDS);
  }
  const picked = raw.split(',').map(part => part.trim().toUpperCase());
  for (const id of picked) {
    if (!(SMOKE_IDS as readonly string[]).includes(id)) {
      throw new Error(`E2E_SMOKE: unknown case ${JSON.stringify(id)}; use S1..S8`);
    }
  }
  return new Set(picked as SmokeId[]);
}

const SELECTED = parseSmokeSelection(process.env.E2E_SMOKE);
const RELEASE = process.env.E2E_RELEASE === '1';
const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';
const ENGINE = process.env.E2E_JS_ENGINE ?? 'hermes';
if (ENGINE !== 'hermes' && ENGINE !== 'jsc') {
  throw new Error(`E2E_JS_ENGINE must be "hermes" or "jsc", got ${JSON.stringify(ENGINE)}`);
}

/** Why a case does not run on this target, or undefined when it does. */
function notHere(id: SmokeId): string | undefined {
  if (!SELECTED.has(id)) {
    return 'not selected (E2E_SMOKE)';
  }
  if ((id === 'S3' || id === 'S7' || id === 'S8') && ON_SIMULATOR) {
    return 'the simulator slice has no exception reporter or crash reporter';
  }
  if (id === 'S8' && !RELEASE) {
    return 'Release only (E2E_RELEASE=1)';
  }
  return undefined;
}

function describeSmoke(id: SmokeId, title: string, body: () => void): void {
  const why = notHere(id);
  if (why !== undefined) {
    describe.skip(`${id} ${title} (skipped: ${why})`, body);
    return;
  }
  describe(`${id} ${title}`, body);
}

function versionOf(packageJson: string): string {
  return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version;
}

/** Resolved from the app under test, so a generated app reports its own versions. */
function packageVersion(name: string): string {
  return versionOf(require.resolve(`${name}/package.json`, { paths: [APP_DIR] }));
}

function bundleBySummary(bundles: readonly PulledBundle[], summary: string): PulledBundle {
  const found = bundles.filter(bundle => bundle.request.summary === summary);
  if (found.length !== 1) {
    throw new Error(
      `expected one bundle with summary ${summary}, found ${found.length} among ${JSON.stringify(bundles.map(b => b.request.summary))}`,
    );
  }
  return found[0]!;
}

interface JsPayload {
  readonly name?: unknown;
  readonly reason?: unknown;
  readonly frames?: ReadonlyArray<{ readonly data?: { readonly source?: unknown }; readonly debug_id?: unknown }>;
  readonly debug_ids?: unknown;
}

/** The JS payload a crash capture carries in `exception.reason`, or undefined. */
function payloadOf(bundle: PulledBundle): JsPayload | undefined {
  const exception = crashOf(bundle)?.exception as { reason?: unknown } | undefined;
  if (typeof exception?.reason !== 'string' || !exception.reason.startsWith('{')) {
    return undefined;
  }
  return JSON.parse(exception.reason) as JsPayload;
}

function withReason(bundles: readonly PulledBundle[], reason: string): PulledBundle[] {
  return bundles.filter(bundle => payloadOf(bundle)?.reason === reason);
}

describeDevice(`the smoke set on ${TARGET_NAME}`, () => {
  let log: DeviceLog;

  beforeAll(async () => {
    log = await beginRetainingSuite('smoke');
  });

  afterAll(() => endRetainingSuite(log));

  /** Clears, then runs `scenario` and waits for `marker` (a regex source; the nonce is appended). */
  async function runTo(scenario: string, marker: string): Promise<Run> {
    await clearBundles();
    const run = await startRun(scenario);
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E smoke ${marker}.*nonce=${run.scenario.nonce}`), 30_000, run.start),
      `the ${scenario} marker "${marker}"`,
      run.start,
    );
    expect(run.dev).toBe(!RELEASE);
    return run;
  }

  describeSmoke('S1', 'launch and wrapper identity', () => {
    let run: Run;
    let ran: LogLine;
    let bundle: PulledBundle;

    beforeAll(async () => {
      run = await runTo('smoke-identity', 'identity uploaded');
      ran = must(
        log.all(new RegExp(`BUGSEE_E2E scenario=smoke-identity nonce=${run.scenario.nonce} `), run.start)[0],
        'the launch line',
        run.start,
      );
      bundle = bundleBySummary(await awaitBundles(1), `smoke-identity-${run.scenario.nonce}`);
    });

    it('S1 reaches Status.Launched within 10 s of the JS bundle running', () => {
      const device = run.launched.deviceMs - ran.deviceMs;
      const host = (run.launched.hostMs ?? NaN) - (ran.hostMs ?? NaN);
      const elapsed = Number.isFinite(device) ? device : host;
      report('S1 launch to Launched (ms)', { device, host, banner: run.banner.text.trim() });
      expect(Number.isFinite(elapsed)).toBe(true);
      expect(elapsed).toBeLessThan(10_000);
    });

    it('S1 names the wrapper, its version, React Native, the JS engine and the build configuration', () => {
      const sdk = (bundle.request.environment as { sdk?: Record<string, unknown> }).sdk;
      report('S1 environment.sdk.wrapper', sdk?.wrapper);
      expect(sdk?.wrapper).toEqual({
        type: 'react_native',
        version: packageVersion('@bugsee/react-native'),
        context: {
          'react-native': packageVersion('react-native'),
          'js-engine': ENGINE,
          'build-configuration': run.dev ? 'debug' : 'release',
        },
      });
    });
  });

  describeSmoke('S2', 'log, console, event and trace in one bundle', () => {
    let nonce: string;
    let bundle: PulledBundle;

    beforeAll(async () => {
      const run = await runTo('smoke-data', 'data sent');
      nonce = run.scenario.nonce;
      bundle = bundleBySummary(await awaitBundles(1), `smoke-data-${nonce}`);
    });

    it('S2 Bugsee.log and console.log land once each as Custom (98) at Info', () => {
      const lines = captureEvents(bundle, 'log');
      for (const message of [`smoke log ${nonce}`, `smoke console ${nonce}`]) {
        const found = lines.filter(line => line.message === message);
        expect({ message, count: found.length }).toEqual({ message, count: 1 });
        expect({ message, source: found[0]!.source, level: found[0]!.level }).toEqual({ message, source: 98, level: 3 });
      }
    });

    it('S2 the event and the trace keep their values', () => {
      const events = captureEvents(bundle, 'events.user').filter(event => event.name === `smoke-event-${nonce}`);
      expect(events).toHaveLength(1);
      expect(events[0]!.params).toStrictEqual({ n: 1, s: `v-${nonce}`, b: true });
      const traces = captureEvents(bundle, 'traces.user').filter(trace => trace.name === `smoke-trace-${nonce}`);
      expect(traces.length).toBeGreaterThan(0);
      expect(traces.map(trace => trace.value)).toEqual(traces.map(() => 7));
    });
  });

  describeSmoke('S3', 'logException with debug ids', () => {
    let nonce: string;
    let payload: JsPayload;
    let bundle: PulledBundle;

    beforeAll(async () => {
      const run = await runTo('smoke-exception', 'exception sent');
      nonce = run.scenario.nonce;
      const mine = withReason(await awaitBundles(1), `smoke handled ${nonce}`);
      expect(mine).toHaveLength(1);
      bundle = mine[0]!;
      payload = payloadOf(bundle)!;
      report('S3 payload', { name: payload.name, debug_ids: payload.debug_ids, frames: payload.frames?.length });
    });

    it('S3 is one error report carrying the JS payload', () => {
      expect(bundle.request.type).toBe('error');
      expect(payload.name).toBe('TypeError');
      expect(String((crashOf(bundle)!.exception as { name?: unknown }).name)).toMatch(/ReactNativeWebException$/);
    });

    it('S3 debug ids travel as a map and on every frame of this bundle', () => {
      const id = smokeDebugIdFor(nonce);
      const source = payload.frames?.[0]?.data?.source;
      expect(typeof source).toBe('string');
      expect(payload.debug_ids).toEqual({ [source as string]: id });
      const ours = (payload.frames ?? []).filter(frame => frame.data?.source === source);
      expect(ours.length).toBeGreaterThan(0);
      expect(ours.map(frame => frame.debug_id)).toEqual(ours.map(() => id));
    });
  });

  describeSmoke('S4', 'upload() files one report with its fields', () => {
    let nonce: string;
    let assembled: string;
    let bundles: PulledBundle[];

    beforeAll(async () => {
      const run = await runTo('smoke-upload', 'upload sent');
      nonce = run.scenario.nonce;
      const line = must(
        await log.waitFor(new RegExp(`BUGSEE_E2E smoke assembled id=(\\S+) nonce=${nonce}`), 30_000, run.start),
        'AfterReportAssembled with its id',
        run.start,
      );
      assembled = /assembled id=(\S+)/.exec(line.text)![1]!;
      bundles = await awaitBundles(1);
    });

    it('S4 the summary, description, severity and labels reach the report', () => {
      const bundle = bundleBySummary(bundles, `smoke-up-${nonce}`);
      expect(bundle.request.description).toBe(`smoke-desc-${nonce}`);
      expect(bundle.request.severity).toBe(3);
      expect(bundle.request.labels).toEqual(expect.arrayContaining(['smoke', `l-${nonce}`]));
    });

    it('S4 the report on disk is the one AfterReportAssembled named', () => {
      expect(bundleBySummary(bundles, `smoke-up-${nonce}`).file).toBe(`${assembled}.bundle.zip`);
    });
  });

  describeSmoke('S5', 'the view-tree request', () => {
    let run: Run;
    let nonce: string;
    let upTo: number;
    let trees: Array<Record<string, unknown>>;

    beforeAll(async () => {
      run = await runTo('smoke-view-tree', 'vh uploaded');
      nonce = run.scenario.nonce;
      const bundle = bundleBySummary(await awaitBundles(1), `smoke-vh-${nonce}`);
      upTo = log.mark();
      trees = captureEvents(bundle, 'viewtree');
    });

    it('S5 every request after Launched is answered by JS within 450 ms', () => {
      const requests = log.all(bridgeLine('data request dr-\\d+ type=vh '), run.launched.index, upTo);
      const completions = log.all(bridgeLine('data request dr-\\d+ completed '), run.launched.index, upTo);
      report('S5 completions', completions.map(line => line.text.replace(/^.*BugseeRN\s*:?\s*/, '')));
      expect(requests.length).toBeGreaterThanOrEqual(1);
      for (const request of requests) {
        const id = /data request (dr-\d+) /.exec(request.text)![1]!;
        const done = completions.filter(line => line.text.includes(`data request ${id} completed `));
        expect({ id, count: done.length }).toEqual({ id, count: 1 });
        const outcome = / by=(\S+) bytes=\S+ ms=(\d+)/.exec(done[0]!.text);
        expect({ id, by: outcome?.[1] }).toEqual({ id, by: 'js' });
        expect(Number(outcome![2])).toBeLessThan(450);
      }
    });

    it('S5 the managed tree is in the report, with the probe and a secure subtree', () => {
      expect(trees.length).toBeGreaterThanOrEqual(1);
      interface Node {
        class_name: string;
        options: { kind: string; secure?: boolean; tag?: string };
        subitems?: Node[];
      }
      const nodes = (root: Node): Node[] => [root, ...(root.subitems ?? []).flatMap(nodes)];
      for (const tree of trees) {
        expect(typeof tree.managed).toBe('string');
        const root = JSON.parse(tree.managed as string) as Node;
        expect({ class_name: root.class_name, kind: root.options.kind }).toEqual({ class_name: 'ReactNative', kind: 'root' });
        const all = nodes(root);
        expect(all.filter(node => node.options.kind === 'host' && node.options.tag === `smoke-vh-open-${nonce}`)).toHaveLength(1);
        const secure = all.filter(node => node.class_name === 'BugseeSecure' && node.options.kind === 'composite');
        expect(secure).toHaveLength(1);
        for (const node of nodes(secure[0]!)) {
          expect({ secure: node.options.secure, tag: node.options.tag }).toEqual({ secure: true, tag: undefined });
        }
      }
    });
  });

  describeSmoke('S6', '<BugseeSecure> in the screenshot', () => {
    let screenshots: string[];

    beforeAll(async () => {
      const run = await runTo('smoke-secure', 'secure uploaded');
      const bundle = bundleBySummary(await awaitBundles(1), `smoke-secure-${run.scenario.nonce}`);
      screenshots = bundle.binaries.get('screenshot') ?? [];
    });

    it('S6 the open box is in the screenshot and the secure box is not', async () => {
      expect(screenshots.length).toBeGreaterThan(0);
      for (const file of screenshots) {
        const open = await colourPixels(file, colourOf(SMOKE_OPEN_COLOUR), COLOUR_TOLERANCE);
        const secure = await colourPixels(file, colourOf(SMOKE_SECURE_COLOUR), COLOUR_TOLERANCE);
        report('S6 pixels', { file, open: open.count, secure: secure.count, size: [open.width, open.height] });
        // The control: the screenshot does show the stage.
        expect(open.count).toBeGreaterThanOrEqual(100);
        expect(secure.count).toBe(0);
      }
    });
  });

  describeSmoke('S7', 'a JS fatal, recovered at the next launch', () => {
    let nonce: string;
    let crashes: PulledBundle[];

    beforeAll(async () => {
      const run = await runTo('smoke-fatal', 'fatal throwing');
      nonce = run.scenario.nonce;
      must(
        await log.waitFor(bridgeLine('exception unhandled completed'), 30_000, run.launched.index),
        'the JS fatal stored (exception unhandled completed)',
        run.start,
      );
      await stopApp();
      // The next launch files what the last one stored (iOS), or finds it
      // already filed (Android).
      await startRun('smoke-relaunch');
      await awaitBundles(1, 60_000);
      // Android 7.3.0 also files an error for the same incident (R10): a beat for it.
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const all = await awaitBundles(1, 1_000);
      report('S7 bundles', all.map(b => ({ file: b.file, type: b.request.type, reason: payloadOf(b)?.reason })));
      crashes = withReason(all, `smoke fatal ${nonce}`).filter(bundle => bundle.request.type === 'crash');
    });

    it('S7 is one unhandled crash named ReactNativeWebException', () => {
      expect(crashes).toHaveLength(1);
      const crash = crashOf(crashes[0]!)!;
      expect(String((crash.exception as { name?: unknown }).name)).toMatch(/ReactNativeWebException$/);
      expect(crash.handled).toBe(false);
    });
  });

  describeSmoke('S8', 'the composed debug id (Release)', () => {
    let mapId: string;
    let payload: JsPayload;

    beforeAll(async () => {
      const override = process.env.BUGSEE_COMPOSED_MAP;
      const mapPath =
        override !== undefined && override !== ''
          ? override
          : ON_IOS
            ? undefined
            : join(APP_DIR, 'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map');
      if (mapPath === undefined || !existsSync(mapPath)) {
        throw new Error(`S8 needs the composed map: set BUGSEE_COMPOSED_MAP (looked for ${String(mapPath)})`);
      }
      const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { debug_id?: unknown; debugId?: unknown };
      expect(typeof map.debug_id).toBe('string');
      expect(map.debugId).toBe(map.debug_id);
      mapId = map.debug_id as string;
      const run = await runTo('smoke-map-id', 'map-id sent');
      const mine = withReason(await awaitBundles(1), `smoke map-id ${run.scenario.nonce}`);
      expect(mine).toHaveLength(1);
      payload = payloadOf(mine[0]!)!;
      report('S8 ids', { map: mapId, runtime: payload.debug_ids });
    });

    it('S8 the release bundle reports the composed map debug id', () => {
      const values = Object.values((payload.debug_ids ?? {}) as Record<string, unknown>);
      expect(values.length).toBeGreaterThan(0);
      expect(values).toEqual(values.map(() => mapId));
      const stamped = (payload.frames ?? []).filter(frame => frame.debug_id !== undefined);
      expect(stamped.map(frame => frame.debug_id)).toEqual(stamped.map(() => mapId));
    });
  });
});
