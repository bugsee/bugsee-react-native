/**
 * Task 9.5: the breadcrumb filter's native→JS round trip, on a device.
 *
 * Same retention as log-filter.test.ts. A crumb with a unique message is
 * retained, rewritten. A second crumb the filter rewrites is the crumb in
 * the retained bundle. A filter that never settles leaves that crumb out.
 * `duration` stays 90. Breadcrumb capture is on for this scenario only,
 * because the iOS SDK's `BugseeOptionCaptureBreadcrumbs` defaults to NO.
 *
 * Android: WOD_LX1, Metro on E2E_METRO_PORT (8086 for this task).
 * iOS: the simulator named by IOS_SIMULATOR_ID (not `booted`), or the
 * allowlisted iPhone XS when E2E_IOS_TARGET=device.
 */
import { type PulledBundle, airplane, removePulledBundles, terminateIosApp } from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
  ON_IOS,
  type Run,
  TARGET_NAME,
  awaitBundles,
  clearBundles,
  describeDevice,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import { type DeviceLog, IosConsole, Logcat, adb, resetScenario } from './scenario';

jest.setTimeout(5 * 60_000);

let log: DeviceLog;

function breadcrumbEventsOf(bundle: PulledBundle): ReadonlyArray<Record<string, unknown>> {
  const text = bundle.captures.get('breadcrumbs');
  if (text === undefined) {
    throw new Error(
      `bundle ${bundle.file} has no type:"breadcrumbs" file in its manifest; ` +
        `manifest files: ${JSON.stringify(bundle.manifest.files)}`,
    );
  }
  const document = JSON.parse(text) as { events?: unknown };
  if (!Array.isArray(document.events)) {
    throw new Error(
      `breadcrumbs in ${bundle.file} has no events array: ${text.slice(0, 200)}`,
    );
  }
  return document.events as Array<Record<string, unknown>>;
}

function messageOf(event: Record<string, unknown>): string {
  return typeof event.message === 'string' ? event.message : '';
}

describeDevice(`breadcrumb filter on ${TARGET_NAME}`, () => {
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '9.5');
    } else {
      log = await Logcat.start();
      useLog(log, '9.5');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('breadcrumb-filter');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E breadcrumb-filter uploaded nonce=${nonce}`),
        30_000,
        run.launched.index,
      ),
      'the filtered crumbs being uploaded',
      run.start,
    );

    bundles = await awaitBundles(1);
    report('bundle files', bundles.map(b => b.file));
    if (bundles.length === 1) {
      report('breadcrumb event JSON', breadcrumbEventsOf(bundles[0]!));
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

  it('a crumb with a unique message is retained, rewritten', () => {
    expect(bundles).toHaveLength(1);
    const events = breadcrumbEventsOf(bundles[0]!);
    const want = `breadcrumb-filter immediate ${nonce} REDACTED`;
    const matches = events.filter(event => messageOf(event).includes(`breadcrumb-filter immediate ${nonce}`));
    report('immediate matches', matches);
    expect(matches).toHaveLength(1);
    const [event] = matches as [Record<string, unknown>];
    expect(event.message).toBe(want);
    const leaked = events.filter(event =>
      messageOf(event).includes(`breadcrumb-filter immediate ${nonce} SECRET`),
    );
    expect(leaked).toHaveLength(0);
  });

  it('a filter rewrite of that message is retained', () => {
    expect(bundles).toHaveLength(1);
    const events = breadcrumbEventsOf(bundles[0]!);
    const want = `breadcrumb-filter rewrite ${nonce} REDACTED`;
    const matches = events.filter(event => messageOf(event).includes(`breadcrumb-filter rewrite ${nonce}`));
    report('rewrite matches', matches);
    expect(matches).toHaveLength(1);
    const [event] = matches as [Record<string, unknown>];
    expect(event.message).toBe(want);
  });

  it("an unsettled filter's crumb is absent", () => {
    expect(bundles).toHaveLength(1);
    const events = breadcrumbEventsOf(bundles[0]!);
    const hang = events.filter(event => messageOf(event).includes(`breadcrumb-filter hang ${nonce}`));
    report('hang matches', hang);
    expect(hang).toHaveLength(0);
    const leaked = events.filter(event =>
      messageOf(event).includes(`breadcrumb-filter hang ${nonce} SECRET`),
    );
    expect(leaked).toHaveLength(0);
  });
});
