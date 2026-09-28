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
import {
  launchAndWaitForSequence,
  platformUnderTest,
  type Step,
} from './device';
import { resetScenario } from './scenario';
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

const STEPS: readonly Step[] =
  process.env.E2E_PLATFORM === 'android'
    ? [BASE_STEPS[0]!, ANDROID_SDK_BUILD_STEP, ...BASE_STEPS.slice(1)]
    : BASE_STEPS;

jest.setTimeout(STEPS.reduce((total, step) => total + step.timeoutMs, 60_000));

describe('example app on a real device', () => {
  it('reaches Status.Launched within 10s of the JS bundle running', async () => {
    const platform = platformUnderTest();
    // The app runs whatever e2e-scenario.json names; an interrupted
    // report-handler run can leave it on one of its own.
    resetScenario();

    const { steps, lines } = await launchAndWaitForSequence(platform, STEPS);

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

    const launched = steps.find(step => step.name === 'Status.Launched')!;
    console.log(
      `${platform}: Status.Launched ${launched.elapsedMs}ms after the bundle ran\n` +
        `  ${launched.matched?.trim()}`,
    );
    expect(launched.matched).toMatch(/BUGSEE_E2E status=2/);
  });
});
