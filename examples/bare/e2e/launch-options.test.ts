/**
 * API-42, API-43, API-44 (and FLOW-19): launch options proven by what they
 * change in a report, not by a read-back alone.
 *
 * Each case launches scenario `opt-<case>` (scenarios/coverage.ts), which
 * sets the case's options through `setCustomOption`, then does the same
 * fixed work every case does -- console.log/warn/error, Bugsee.log at levels
 * 1-5, a breadcrumb, a transaction, a fetch, four seconds of screen -- and
 * uploads one report with no severity. `control` sets nothing: every "off"
 * or "scaled" case is read against it, from the same suite run.
 *
 * Two things are asserted per case:
 *   1. read-back: `getLaunchOptions()` reports each value as set. For an enum
 *      key on Android this is the bridge's outbound table (`wireValue`), the
 *      inbound one being proven by the effect.
 *   2. effect: the report differs from control the way the option says.
 *
 * The Android enum keys (BugseeOptionEnums.java) are each launched with a
 * value whose ORDINAL names a different, valid constant (or none), so an
 * ordinal lookup would fail the effect: LogLevel.Error 1 (ordinal 0;
 * values()[1] is Warning), FrameRate.Low 1 / High 3, VideoQuality.High 2,
 * IssueSeverity.Critical 4 (values()[4] is Blocker) / VeryLow 1 / Medium 2
 * (js-crash.test.ts), VideoMode.None 0 and DirectBuffers 21 (no ordinal 21).
 *
 * Android 7.3.0 writes the options in effect into every report,
 * `environment.sdk.options`, keys with `:` for `.` -- and writes an enum
 * option as its constant's ORDINAL (IssueSeverity.Critical, value 4, is
 * written 3). That record is the only device-visible witness for the frame
 * rate (frames depend on what the screen does), so `androidRecorded` reads
 * it with that rule stated.
 *
 * Options with no effect a device can observe without a human, a backend or
 * hardware are listed in the beta-coverage report, not here.
 */
import { type PulledBundle, captureEvents } from './bundles';
import { iosTarget } from './device';
import { ON_ANDROID, ON_IOS, type Run, TARGET_NAME, awaitBundles, clearBundles, describeDevice, must, report, startRun, stopApp } from './harness';
import { imageSize, probeCodec } from './media';
import { beginRetainingSuite, endRetainingSuite, frameCount, sharpness } from './observe';
import { type DeviceLog } from './scenario';

/** scenarios/coverage.ts POST_BODY, written out again. */
const POST_BODY = 'cov-body-'.padEnd(64, 'x');

jest.setTimeout(10 * 60_000);

type PlatformName = 'android' | 'ios';
const PLATFORM: PlatformName = ON_IOS ? 'ios' : 'android';
const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';

interface Outcome {
  readonly run: Run;
  /** Every bundle the run retained. */
  readonly bundles: readonly PulledBundle[];
  /** The case's own upload (`opt-<case>-<nonce>`), when it made exactly one. */
  readonly bundle: PulledBundle | undefined;
  /** `getLaunchOptions()` for the case's keys, as the app logged it. */
  readonly effective: Record<string, unknown>;
}

interface Case {
  readonly name: string;
  readonly platforms: readonly PlatformName[];
  /** The options scenarios/coverage.ts sets for it, written out again here. */
  readonly set: Readonly<Record<string, unknown>>;
  /** Uploads the case makes. */
  readonly uploads?: number;
  readonly effect?: (outcome: Outcome, control: Outcome) => Promise<void> | void;
  /** Why the read-back is pinned failing on a platform (a product bug). */
  readonly readbackFails?: Partial<Record<PlatformName, string>>;
  /** Why the effect is pinned failing on a platform (a product bug). */
  readonly effectFails?: Partial<Record<PlatformName, string>>;
  /** Why the effect cannot be observed on the iOS simulator. */
  readonly simulatorSkip?: string;
}

