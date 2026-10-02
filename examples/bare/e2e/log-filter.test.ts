/**
 * Task 9.2: the log filter's native→JS round trip, on a device.
 *
 * Same retention as wrapper-channel.test.ts. A `Bugsee.log` line the filter
 * rewrites is the line in the retained bundle. A filter that never settles
 * leaves that line out. `duration` stays 90: this scenario uses the app's
 * launch options and does not override them.
 *
 * Android: WOD_LX1, Metro on E2E_METRO_PORT (8083 for this task).
 * iOS: the simulator named by IOS_SIMULATOR_ID (not `booted`), or the
 * allowlisted iPhone XS when E2E_IOS_TARGET=device.
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
  type LogLine,
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

describeDevice(`log filter on ${TARGET_NAME}`, () => {
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '9.2');
    } else {
      log = await Logcat.start();
      useLog(log, '9.2');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('log-filter');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E log-filter uploaded nonce=${nonce}`),
        30_000,
        run.launched.index,
      ),
      'the filtered lines being uploaded',
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

  it('a rewritten Bugsee.log line is the line in the bundle', () => {
    expect(bundles).toHaveLength(1);
    const events = logEventsOf(bundles[0]!);
    const want = `log-filter rewrite ${nonce} REDACTED`;
    const matches = events.filter(event => messageOf(event).includes(`log-filter rewrite ${nonce}`));
    report('rewrite matches', matches);
    expect(matches).toHaveLength(1);
    const [event] = matches as [Record<string, unknown>];
    expect(event.message).toBe(want);
    expect(event.source).toBe(98);
    expect(event.level).toBe(2);
  });

  it('a filter that never settles leaves that line out of the bundle', () => {
    expect(bundles).toHaveLength(1);
    const events = logEventsOf(bundles[0]!);
    const hang = events.filter(event => messageOf(event).includes(`log-filter hang ${nonce}`));
    report('hang matches', hang);
    expect(hang).toHaveLength(0);
    const leaked = events.filter(event => messageOf(event).includes(`log-filter hang ${nonce} SECRET`));
    expect(leaked).toHaveLength(0);
  });
});
