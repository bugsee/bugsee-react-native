/**
 * Task 9.4: the network filter's native→JS round trip, on a device.
 *
 * Same retention as wrapper-channel.test.ts. One network event the filter
 * rewrites is the event in the retained bundle. A filter that never settles
 * leaves that event out. `duration` stays 90: this scenario uses the app's
 * launch options and does not override them. The request is the scenario's own
 * `fetch` to the dead endpoint, on both platforms (the SDK's own session
 * traffic is not offered to the filter since iOS 7.0.0-beta5).
 *
 * Android: WOD_LX1, Metro on E2E_METRO_PORT (8085 for this task).
 * iOS: the simulator named by IOS_SIMULATOR_ID (not `booted`), or the
 * allowlisted iPhone XS when E2E_IOS_TARGET=device.
 */
import {
  type PulledBundle,
  airplane,
  captureEvents,
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

function urlOf(event: Record<string, unknown>): string {
  return typeof event.url === 'string' ? event.url : '';
}

function idOf(event: Record<string, unknown>): string {
  return typeof event.id === 'string' ? event.id : '';
}

describeDevice(`network filter on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '9.4');
    } else {
      log = await Logcat.start();
      useLog(log, '9.4');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('network-filter');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E network-filter uploaded nonce=${nonce}`),
        60_000,
        run.launched.index,
      ),
      'the filtered network events being uploaded',
      run.start,
    );

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    if (bundles.length === 1) {
      report('network event JSON', captureEvents(bundles[0]!, 'network'));
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

  it('a rewritten network event is the event in the bundle', () => {
    expect(bundles).toHaveLength(1);
    const events = captureEvents(bundles[0]!, 'network');
    const marker = `bugsee-e2e-redacted=${nonce}`;
    const matches = events.filter(event => urlOf(event).includes(marker));
    report('rewritten urls', matches.map(urlOf));
    expect(matches).toHaveLength(1);
  });

  it('a filter that never settles leaves that event out of the bundle', () => {
    expect(bundles).toHaveLength(1);
    // The hang is decided as soon as the second event arrives, which can be
    // during launch(), before status=2 is logged.
    // The console mirror logs the same line twice. Stages of one request
    // share an id, so the dropped event is the error stage, not every row
    // with that id.
    const hung = log.all(
      new RegExp(`BUGSEE_E2E network-filter hung id=(\\S+) type=error nonce=${nonce}`),
      run.start,
    );
    report('hung lines', hung.map(line => line.text));
    expect(hung.length).toBeGreaterThan(0);
    const id = /hung id=(\S+)/.exec(hung[0]!.text)?.[1];
    expect(id).toEqual(expect.any(String));
    const events = captureEvents(bundles[0]!, 'network');
    const matches = events.filter(event => idOf(event) === id && event.type === 'error');
    report('hung matches', matches);
    expect(matches).toHaveLength(0);
  });
});