function types(bundle: PulledBundle): string[] {
  return bundle.manifest.files.map(file => file.type);
}

function the(outcome: Outcome): PulledBundle {
  if (outcome.bundle === undefined) {
    throw new Error(
      `no single bundle for ${outcome.run.scenario.scenario}; retained: ${JSON.stringify(
        outcome.bundles.map(b => b.request.summary),
      )}`,
    );
  }
  return outcome.bundle;
}

function file(bundle: PulledBundle, type: string): string {
  const files = bundle.binaries.get(type) ?? [];
  if (files.length !== 1) {
    throw new Error(`${bundle.file} has ${files.length} ${type} file(s): ${JSON.stringify(bundle.manifest.files)}`);
  }
  return files[0]!;
}

/** The log lines of this run (they carry its nonce). */
function ownLines(outcome: Outcome): Array<Record<string, unknown>> {
  const nonce = outcome.run.scenario.nonce;
  return captureEvents(the(outcome), 'log').filter(event => String(event.message ?? '').includes(nonce));
}

function hasLine(outcome: Outcome, text: string): boolean {
  return ownLines(outcome).some(event => event.message === `${text} ${outcome.run.scenario.nonce}`);
}

/**
 * An option as Android 7.3.0 recorded it in the report: dots become colons,
 * and an enum is written as its constant's ordinal (see the top of the file).
 */
function androidRecorded(bundle: PulledBundle, key: string): unknown {
  const sdk = (bundle.request.environment as { sdk?: { options?: Record<string, unknown> } }).sdk;
  return sdk?.options?.[key.replace(/\./g, ':')];
}

