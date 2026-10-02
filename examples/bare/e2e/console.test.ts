/**
 * Task 9.1: a `console.log` after launch is retained as a wrapper-channel
 * line.
 *
 * Retention is the same as wrapper-channel.test.ts. Android: airplane mode
 * on the WOD_LX1 (`AMRJCP4718402860`), Metro on `E2E_METRO_PORT` with
 * `adb reverse tcp:8081 tcp:<port>`. iOS: the closed loopback endpoint
 * (`DEAD_ENDPOINT` via startIosRun), simulator id from `IOS_SIMULATOR_ID`
 * (never `booted`), or the allowlisted iPhone when `E2E_IOS_TARGET=device`.
 *
 * `duration` stays 90. The scenario does not relaunch and does not override
 * App.tsx's launch options (`NON_DEFAULT_DURATION`).
 *
 * The line must be `LogSource.Custom`. That enum's wire value is 98
 * (Android `LogSource.Custom`). Source 4 is `LogSource.Bugsee`, the old
 * Android console hook. A duplicate from `RCTLog` is Task 9.7; this asserts
 * the wrapper-channel copy.
 *
 * Marker, from scenarios/console.ts (console.log, tag ReactNativeJS on
 * Android; mirrored to the simulator's console-pty stream on iOS):
 *   BUGSEE_E2E console <nonce>
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
  TARGET_NAME,
  describeDevice,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import {
  type DeviceLog,
  Logcat,
  IosConsole,
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

describeDevice(`console capture on ${TARGET_NAME}`, () => {
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '9.1');
    } else {
      log = await Logcat.start();
      useLog(log, '9.1');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('console');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E console ${nonce}`), 15_000, run.launched.index),
      'the console.log marker',
      run.start,
    );

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    if (bundles.length === 1) {
      report('log event JSON', logEventsOf(bundles[0]!));
    }
  });

  afterAll(async () => {
    try {
      if (ON_IOS) {
        await terminateIosApp();
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
      await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
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

  it('a console.log lands in the bundle as Custom', () => {
    expect(bundles).toHaveLength(1);
    const [bundle] = bundles as [PulledBundle];
    const events = logEventsOf(bundle);
    const message = `BUGSEE_E2E console ${nonce}`;
    const matches = events.filter(event => messageOf(event) === message);
    report('console.log events', matches);
    const custom = matches.filter(event => event.source === 98);
    expect(custom).toHaveLength(1);
    const [event] = custom as [Record<string, unknown>];
    expect(event.level).toBe(3);
    expect(event.source).toBe(98);
    expect(event.source).not.toBe(4);
    expect(Object.prototype.hasOwnProperty.call(event, 'tag')).toBe(false);
  });
});
