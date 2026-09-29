/**
 * Task 1.5's assertion: the example app, on real hardware, gets the native SDK
 * all the way to `Status.Launched`.
 *
 * This is the only test in the repo that touches a device. Everything below the
 * facade is unit-tested with the bridge mocked, which by construction cannot
 * catch a framework that was never embedded, a Gradle plugin that was never
 * applied, or a launch call made off the main thread. Those are the failures
 * this phase exists to rule out, and they are only visible here.
 *
 * Preconditions, deliberately not automated away: the app is built and
 * installed on the device named in `device.ts`, and — for a debug build —
 * Metro is running. Both are the job of the runner, not of the assertion.
 */
import { DEAD_ENDPOINT, terminateIosApp } from './bundles';
import {
  iosTarget,
  launchAndWaitForSequence,
  platformUnderTest,
  type Step,
} from './device';
import { IOS_STOPPED_FOR_TOKEN, escape } from './harness';
import {
  awaitMetroServes,
  resetScenario,
  scenarioArgs,
  scenarioUri,
  writeScenario,
} from './scenario';
import { checkAndroidBanner } from '../../../scripts/sdk-banner';
import { readNativeVersions } from '../../../scripts/native-versions';

/**
 * Two markers, two clocks.
 *
 * The first says the JS bundle is running, and is given a generous budget
 * because on a debug build it includes fetching the bundle from Metro. The
 * second is the one Task 1.5 is about, and starts counting only from there —
 * otherwise a cold bundler would fail a test about Bugsee.
 */
const BASE_STEPS: readonly Step[] = [
  {
    name: 'JS running',
    pattern: /BUGSEE_E2E launching on/,
    timeoutMs: 120_000,
  },
  {
    // The SDK brings capture up off the main thread on both platforms, so
    // launch() resolving is not the same as being live. The app polls
    // getStatus(); this waits for the transition, not for the call.
    name: 'Status.Launched',
    pattern: /BUGSEE_E2E status=2/,
    timeoutMs: 10_000,
  },
  {
    // Task 2.6: the SDK reports back the non-default duration the app set, so
    // the typed options model demonstrably reached it. Asserting the value
    // and not merely the key's presence -- an SDK echoing its own default
    // would also produce a key.
    name: 'option took effect',
    // Matches the value, not merely the key: an SDK echoing its own default
    // would also produce a key. `keys=` rides along so a failure shows
    // whether the SDK reported nothing at all or reported without this one.
    pattern: /BUGSEE_E2E effective duration=90 /,
    timeoutMs: 15_000,
  },
  {
    // Task 3.7: `com.bugsee.option.config.wifi-only-upload` is a key the app
    // never sets (App.tsx's launchOptions sets only endpoint and duration).
    // Android has always been able to answer this -- it merges its own
    // defaults with the app's overrides -- but iOS historically could only
    // report options that DIFFER from its defaults, so an unset key had no
    // way to appear here at all. Asserting the value is a boolean, not
    // merely present, is what shows iOS now resolves the option rather than
    // merely echoing an empty object.
    name: 'unset option answered',
    pattern: /BUGSEE_E2E effective wifi-only-upload=(true|false)/,
    timeoutMs: 5_000,
  },
  {
    // That relaunch SETTLES is the assertion; what it resolves to is
    // secondary. iOS settles through the SDK's `started:` completion block,
    // so a path that never invokes it leaves the JS promise pending forever
    // -- indistinguishable from slowness, and invisible to every other check
    // in this repo. Android settles from its own callback.
    name: 'relaunch() settled',
    pattern: /BUGSEE_E2E relaunch\(\) settled (resolved|rejected)=/,
    // The bridge itself no longer times out (Task 3.7): it resolves straight
    // from the SDK's `started:` callback, which the fixed SDK is now
    // guaranteed to invoke. This step's own budget is generous headroom
    // against a genuinely slow device, not a second copy of a bridge-side
    // deadline -- a hang here means the callback never arrived at all.
    timeoutMs: 45_000,
  },
  {
    // relaunch stops and starts the SDK, so capture must come back up.
    // Read directly rather than waited for: relaunch completes in about
    // 10ms, so the 100ms status poll observes no change and logs nothing.
    name: 'Launched again after relaunch',
    pattern: /BUGSEE_E2E post-relaunch status=2/,
    timeoutMs: 20_000,
  },
];

// Task 3.P1: proof that the app launched the exact Android SDK build
// native-versions.json pins, not merely a version string that happens to
// match. iOS prints no such banner (3.P1's device workbook), so this step
// exists only for Android, inserted between the bundle starting and the SDK
// reaching Launched.
const ANDROID_SDK_BUILD_STEP: Step = {
  name: 'SDK build',
  pattern: /Bugsee Android SDK \S+ \[[0-9a-f]+\]/,
  timeoutMs: 15_000,
};

