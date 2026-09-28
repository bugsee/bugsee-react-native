/**
 * Task 3.5b: the wrapper channel on Android hardware.
 * Task 3.5d: the same channel on iOS (simulator; see device.ts/bundles.ts).
 *
 * Task 3.5a built the channel seam and unit-tested it against fakes: what
 * only a device can show is that a line sent through it after `Launched`
 * really reaches the bundle the SDK writes, attributed as source `Custom`
 * (98), and that a line sent before `launch()` is really dropped rather than
 * merely untested. (On iOS that drop is the channel holder's -- no wrapper is
 * registered before `launch()` calls `setWrapperInfo` -- not the SDK's; see
 * scenarios/channel.ts.)
 *
 * Android preconditions, as for report-handler.test.ts: the app is installed
 * on the handset named in device.ts, and for a debug build Metro is running
 * with `adb reverse tcp:8081 tcp:8081`. This runs on the same debug build
 * 3.4d's retained-bundle cases used.
 *
 * iOS preconditions, as for report-handler.test.ts (Task 3.4f): the Debug app
 * is installed on the booted simulator (IOS_SIMULATOR_ID) and Metro is
 * running. The simulator has no airplane mode, so retention goes through the
 * closed loopback endpoint (bundles.ts, DEAD_ENDPOINT) instead.
 *
 * Markers, from scenarios/channel.ts (console.log, tag ReactNativeJS on
 * Android; mirrored to the simulator's console-pty stream on iOS):
 *   BUGSEE_E2E channel pre-sent nonce=<n>   forwardLog('pre-<n>') ran, before launch()
 *   BUGSEE_E2E channel sent nonce=<n>       forwardLog('BUGSEE_E2E channel <n>') ran, after Launched
 */
import {
  type PulledBundle,
  airplane,
  removePulledBundles,
  terminateIosApp,
} from './bundles';
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
import {
  type DeviceLog,
  type LogLine,
  Logcat,
  SimulatorConsole,
  adb,
  resetScenario,
} from './scenario';

jest.setTimeout(5 * 60_000);

let log: DeviceLog;

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

describeDevice(`wrapper channel on ${ON_IOS ? 'the iOS simulator' : 'an Android handset'}`, () => {
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];
  /** The pre-launch probe's own marker -- the negative case's precondition. */
  let preSent: LogLine | undefined;
  /** Where App.tsx logs having started launch() -- the ordering witness. */
  let launching: LogLine | undefined;

  beforeAll(async () => {
    if (ON_IOS) {
      // No network switch to throw: every iOS launch carries DEAD_ENDPOINT
      // (startIosRun), which is what retains its bundle.
      log = SimulatorConsole.start();
      useLog(log, '3.5d');
    } else {
      log = await Logcat.start();
      // Tagged 3.5d on both platforms, as before the helpers were shared.
      useLog(log, '3.5d');
      // 9.3.2: offline before the app starts, so the report is retained where
      // the test can read it rather than uploaded and gone.
      await airplane(true);
    }
    await clearBundles();

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
      if (ON_IOS) {
        await terminateIosApp();
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
      await clearBundles().catch(() => {});
    } finally {
      // airplane(false) can throw (it shells out to adb/simctl); the bundle
      // cleanup and log stop below must run regardless, so they get their
      // own finally rather than sitting after it in the same block.
      try {
        if (!ON_IOS) {
          await airplane(false);
        }
      } finally {
        resetScenario();
        // Pulled bundles carry credentials on iOS beta3; E2E_KEEP_BUNDLES=1
        // keeps them for inspection.
        const { removed, kept } = removePulledBundles();
        report('pulled bundle roots', { removed: removed.length, kept });
        if (log !== undefined) {
          log.stop();
        }
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

    // What this proves differs by platform. Android: the init provider's
    // channel exists, so the SDK itself dropped the line. iOS: no wrapper is
    // registered until launch() calls setWrapperInfo, so the line stopped at
    // BGSRNWrapperChannelHolder's nil channel and never reached the SDK --
    // this case says nothing about the SDK's own pre-launch drop there.
    const dropped = events.filter(event => messageOf(event).includes(`pre-${nonce}`));
    report('case B dropped-message matches', dropped);
    expect(dropped).toEqual([]);
  });
});
