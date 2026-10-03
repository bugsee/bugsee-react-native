/**
 * Phase 11: appearance is written and read back, then collected data is
 * deleted, after launch.
 *
 * Marker, from scenarios/appearance.ts:
 *   BUGSEE_E2E appearance nonce=<n> background=#ff0000ff includingIntermediate=true deleted=<bool>
 *
 * The color in the line is what the SDK returned. `includingIntermediate`
 * is the flag the scenario passed through. `duration` stays 90.
 */
import { terminateIosApp } from './bundles';
import { ANDROID_PACKAGE } from './device';
import {
  ON_IOS,
  type Run,
  TARGET_NAME,
  describeDevice,
  must,
  report,
  startDeviceLog,
  startRun,
  stopDeviceLog,
} from './harness';
import { type DeviceLog, adb, resetScenario } from './scenario';

jest.setTimeout(5 * 60_000);

describeDevice(`appearance and data deletion on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let nonce: string;
  let line: string;

  beforeAll(async () => {
    log = await startDeviceLog('11', '11');

    run = await startRun('appearance');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    report('build', run.dev ? 'Debug' : 'Release');

    const found = must(
      await log.waitFor(
        new RegExp(
          `BUGSEE_E2E appearance nonce=${nonce} background=#ff0000ff includingIntermediate=true`,
        ),
        20_000,
        run.launched.index,
      ),
      'the appearance color being read back',
      run.start,
    );
    line = found.text;
  });

  afterAll(async () => {
    try {
      if (ON_IOS) {
        await terminateIosApp();
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
    } finally {
      stopDeviceLog(log);
      resetScenario();
    }
  });

  it('reads the stored color back and records the deletion flag', () => {
    expect(line).toContain(`nonce=${nonce}`);
    expect(line).toContain('background=#ff0000ff');
    expect(line).toContain('includingIntermediate=true');
  });
});
