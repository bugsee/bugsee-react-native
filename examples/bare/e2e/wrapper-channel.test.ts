/**
 * Task 3.5b: the wrapper channel on Android hardware.
 *
 * Task 3.5a built the channel seam and unit-tested it against fakes: what
 * only a device can show is that a line sent through it after `Launched`
 * really reaches the bundle the SDK writes, attributed as source `Custom`
 * (98), and that a line sent before `launch()` is really dropped rather than
 * merely untested.
 *
 * Preconditions, as for report-handler.test.ts: the app is installed on the
 * handset named in device.ts, and for a debug build Metro is running with
 * `adb reverse tcp:8081 tcp:8081`. This runs on the same debug build 3.4d's
 * retained-bundle cases used.
 *
 * Markers, from scenarios/channel.ts (console.log, tag ReactNativeJS):
 *   BUGSEE_E2E channel pre-sent nonce=<n>   forwardLog('pre-<n>') ran, before launch()
 *   BUGSEE_E2E channel sent nonce=<n>       forwardLog('BUGSEE_E2E channel <n>') ran, after Launched
 */
import { checkAndroidBanner } from '../../../scripts/sdk-banner';
import { readNativeVersions } from '../../../scripts/native-versions';
import {
  type PulledBundle,
  airplane,
  clearAndroidBundles,
  listAndroidBundles,
  pullAndroidBundles,
} from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
  type LogLine,
  Logcat,
  type Scenario,
  adb,
  launchScenario,
  resetScenario,
  writeScenario,
} from './scenario';

const ON_ANDROID = process.env.E2E_PLATFORM === 'android';
const describeAndroid = ON_ANDROID ? describe : describe.skip;

jest.setTimeout(5 * 60_000);

let log: Logcat;

/** Fails with the captured log, so a miss can be read rather than guessed. */
function must(line: LogLine | undefined, what: string, from = 0): LogLine {
  if (line === undefined) {
    throw new Error(`never saw ${what}.\nLog since the run started:\n${log.tail(from)}`);
  }
  return line;
}

interface Run {
  readonly scenario: Scenario;
  /** Log index the run started at. */
  readonly start: number;
  readonly banner: LogLine;
  readonly launched: LogLine;
}

/**
 * Starts the app on `name` and asserts the per-run preconditions: the app
 * really ran this scenario (the nonce round-trips), the SDK build is the
 * pinned one, and the SDK reached Launched with the device offline.
 */
async function startRun(name: string): Promise<Run> {
  const scenario = writeScenario(name);
  const start = log.mark();
  await launchScenario(scenario);

  const ran = must(
    await log.waitFor(
      new RegExp(`BUGSEE_E2E scenario=${name} nonce=${scenario.nonce} `),
      120_000,
      start,
    ),
    `the app starting scenario ${name} (nonce ${scenario.nonce})`,
    start,
  );
  const banner = must(
    await log.waitFor(/Bugsee Android SDK \S+ \[[0-9a-f]+\]/, 15_000, start),
    'the SDK build banner',
    start,
  );
  const bannerCheck = checkAndroidBanner(banner.text, readNativeVersions());
  if (!bannerCheck.ok) {
    throw new Error(`SDK build banner does not match the pin: ${bannerCheck.reason}`);
  }
  const launched = must(
    await log.waitFor(/BUGSEE_E2E status=2/, 20_000, ran.index),
    'Status.Launched with the device offline',
    start,
  );
  return { scenario, start, banner, launched };
}

/** The retained bundles, once at least `count` exist (or the wait runs out). */
async function awaitBundles(count: number, timeoutMs = 60_000): Promise<PulledBundle[]> {
  const deadline = Date.now() + timeoutMs;
  while ((await listAndroidBundles()).length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return pullAndroidBundles();
}

/** Evidence the report is committed, surfaced for the commit body. */
function report(label: string, value: unknown): void {
  console.log(`[3.5b] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

interface LogDocument {
  readonly version: number;
  readonly events: ReadonlyArray<Record<string, unknown>>;
}

/** The bundle's `type: "log"` file, parsed -- fails loudly if there is none. */
function logEventsOf(bundle: PulledBundle): ReadonlyArray<Record<string, unknown>> {
  if (bundle.log === undefined) {
    throw new Error(
      `bundle ${bundle.file} has no type:"log" file in its manifest; ` +
        `manifest files: ${JSON.stringify(bundle.manifest.files)}`,
    );
  }
  return (JSON.parse(bundle.log) as LogDocument).events;
}

function messageOf(event: Record<string, unknown>): string {
  return typeof event.message === 'string' ? event.message : '';
}

describeAndroid('wrapper channel on an Android handset', () => {
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];
  /** The pre-launch probe's own marker -- the negative case's precondition. */
  let preSent: LogLine | undefined;
  /** Where App.tsx logs having started launch() -- the ordering witness. */
  let launching: LogLine | undefined;

  beforeAll(async () => {
    log = await Logcat.start();
    // 9.3.2: offline before the app starts, so the report is retained where
    // the test can read it rather than uploaded and gone.
    await airplane(true);
    await clearAndroidBundles();

    run = await startRun('channel');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    preSent = log.all(
      new RegExp(`BUGSEE_E2E channel pre-sent nonce=${nonce}`),
      run.start,
    )[0];
    launching = log.all(/BUGSEE_E2E launching on/, run.start)[0];

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E channel sent nonce=${nonce}`),
        15_000,
        run.launched.index,
      ),
      'the post-launch channel line being sent',
      run.start,
    );

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    if (bundles.length === 1) {
      report('log event JSON', logEventsOf(bundles[0]!));
    }
  });

  afterAll(async () => {
    // Always, and in this order: stop the app, drop what it retained, then
    // bring the network back -- the handset is shared.
    try {
      await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      await clearAndroidBundles().catch(() => {});
    } finally {
      await airplane(false);
      resetScenario();
      if (log !== undefined) {
        log.stop();
      }
    }
  });

  it('a channel line lands in the bundle as Custom', () => {
    expect(bundles).toHaveLength(1);
    const [bundle] = bundles as [PulledBundle];
    const events = logEventsOf(bundle);
    const matches = events.filter(event => messageOf(event).includes(`channel ${nonce}`));
    report('case A matching events', matches);
    expect(matches).toHaveLength(1);
    const [event] = matches as [Record<string, unknown>];
    expect(event.source).toBe(98);
    expect(event.level).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(event, 'tag')).toBe(false);
  });

  it('a line sent before launch is dropped', () => {
    // Precondition: forwardLog('pre-<nonce>') really ran, and really ran
    // before launch() -- not merely assumed from source order. Without this,
    // an app that never called it at all would also pass.
    const preLaunchMarker = must(preSent, `the pre-launch channel probe marker (nonce ${nonce})`, run.start);
    const launchMarker = must(launching, 'the "launching on" marker', run.start);
    expect(preLaunchMarker.index).toBeLessThan(launchMarker.index);

    expect(bundles).toHaveLength(1);
    const events = logEventsOf(bundles[0]!);

    // Precondition: the SAME bundle really did capture the post-launch line,
    // so an empty (or wrongly scoped) log file could not pass this case
    // vacuously.
    const postLaunch = events.filter(event => messageOf(event).includes(`channel ${nonce}`));
    expect(postLaunch.length).toBeGreaterThan(0);

    const dropped = events.filter(event => messageOf(event).includes(`pre-${nonce}`));
    report('case B dropped-message matches', dropped);
    expect(dropped).toEqual([]);
  });
});