const CASES: readonly Case[] = [
  {
    name: 'control',
    platforms: ['android', 'ios'],
    set: {},
    // FLOW-19 too: an ordinary report carries a decodable video and a
    // screenshot, and every capture the "off" cases remove.
    effect: async control => {
      const { run } = control;
      const bundle = the(control);
      expect(types(bundle)).toEqual(expect.arrayContaining(['video', 'screenshot', 'log', 'viewtree', 'performance']));
      expect(await probeCodec(file(bundle, 'video'))).toBe('h264');
      expect(await frameCount(file(bundle, 'video'))).toBeGreaterThan(1);
      expect(hasLine(control, 'cov-console info')).toBe(true);
      expect(hasLine(control, 'cov-log L5')).toBe(true);
      expect(bundle.captures.get('performance')).toContain(`cov-txn-${run.scenario.nonce}`);
      expect(bundle.captures.get('breadcrumbs') ?? '').not.toContain('cov-crumb');
      expect(networkUrls(bundle)).toContain(fetchUrl(control));
    },
  },
  {
    name: 'video-off',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.video': false },
    effect: outcome => {
      expect(types(the(outcome))).not.toContain('video');
    },
    effectFails: {
      ios: 'iOS 7.0.0-beta3 and beta4 record capture.video=false (and turns the screenshot off) but still writes a real video into the report',
    },
  },
  {
    name: 'screenshot-off',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.screenshot': false },
    effect: outcome => {
      expect(types(the(outcome))).not.toContain('screenshot');
      expect(types(the(outcome))).toContain('video');
    },
  },
  {
    name: 'logs-off',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.logs': false },
    // The wrapper's console capture reads this option: no console line may
    // reach the report. (Explicit Bugsee.log lines: Android drops the whole
    // log, iOS still records them -- reported, not asserted.)
    effect: outcome => {
      report('logs-off own lines', outcome.bundle === undefined ? [] : ownLines(outcome));
      expect(hasConsoleLine(outcome)).toBe(false);
    },
  },
  {
    name: 'network-off',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.network': false },
    effect: outcome => {
      expect(types(the(outcome)).includes('network') ? networkUrls(the(outcome)) : []).not.toContain(fetchUrl(outcome));
    },
  },
  {
    name: 'vh-off',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.view-hierarchy': false },
    effect: outcome => {
      expect(types(the(outcome))).not.toContain('viewtree');
    },
  },
  {
    name: 'perf-off',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.performance.enabled': false },
    effect: outcome => {
      expect(the(outcome).captures.get('performance') ?? '').not.toContain('cov-txn');
    },
  },
  {
    name: 'crumbs-on',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.breadcrumbs': true },
    effect: outcome => {
      expect(the(outcome).captures.get('breadcrumbs')).toContain(`cov-crumb ${outcome.run.scenario.nonce}`);
    },
  },
  {
    name: 'log-level-error',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.logs.level': 1 },
    // Android filters the platform's own log (logcat, source 3) by level and
    // leaves the wrapper's Custom (98) lines alone; iOS filters the Custom
    // lines. Each is read against control's levels.
    effect: (outcome, control) => {
      if (ON_ANDROID) {
        const levels = (o: Outcome) =>
          captureEvents(the(o), 'log').filter(e => e.source === 3).map(e => Number(e.level));
        report('logcat levels', { set: [...new Set(levels(outcome))], control: [...new Set(levels(control))] });
        expect(levels(control).some(level => level > 1)).toBe(true);
        expect(levels(outcome).length).toBeGreaterThan(0);
        expect(levels(outcome).every(level => level <= 1)).toBe(true);
      } else {
        const own = ownLines(outcome).map(e => `${String(e.message)}@${String(e.level)}`);
        report('own lines', own);
        expect(hasLine(control, 'cov-log L5')).toBe(true);
        expect(hasLine(outcome, 'cov-log L1')).toBe(true);
        expect(hasLine(outcome, 'cov-log L2')).toBe(false);
        expect(hasLine(outcome, 'cov-console warn')).toBe(false);
        expect(ownLines(outcome).every(e => Number(e.level) <= 1)).toBe(true);
      }
    },
  },
  {
    name: 'frame-rate-low',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.video.frame-rate': 1 },
    effect: async (outcome, control) => {
      if (ON_ANDROID) {
        // FrameRate.Low is ordinal 0; values()[1] would be Medium (1).
        expect(androidRecorded(the(outcome), 'com.bugsee.option.capture.video.frame-rate')).toBe(0);
      } else {
        const low = await frameCount(file(the(outcome), 'video'));
        const normal = await frameCount(file(the(control), 'video'));
        report('frames', { low, control: normal });
        expect(low).toBeLessThan(0.6 * normal);
      }
    },
  },
  {
    name: 'frame-rate-high',
    platforms: ['android'],
    set: { 'com.bugsee.option.capture.video.frame-rate': 3 },
    // FrameRate.High is ordinal 2; values()[3] would be Raw (3).
    effect: outcome => {
      expect(androidRecorded(the(outcome), 'com.bugsee.option.capture.video.frame-rate')).toBe(2);
    },
  },
  {
    name: 'quality-high',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.video.quality': 2 },
    effect: async (outcome, control) => {
      const high = await imageSize(file(the(outcome), 'video'));
      const normal = await imageSize(file(the(control), 'video'));
      report('video size', { high, control: normal });
      expect(high.width).toBeGreaterThan(normal.width);
      expect(high.height).toBeGreaterThan(normal.height);
    },
  },
  {
    name: 'bug-priority',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.reporting.defaults.bug-priority': 4 },
    // upload() with no severity takes the default bug priority.
    effect: (outcome, control) => {
      expect(the(control).request.severity).not.toBe(4);
      expect(the(outcome).request.severity).toBe(4);
    },
  },
  {
    name: 'error-priority',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.reporting.defaults.error-priority': 1 },
    // The case also calls logException: the error report takes the default.
    effect: outcome => {
      const errors = outcome.bundles.filter(b => b.request.type === 'error');
      report('error reports', errors.map(b => ({ severity: b.request.severity, file: b.file })));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.request.severity).toBe(1);
    },
    simulatorSkip: 'the simulator slice of the iOS SDK compiles logException out',
  },
  {
    name: 'screenshot-scale',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.screenshot.scale': 0.25 },
    // A privacy scale: down and back up, same pixel size, blurred.
    effect: async (outcome, control) => {
      const scaled = await sharpness(file(the(outcome), 'screenshot'));
      const normal = await sharpness(file(the(control), 'screenshot'));
      report('screenshot sharpness', { scaled, control: normal });
      expect(scaled).toBeLessThan(0.7 * normal);
    },
  },
  {
    name: 'video-scale',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.video.scale': 0.25 },
    effect: async (outcome, control) => {
      const scaled = await sharpness(file(the(outcome), 'video'));
      const normal = await sharpness(file(the(control), 'video'));
      report('video sharpness', { scaled, control: normal });
      expect(scaled).toBeLessThan(0.7 * normal);
      // The screenshot is a separate option and stays sharp.
      expect(await sharpness(file(the(outcome), 'screenshot'))).toBeGreaterThan(
        0.7 * (await sharpness(file(the(control), 'screenshot'))),
      );
    },
  },
  {
    name: 'video-mode-none',
    platforms: ['android'],
    set: { 'com.bugsee.option.capture.video.mode': 0 },
    effect: outcome => {
      expect(types(the(outcome))).not.toContain('video');
      expect(types(the(outcome))).toContain('screenshot');
    },
  },
  {
    name: 'video-mode-direct',
    platforms: ['android'],
    set: { 'com.bugsee.option.capture.video.mode': 21 },
    // DirectBuffers is ordinal 4; an ordinal lookup has nothing at 21 and
    // would leave the default, V2 (ordinal 2).
    effect: async outcome => {
      expect(androidRecorded(the(outcome), 'com.bugsee.option.capture.video.mode')).toBe(4);
      expect(await probeCodec(file(the(outcome), 'video'))).toBe('h264');
    },
  },
  {
    name: 'max-pending-reports',
    platforms: ['android'],
    set: { 'com.bugsee.option.config.max-pending-reports': 1 },
    uploads: 3,
    // Three uploads, offline: only the newest may be kept.
    effect: outcome => {
      const summaries = outcome.bundles.map(b => b.request.summary);
      report('retained', summaries);
      expect(summaries).toEqual([`opt-max-pending-reports-${outcome.run.scenario.nonce}-3`]);
    },
  },
  {
    name: 'custom-option',
    platforms: ['android', 'ios'],
    set: { 'com.bugsee.option.capture.network.body-size-limit': 7 },
    // A key no accessor surfaces, through setCustomOption: network bodies
    // are cut at 7 bytes, so the capture shrinks against control.
    effect: (outcome, control) => {
      const bodies = (o: Outcome) =>
        captureEvents(the(o), 'network')
          .filter(event => event.url === `https://127.0.0.1:9/cov-post/${o.run.scenario.nonce}`)
          .map(event => (event.custom as { body?: unknown } | undefined)?.body ?? event.body)
          .filter((body): body is string => typeof body === 'string');
      report('cov-post bodies', { limited: bodies(outcome), control: bodies(control) });
      // Control keeps the whole 64-byte body (scenarios/coverage.ts POST_BODY).
      expect(bodies(control)).toContain(POST_BODY);
      expect(networkUrls(the(outcome))).toContain(`https://127.0.0.1:9/cov-post/${outcome.run.scenario.nonce}`);
      expect(bodies(outcome).every(body => body.length <= 7)).toBe(true);
    },
    readbackFails: {
      ios: 'iOS 7.0.0-beta3 and beta4 drop com.bugsee.option.capture.network.body-size-limit: getLaunchOptions() reports 20480 and the report environment does not list it',
    },
    effectFails: { ios: 'as the read-back: the SDK never applies the limit (the POST body is kept whole)' },
  },
];

