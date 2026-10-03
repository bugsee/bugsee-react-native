/**
 * Phase 11: appearance is written and read back, then collected data is
 * deleted, after launch. A second launch stops the SDK and deletes again.
 *
 * Markers, from scenarios/appearance.ts:
 *   BUGSEE_E2E appearance nonce=<n> background=#ff0000ff includingIntermediate=true deleted=false
 *   BUGSEE_E2E appearance nonce=<n> stopped=true includingIntermediate=true deleted=true
 *
 * The color in the launched line is what the SDK returned. While launched the
 * SDK refuses deletion. After stop it must succeed. `duration` stays 90.
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

  beforeAll(async () => {
    log = await startDeviceLog('11', '11');
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

  async function launch(name: string): Promise<Run> {
    const run = await startRun(name);
    report('banner', run.banner.text.trim());
    report('build', run.dev ? 'Debug' : 'Release');
    return run;
  }

  it('reads the stored color back and records that deletion was refused', async () => {
    const run = await launch('appearance');
    const nonce = run.scenario.nonce;
    const found = must(
      await log!.waitFor(
        new RegExp(
          `BUGSEE_E2E appearance nonce=${nonce} background=#ff0000ff includingIntermediate=true deleted=false`,
        ),
        20_000,
        run.launched.index,
      ),
      'the launched appearance line with deleted=false',
      run.start,
    );
    expect(found.text).toContain(`nonce=${nonce}`);
    expect(found.text).toContain('background=#ff0000ff');
    expect(found.text).toContain('includingIntermediate=true');
    expect(found.text).toContain('deleted=false');
  });

  it('deletes collected data after stop', async () => {
    const run = await launch('appearance-stopped');
    const nonce = run.scenario.nonce;
    const found = must(
      await log!.waitFor(
        new RegExp(
          `BUGSEE_E2E appearance nonce=${nonce} stopped=true includingIntermediate=true deleted=`,
        ),
        20_000,
        run.launched.index,
      ),
      'the stop-then-delete appearance line',
      run.start,
    );
    expect(found.text).toContain(`nonce=${nonce}`);
    expect(found.text).toContain('stopped=true');
    expect(found.text).toContain('includingIntermediate=true');
    expect(found.text).toContain('deleted=true');
  });
});
