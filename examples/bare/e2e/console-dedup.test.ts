/**
 * Task 9.7: one `console.log` reaches the user's log filter once.
 *
 * Debug (`E2E_RELEASE` unset) is the overlap: RN also routes the call
 * through RCTLog. Release (`E2E_RELEASE=1`, a Release binary installed)
 * must still keep the line. `duration` stays 90.
 *
 * Marker, from scenarios/console-dedup.ts:
 *   BUGSEE_E2E dedup-result nonce=<n> calls=1
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

const RELEASE = process.env.E2E_RELEASE === '1';

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

describeDevice(`console dedup on ${TARGET_NAME} (${RELEASE ? 'release' : 'debug'})`, () => {
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '9.7');
    } else {
      log = await Logcat.start();
      useLog(log, '9.7');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('console-dedup');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    report('dev', run.dev);

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E dedup-result nonce=${nonce} calls=1`),
        30_000,
        run.launched.index,
      ),
      'the filter running once',
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

  it('the build shape matches the run', () => {
    expect(run.dev).toBe(!RELEASE);
  });

  it('one console.log is filtered once and kept as Custom', () => {
    expect(bundles).toHaveLength(1);
    const events = logEventsOf(bundles[0]!);
    const marker = `BUGSEE_E2E dedup-line ${nonce}`;
    const matches = events.filter(event => messageOf(event).includes(marker));
    report('dedup matches', matches);
    expect(matches).toHaveLength(1);
    const [event] = matches as [Record<string, unknown>];
    expect(event.message).toBe(`${marker} #1`);
    expect(event.source).toBe(98);
    expect(event.level).toBe(3);
    const doubled = events.filter(event => messageOf(event).includes(`${marker} #2`));
    expect(doubled).toHaveLength(0);
  });
});
