/**
 * Task 9.3: a JS `fetch` in a retained bundle.
 *
 * Android: WOD_LX1, airplane mode before launch (as wrapper-channel.test.ts),
 * Metro on `E2E_METRO_PORT`. The scenario fetches one URL that does not need
 * to answer. The retained bundle's `network` capture must contain that URL.
 *
 * iOS: the same assertion, on the simulator named by `IOS_SIMULATOR_ID`
 * (never the word `booted`) and, when run with `E2E_IOS_TARGET=device`, on
 * the allowlisted iPhone. Retention is `DEAD_ENDPOINT` via `startRun`. If
 * the bundle has no such request, this test fails and says so.
 *
 * A second fetch carries the lowercase word "bugsee" in its path and query. A
 * customer request like that IS recorded on both platforms (iOS drops none
 * since 7.0.0-beta5, which tells the SDK's own traffic apart by session,
 * bugsee-cocoa #192; Android never had a url rule). On iOS the SDK's own
 * session traffic to the dead endpoint (`/v2/sessions`) must no longer appear
 * in the capture. Android's capture never held it either (it runs in airplane
 * mode, so the SDK's session request is not even attempted there): the same
 * assertion holds on both, and it is only a regression guard on iOS.
 *
 * Launch still sets `duration` to 90 (App.tsx). This file does not change it.
 *
 * Markers, from scenarios/network.ts:
 *   BUGSEE_E2E network fetching nonce=<n>   fetch() started
 *   BUGSEE_E2E network fetch failed ...     the dead endpoint refused it
 *   BUGSEE_E2E network sent nonce=<n>       upload() ran after the fetch settled
 */
import {
  type PulledBundle,
  airplane,
  captureEvents,
  removePulledBundles,
  terminateIosApp,
} from './bundles';
import { bugseeNamedUrl } from '../endpoint';
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

/**
 * The path scenarios/network.ts fetches, written here rather than imported:
 * the scenario is app code, and an e2e that compared the app against itself
 * could not fail. It does not contain "bugsee" (through 7.0.0-beta4 the iOS
 * SDK's release build dropped any such url as its own traffic, which kept this
 * test red on iOS while Android passed); the "bugsee" request has its own
 * test below.
 */
function fetchPath(nonce: string): string {
  return `rn-e2e-fetch/${nonce}`;
}

/** The url scenarios/network.ts fetches with "bugsee" in it, built from the e2e's own helper. */
function namedUrl(nonce: string): string {
  return bugseeNamedUrl(nonce);
}

function urlOf(event: Record<string, unknown>): string {
  return typeof event.url === 'string' ? event.url : '';
}

describeDevice(`JS fetch in a retained bundle on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '9.3');
    } else {
      log = await Logcat.start();
      useLog(log, '9.3');
      // Same retention as wrapper-channel.test.ts: offline before the app
      // starts, so the report stays on the device.
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('network');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E network fetching nonce=${nonce}`),
        20_000,
        run.launched.index,
      ),
      'the fetch starting',
      run.start,
    );
    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E network (fetch failed|fetched status=).+ nonce=${nonce}`),
        20_000,
        run.launched.index,
      ),
      'the fetch settling',
      run.start,
    );
    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E network sent nonce=${nonce}`),
        15_000,
        run.launched.index,
      ),
      'upload after the fetch',
      run.start,
    );

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    for (const bundle of bundles) {
      const types = bundle.manifest.files.map(file => file.type);
      report(`${bundle.file} manifest types`, types);
      const events = captureEvents(bundle, 'network');
      report(
        'network urls',
        events.map(event => ({
          url: urlOf(event),
          type: event.type,
          mechanism: event.mechanism,
          method: event.method,
        })),
      );
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

  it('the retained bundle contains the JS fetch', () => {
    expect(bundles).toHaveLength(1);
    const [bundle] = bundles as [PulledBundle];
    const events = captureEvents(bundle, 'network');
    const path = fetchPath(nonce);
    const matches = events.filter(event => urlOf(event).includes(path));
    const summary = {
      containsFetch: matches.length > 0,
      path,
      networkUrls: events.map(event => urlOf(event)),
      manifestTypes: bundle.manifest.files.map(file => file.type),
    };
    report('fetch assertion', summary);
    // A miss fails here and names what the bundle held. Do not accept
    // "either outcome".
    expect(summary.containsFetch).toBe(true);
  });

  it('a customer request whose url contains "bugsee" (path and query) is recorded', () => {
    const [bundle] = bundles as [PulledBundle];
    const events = captureEvents(bundle, 'network');
    const wanted = namedUrl(nonce);
    expect(wanted).toMatch(/bugsee/);
    expect(new URL(wanted).pathname).toContain('bugsee');
    expect(new URL(wanted).search).toContain('bugsee');
    const matches = events.filter(event => urlOf(event) === wanted);
    report('bugsee-named assertion', {
      wanted,
      recorded: matches.length,
      networkUrls: events.map(event => urlOf(event)),
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  it('the SDK\'s own session traffic is not in the network capture', () => {
    const [bundle] = bundles as [PulledBundle];
    const ownTraffic = captureEvents(bundle, 'network').filter(event => urlOf(event).includes('/v2/sessions'));
    report('own traffic', ownTraffic.map(event => urlOf(event)));
    expect(ownTraffic).toEqual([]);
  });
});
