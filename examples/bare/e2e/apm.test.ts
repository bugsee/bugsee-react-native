/**
 * Phase 10: a notification arrives, and a transaction appears in a report.
 *
 * The scenario (scenarios/apm.ts) notifies, starts a transaction, starts a
 * child span on the same thread, finishes both, then uploads. Retention is
 * airplane mode on Android and the dead endpoint on iOS, same as the other
 * bundle suites. The notification is not part of the bundle: it is the
 * relay file the SDK writes under its data directory.
 *
 * Marker, from scenarios/apm.ts:
 *   BUGSEE_E2E apm notify=notify-<n> txn=txn-<n>
 */
import { type PulledBundle, airplane, relayTexts, removePulledBundles, terminateIosApp } from './bundles';
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

describeDevice(`a notification and a transaction on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let bundles: PulledBundle[];
  let relay: string[];

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '10');
    } else {
      log = await Logcat.start();
      useLog(log, '10');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('apm');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    report('build', run.dev ? 'Debug' : 'Release');

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E apm notify=notify-${nonce} txn=txn-${nonce}`),
        20_000,
        run.launched.index,
      ),
      'the notification and the transaction being sent',
      run.start,
    );

    relay = await awaitRelay(`notify-${nonce}`);
    report('relay files', relay.length);

    bundles = await awaitBundles(1);
    report(
      'bundle files',
      bundles.map(bundle => bundle.file),
    );
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

  it('the notification is still in the relay', () => {
    const title = `notify-${nonce}`;
    const hits = relay.filter(text => text.includes(title));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(`body-${nonce}`);
  });

  it('the transaction and its child span are in the report', () => {
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    const text = bundle.captures.get('performance');
    expect(text).toBeDefined();
    expect(text).toContain(`txn-${nonce}`);
    expect(text).toContain(`span-${nonce}`);
  });
});

async function awaitRelay(title: string, timeoutMs = 20_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let texts: string[] = [];
  while (Date.now() < deadline) {
    texts = await relayTexts(ON_IOS);
    if (texts.some(text => text.includes(title))) {
      return texts;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return texts;
}
