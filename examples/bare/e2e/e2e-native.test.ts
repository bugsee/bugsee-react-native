/**
 * Task 7.6a: `bugsee-e2e-native`, the example-only native module (R12), on
 * both platforms.
 *
 * The module exists for later device tests: 7.6b crashes the process through
 * it (a JNI SIGSEGV/SIGABRT on Android), and Phase 8 attaches the files it
 * writes. This suite is its smoke test. It proves the module is linked into
 * the example and reachable from JS, that `writeTempFile` really writes a
 * file at the absolute path it resolves, and that the JS guard stops an
 * unknown crash kind before it can cross the bridge -- a guard that let one
 * through would hand native code a kind it does not know.
 *
 * Preconditions, as for wrapper-channel.test.ts: the debug app is installed
 * (on the handset named in device.ts with Metro reachable over `adb reverse`,
 * or on the booted simulator with Metro running). Nothing here needs a
 * retained report, so there is no airplane mode or bundle clearing; the app
 * launches against DEAD_ENDPOINT as every run with the placeholder token does.
 *
 * Markers, from scenarios/native.ts:
 *   BUGSEE_E2E native tmp path=<p> exists=<bool>   writeTempFile('smoke-<n>.txt', 'smoke <n>'), then fileExists(p)
 *   BUGSEE_E2E native bad-kind code=<name>         crashNative('bogus') inside try; the caught error's name
 */
import { readFileSync } from 'node:fs';

import { terminateIosApp } from './bundles';
import { ANDROID_PACKAGE, iosTarget } from './device';
import {
  ON_IOS,
  type Run,
  TARGET_NAME,
  describeDevice,
  escape,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import {
  type DeviceLog,
  type LogLine,
  IosConsole,
  Logcat,
  adb,
  devicePidsOfApp,
  hostProcessAlive,
  pidOf,
  resetScenario,
} from './scenario';

jest.setTimeout(5 * 60_000);

const IOS_PID_LINE = /BareExample\[(\d+):/;

/** A native crash anywhere in the run: neither case may see one. */
const CRASHED = ON_IOS ? /Terminating app|SIGABRT|SIGSEGV/ : /Fatal signal|FATAL EXCEPTION/;

describeDevice(`bugsee-e2e-native on ${TARGET_NAME}`, () => {
  let log: DeviceLog;
  let run: Run;
  let nonce: string;
  let tmp: LogLine;
  let badKind: LogLine;
  /** The app's pid when the bad-kind marker was logged. */
  let pid: string | undefined;

  beforeAll(async () => {
    if (ON_IOS) {
      log = IosConsole.start();
    } else {
      log = await Logcat.start();
    }
    useLog(log, '7.6a');

    run = await startRun('e2e-native-smoke');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    // The cases are for a debug build; a release bundle is another task's.
    expect(run.dev).toBe(true);

    tmp = must(
      await log.waitFor(/BUGSEE_E2E native tmp /, 15_000, run.launched.index),
      'the temp-file marker',
      run.start,
    );
    report('tmp marker', tmp.text.trim());
    badKind = must(
      await log.waitFor(/BUGSEE_E2E native bad-kind /, 15_000, tmp.index),
      'the bad-kind marker',
      run.start,
    );
    report('bad-kind marker', badKind.text.trim());
    pid = ON_IOS ? IOS_PID_LINE.exec(run.banner.text)?.[1] : await pidOf();
    report('pid', pid ?? 'none');
  });

  afterAll(async () => {
    try {
      if (ON_IOS) {
        await terminateIosApp();
      } else {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
    } finally {
      try {
        if (log !== undefined) {
          log.stop();
        }
      } finally {
        resetScenario();
      }
    }
  });

  it('writeTempFile returns an absolute path that exists', async () => {
    const match = /BUGSEE_E2E native tmp path=(\S+) exists=(\S+)/.exec(tmp.text);
    expect(match).not.toBeNull();
    const path = match![1]!;
    const exists = match![2]!;
    expect(path.startsWith('/')).toBe(true);
    // This run's file, by name: a leftover from an earlier run cannot pass.
    expect(path).toMatch(new RegExp(`/smoke-${escape(nonce)}\\.txt$`));
    expect(exists).toBe('true');

    // And it holds what was written, read back from outside the app where
    // the host can reach the file: through run-as on the (debuggable)
    // Android app, straight off the disk for a simulator app. An iPhone's
    // container is not readable here, so there the app's own
    // fileExists is the evidence.
    if (!ON_IOS) {
      const contents = await adb('shell', 'run-as', ANDROID_PACKAGE, 'cat', path);
      expect(contents).toBe(`smoke ${nonce}`);
    } else if (iosTarget() === 'simulator') {
      expect(readFileSync(path, 'utf8')).toBe(`smoke ${nonce}`);
    }
  });

  it('an unknown crash kind is rejected in JS', async () => {
    expect(badKind.text).toMatch(/BUGSEE_E2E native bad-kind code=TypeError\s*$/);

    // The process is still the same one, alive, 2 s later.
    expect(pid).toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 2_000));
    if (!ON_IOS) {
      expect(await pidOf()).toBe(pid);
    } else if (iosTarget() === 'simulator') {
      expect(hostProcessAlive(Number(pid))).toBe(true);
      expect(run.launch?.hasEnded()).toBe(false);
    } else {
      expect(await devicePidsOfApp()).toContain(Number(pid));
      expect(run.launch?.hasEnded()).toBe(false);
    }
    expect(log.all(CRASHED, run.start).map(line => line.text)).toEqual([]);
  });
});
