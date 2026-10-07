/**
 * Proof of the campaign harness's device helpers (N-12) on the real target:
 * every `bugsee-e2e-native` helper the campaign suites use (nativeLog,
 * rctLog, blockMain, setFlagSecure) and the HTTP stub (stub-server.ts).
 *
 * Scenarios `infra-native` and `infra-stub` (scenarios/infra.ts). Nothing
 * here reads a report bundle, so the network stays as it is; the app still
 * launches against the dead endpoint (startRun's guard).
 *
 * Where each platform's evidence comes from:
 *   nativeLog  Android logcat `<L> BugseeE2ENative: ...`; the iOS simulator's
 *              unified log (`log show`, subsystem com.bugsee.e2e; debug-level
 *              lines are not persisted by default, so only info, warn and
 *              error are required on either platform); an iPhone's
 *              unified log is not readable from this Mac without a sysdiagnose,
 *              so that case is skipped there.
 *   rctLog     Android logcat, React Native's FLog tag (`[<app>:]ReactNative`);
 *              iOS the app's console (RCTLog's default function writes there).
 *   blockMain  the helper's own begin/end lines, and the JS promise resolving after.
 *   FLAG_SECURE Android `dumpsys window` while it is on; iOS resolves false.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ANDROID_PACKAGE, IOS_SIMULATOR_ID, iosTarget } from './device';
import {
  ON_ANDROID,
  ON_IOS,
  type Run,
  TARGET_NAME,
  describeDevice,
  must,
  report,
  startDeviceLog,
  startRun,
  stopApp,
  stopDeviceLog,
} from './harness';
import { type DeviceLog, adb, resetScenario } from './scenario';
import { type StubServer, deviceStubUrl, releaseDeviceStub, startStubServerFor } from './stub-server';

const execFileAsync = promisify(execFile);

jest.setTimeout(4 * 60_000);

const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';
const itNativeLog = ON_IOS && !ON_SIMULATOR ? it.skip : it;

describeDevice(`the campaign harness helpers on ${TARGET_NAME}`, () => {
  let log: DeviceLog;

  beforeAll(async () => {
    log = await startDeviceLog('infra', 'infra');
  });

  afterAll(async () => {
    try {
      await stopApp();
    } finally {
      stopDeviceLog(log);
      resetScenario();
    }
  });

  describe('bugsee-e2e-native helpers', () => {
    let run: Run;
    let nonce: string;
    let secureDump = '';

    beforeAll(async () => {
      run = await startRun('infra-native');
      nonce = run.scenario.nonce;
      const on = must(
        await log.waitFor(new RegExp(`BUGSEE_E2E infra flag-secure on=\\w+ nonce=${nonce}`), 30_000, run.start),
        'the flag-secure on marker',
        run.start,
      );
      if (ON_ANDROID && / on=true /.test(on.text)) {
        // While it is on: the scenario holds it for 2 s.
        secureDump = await adb('shell', 'dumpsys', 'window', 'windows');
      }
      must(
        await log.waitFor(new RegExp(`BUGSEE_E2E infra native done nonce=${nonce}`), 30_000, on.index),
        'the native helpers finishing',
        run.start,
      );
    });

    itNativeLog('nativeLog writes each level to the platform log', async () => {
      const levels = ['debug', 'info', 'warn', 'error'];
      if (ON_ANDROID) {
        const seen = log
          .all(new RegExp(`\\s([VDIWE])\\s+BugseeE2ENative\\s*:\\s*infra native (\\w+) ${nonce}`), run.start)
          .map(line => /\s([VDIWE])\s+BugseeE2ENative\s*:\s*infra native (\w+)/.exec(line.text)!.slice(1, 3).join(':'));
        report('nativeLog lines', seen);
        expect(seen).toEqual(expect.arrayContaining(['I:info', 'W:warn', 'E:error']));
        // Debug may be filtered by the handset's log level; when it arrives it is D.
        expect(seen.filter(entry => entry.endsWith(':debug')).every(entry => entry === 'D:debug')).toBe(true);
        return;
      }
      const { stdout } = await execFileAsync(
        'xcrun',
        [
          'simctl', 'spawn', IOS_SIMULATOR_ID, 'log', 'show', '--last', '3m', '--info', '--debug', '--style', 'compact',
          '--predicate', `subsystem == "com.bugsee.e2e" AND eventMessage CONTAINS "${nonce}"`,
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      const seen = levels.filter(level => stdout.includes(`infra native ${level} ${nonce}`));
      report('os_log lines', stdout.split('\n').filter(line => line.includes(nonce)));
      // Debug-level os_log is not persisted unless the subsystem is
      // configured to keep it (`log config`), so `log show` may not have it.
      expect(seen.filter(level => level !== 'debug')).toEqual(['info', 'warn', 'error']);
    });

    it("rctLog goes through React Native's native log", () => {
      const pattern = ON_ANDROID
        ? new RegExp(`\\sW\\s+(?:\\S+:)?ReactNative\\s*:\\s*infra rct warn ${nonce}`)
        : new RegExp(`infra rct warn ${nonce}`);
      const lines = log.all(pattern, run.start);
      report('rctLog lines', lines.map(line => line.text.trim()));
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });

    it('blockMain holds the main thread for the time asked, then resolves', () => {
      const resolved = must(
        log.all(new RegExp(`BUGSEE_E2E infra blockMain resolved elapsed=(\\d+) ticks=(\\d+) nonce=${nonce}`), run.start)[0],
        'blockMain resolving',
        run.start,
      );
      const [, elapsed, ticks] = /elapsed=(\d+) ticks=(\d+)/.exec(resolved.text)!;
      const end = must(log.all(/BugseeE2E\s*:?\s*blockMain end elapsed=(\d+)/, run.start)[0], 'the blockMain end line', run.start);
      const held = Number(/elapsed=(\d+)/.exec(end.text)![1]);
      report('blockMain', { jsElapsed: Number(elapsed), jsTicks: Number(ticks), mainHeld: held });
      expect(held).toBeGreaterThanOrEqual(1500);
      expect(Number(elapsed)).toBeGreaterThanOrEqual(1500);
      // `ticks` is informational. JS timers are driven from the main thread
      // (Android's Choreographer), so they stall while it is blocked: 0 on
      // the WOD_LX1. The JS promise still resolves after the block.
    });

    it(ON_ANDROID ? 'setFlagSecure sets FLAG_SECURE on the window and clears it' : 'setFlagSecure resolves false on iOS', () => {
      const on = must(log.all(new RegExp(`BUGSEE_E2E infra flag-secure on=(\\w+) nonce=${nonce}`), run.start)[0], 'on', run.start);
      const off = must(log.all(new RegExp(`BUGSEE_E2E infra flag-secure off=(\\w+) nonce=${nonce}`), run.start)[0], 'off', run.start);
      if (!ON_ANDROID) {
        expect([/on=(\w+)/.exec(on.text)![1], /off=(\w+)/.exec(off.text)![1]]).toEqual(['false', 'false']);
        return;
      }
      expect([/on=(\w+)/.exec(on.text)![1], /off=(\w+)/.exec(off.text)![1]]).toEqual(['true', 'true']);
      // The app's window, while the flag was on: its attributes name SECURE.
      const windows = secureDump.split(/\n(?=\s*Window #)/).filter(block => block.includes(ANDROID_PACKAGE));
      const secure = windows.filter(block => /\bfl=[^\n]*\bSECURE\b/.test(block));
      report('FLAG_SECURE windows', secure.map(block => block.split('\n')[0]!.trim()));
      expect(windows.length).toBeGreaterThan(0);
      expect(secure.length).toBeGreaterThan(0);
    });
  });

  describe('the HTTP stub', () => {
    let server: StubServer;
    let nonce: string;
    let result: string;

    beforeAll(async () => {
      const platform = ON_IOS ? 'ios' : 'android';
      server = await startStubServerFor(platform);
      const url = await deviceStubUrl(server, platform);
      report('stub url', url);
      const run = await startRun('infra-stub', { stub: url });
      nonce = run.scenario.nonce;
      result = must(
        await log.waitFor(new RegExp(`BUGSEE_E2E infra stub .* nonce=${nonce}`), 30_000, run.start),
        'the stub marker',
        run.start,
      ).text;
    });

    afterAll(async () => {
      await releaseDeviceStub(ON_IOS ? 'ios' : 'android');
      await server?.close();
    });

    it('answers the app with the status each path asks for, and records both requests', () => {
      report('stub result', result.trim());
      report('stub requests', server.requests.map(request => `${request.method} ${request.path} -> ${request.status}`));
      expect(result).toMatch(/ 500=500 200=200 /);
      expect(server.requests.filter(request => request.path === `/status/500/infra-${nonce}`)).toHaveLength(1);
      expect(server.requests.filter(request => request.path === `/status/200/infra-${nonce}`)).toHaveLength(1);
    });
  });
});