const outcomes = new Map<string, Outcome>();

/** The URLs in the report's network capture. */
function networkUrls(bundle: PulledBundle): string[] {
  return captureEvents(bundle, 'network').map(event => String(event.url ?? ''));
}

const fetchUrl = (outcome: Outcome) => `https://127.0.0.1:9/cov-fetch/${outcome.run.scenario.nonce}`;

function hasConsoleLine(outcome: Outcome): boolean {
  if (outcome.bundle === undefined || !types(outcome.bundle).includes('log')) {
    return false;
  }
  return ['cov-console info', 'cov-console warn', 'cov-console error'].some(text => hasLine(outcome, text));
}

describeDevice(`launch options and their effects on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-options');
  });

  afterAll(() => endRetainingSuite(log));

  async function runCase(item: Case): Promise<Outcome> {
    const cached = outcomes.get(item.name);
    if (cached !== undefined) {
      return cached;
    }
    await clearBundles();
    const run = await startRun(`opt-${item.name}`);
    const nonce = run.scenario.nonce;
    const effectiveLine = must(
      await log!.waitFor(new RegExp(`BUGSEE_E2E cov opt effective case=${item.name} nonce=${nonce} .*values=(\\{.*\\})`), 45_000, run.start),
      `the effective options of ${item.name}`,
      run.start,
    );
    must(
      await log!.waitFor(new RegExp(`BUGSEE_E2E cov opt uploaded case=${item.name} nonce=${nonce}`), 30_000, run.start),
      `${item.name} uploading`,
      run.start,
    );
    const effective = JSON.parse(/values=(\{.*\})/.exec(effectiveLine.text)![1]!) as Record<string, unknown>;
    // Every upload, plus the error report error-priority files.
    const expected = (item.uploads ?? 1) + (item.name === 'error-priority' && !ON_SIMULATOR ? 1 : 0);
    const minimum = item.name === 'max-pending-reports' ? 1 : expected;
    let bundles = await awaitBundles(minimum, 60_000);
    if (item.name === 'max-pending-reports') {
      // Give the evictions time to happen before reading what is left.
      await new Promise(resolve => setTimeout(resolve, 8_000));
      bundles = await awaitBundles(1, 1_000);
    }
    await stopApp();
    const own = bundles.filter(b => b.request.summary === `opt-${item.name}-${nonce}`);
    const outcome: Outcome = { run, bundles, bundle: own.length === 1 ? own[0] : undefined, effective };
    report(`${item.name} bundles`, bundles.map(b => ({ summary: b.request.summary, type: b.request.type, files: types(b) })));
    report(`${item.name} effective`, effective);
    outcomes.set(item.name, outcome);
    return outcome;
  }

  for (const item of CASES) {
    const here = item.platforms.includes(PLATFORM);
    const label = `${item.name} ${JSON.stringify(item.set)}`;
    if (!here) {
      it.skip(`${label}: ${item.platforms.join('/')} only`, () => {});
      continue;
    }
    if (item.name !== 'control') {
      const readback = item.readbackFails?.[PLATFORM] !== undefined ? it.failing : it;
      readback(`${label}: getLaunchOptions() reports it as set${item.readbackFails?.[PLATFORM] ? ` [known: ${item.readbackFails[PLATFORM]}]` : ''}`, async () => {
        const outcome = await runCase(item);
        expect(outcome.effective).toEqual(item.set);
      });
    }
    if (item.effect === undefined) {
      continue;
    }
    if (ON_SIMULATOR && item.simulatorSkip !== undefined) {
      it.skip(`${label}: changes the report (${item.simulatorSkip})`, () => {});
      continue;
    }
    const effect = item.effectFails?.[PLATFORM] !== undefined ? it.failing : it;
    effect(`${label}: changes the report${item.effectFails?.[PLATFORM] ? ` [known: ${item.effectFails[PLATFORM]}]` : ''}`, async () => {
      const control = await runCase(CASES[0]!);
      const outcome = await runCase(item);
      await item.effect!(outcome, control);
    });
  }
});