/**
 * This run's scenario really is the one the app ran: the app echoes the
 * nonce in its first marker. Without it, a launch could run whatever
 * scenario an earlier suite left behind -- the bundle Metro had not yet
 * rebuilt -- and pass for this one.
 */
function scenarioStep(nonce: string, endpoint?: string): Step {
  return {
    name: 'this run\'s scenario',
    pattern: new RegExp(
      `BUGSEE_E2E scenario=launch nonce=${nonce} ` +
        (endpoint === undefined ? '' : `.* endpoint=${escape(endpoint)}\r?$`),
    ),
    timeoutMs: 120_000,
  };
}

const STEPS: readonly Step[] =
  process.env.E2E_PLATFORM === 'android'
    ? [BASE_STEPS[0]!, ANDROID_SDK_BUILD_STEP, ...BASE_STEPS.slice(1)]
    : BASE_STEPS;

jest.setTimeout(STEPS.reduce((total, step) => total + step.timeoutMs, 180_000));

describe('example app on a real device', () => {
  it('reaches Status.Launched within 10s of the JS bundle running', async () => {
    const platform = platformUnderTest();
    // The app runs whatever e2e-scenario.json names; an interrupted
    // report-handler run can leave it on one of its own. A fresh nonce, so
    // the run can prove which one it got.
    //
    // iOS launches against the closed loopback endpoint (bundles.ts), as
    // every other iOS suite does. The e2e token is a placeholder; the real
    // server rejects it, and the iOS SDK then stores a stopped flag for the
    // token (`BugseeKilledSdkKey`) that refuses every later launch -- this
    // suite used to leave the app in that state for every suite after it.
    // What this test asserts (Launched, the options, relaunch settling) does
    // not need the server: the SDK reaches Launched offline.
    const extras = platform === 'ios' ? { endpoint: DEAD_ENDPOINT } : {};
    const scenario = writeScenario('launch', extras);
    let uri: string | undefined;
    let iosArgs: string[] = [];
    if (platform === 'android') {
      // The launch intent carries it: read at once, debug or release.
      uri = scenarioUri(scenario);
    } else {
      // The launch arguments carry it, and the endpoint (scenario.ts). The
      // simulator's app loads from Metro, which rebuilds a beat after the
      // JSON write: wait for it, so the bundle is this source's.
      iosArgs = scenarioArgs(scenario, extras);
      if (iosTarget() === 'simulator') {
        await awaitMetroServes(scenario.nonce);
      }
    }

    let result;
    try {
      result = await launchAndWaitForSequence(
        platform,
        [scenarioStep(scenario.nonce, extras.endpoint), ...STEPS],
        uri,
        iosArgs,
      );
    } finally {
      try {
        // The console attachment is gone; the app is not. Stop it, so
        // nothing of this run outlives the test.
        if (platform === 'ios') {
          await terminateIosApp();
        }
      } finally {
        resetScenario();
      }
    }
    const { steps, lines } = result;

    const failed = steps.find(step => step.matched === undefined);
    if (failed !== undefined) {
      throw new Error(
        `${platform}: never saw "${failed.name}".\n` +
          steps
            .map(
              step =>
                `  ${step.matched === undefined ? 'MISS' : `${step.elapsedMs}ms`}` +
                `\t${step.name}${step.matched ? `\t${step.matched.trim()}` : ''}`,
            )
            .join('\n') +
          `\nCaptured ${lines.length} log line(s):\n${lines.join('\n')}`,
      );
    }

    if (platform === 'android') {
      // Reads by eye it is not: the harness asserts the exact SDK build that
      // launched against the pin, rather than trusting a human glancing at
      // logcat.
      const sdkBuild = steps.find(step => step.name === 'SDK build')!;
      const bannerCheck = checkAndroidBanner(sdkBuild.matched!, readNativeVersions());
      if (!bannerCheck.ok) {
        throw new Error(`android: SDK build banner does not match the pin.\n  ${bannerCheck.reason}`);
      }
    }

    // The endpoint really was dead, and the SDK never held a stopped flag:
    // either would mean this run could poison, or was poisoned by, another.
    if (platform === 'ios') {
      expect(lines.filter(line => IOS_STOPPED_FOR_TOKEN.test(line))).toEqual([]);
      expect(lines.some(line => /Session not initialized\. - Could not connect to the server/.test(line))).toBe(true);
    }

    const launched = steps.find(step => step.name === 'Status.Launched')!;
    console.log(
      `${platform}: Status.Launched ${launched.elapsedMs}ms after the bundle ran\n` +
        `  ${launched.matched?.trim()}`,
    );
    expect(launched.matched).toMatch(/BUGSEE_E2E status=2/);
  });
});
