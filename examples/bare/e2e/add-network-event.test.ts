/**
 * Task 9.6: `Bugsee.addNetworkEvent` for a request the SDK did not capture.
 *
 * Same retention as network-filter.test.ts. The kept url, which carries the
 * nonce, is in the retained bundle. A second call whose filter never settles
 * is absent. `duration` stays 90. This test does not fetch, and it does not
 * edit network.test.ts.
 *
 * Android: WOD_LX1, Metro on E2E_METRO_PORT (8087 for this task).
 * iOS: the simulator named by IOS_SIMULATOR_ID (not `booted`), or the
 * allowlisted iPhone XS when E2E_IOS_TARGET=device and it is not already
 * running BareExample.
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

function keptNetworkEventUrl(nonce: string): string {
  return `https://bugsee-e2e.invalid/add/${nonce}`;
}

function hungNetworkEventUrl(nonce: string): string {
  return `https://bugsee-e2e.invalid/hang/${nonce}`;
}

jest.setTimeout(5 * 60_000);

function urlOf(event: Record<string, unknown>): string {
  return typeof event.url === 'string' ? event.url : '';
}

describeDevice(`addNetworkEvent on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '9.6');
    } else {
      log = await Logcat.start();
      useLog(log, '9.6');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('add-network-event');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E add-network-event uploaded nonce=${nonce}`),
        60_000,
        run.launched.index,
      ),
      'the added network events being uploaded',
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

  it('the added url is in the retained bundle', () => {
    expect(bundles).toHaveLength(1);
    const events = captureEvents(bundles[0]!, 'network');
    const url = keptNetworkEventUrl(nonce);
    const matches = events.filter(event => urlOf(event) === url);
    report('kept urls', matches.map(urlOf));
    expect(matches).toHaveLength(1);
  });

  it('a filter that never settles leaves that event out of the bundle', () => {
    expect(bundles).toHaveLength(1);
    const hung = log.all(
      new RegExp(`BUGSEE_E2E add-network-event hung nonce=${nonce}`),
      run.start,
    );
    report('hung lines', hung.map(line => line.text));
    expect(hung.length).toBeGreaterThan(0);
    const events = captureEvents(bundles[0]!, 'network');
    const url = hungNetworkEventUrl(nonce);
    const matches = events.filter(event => urlOf(event) === url);
    report('hung matches', matches);
    expect(matches).toHaveLength(0);
  });
});
