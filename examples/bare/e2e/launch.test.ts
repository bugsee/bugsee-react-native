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

/**
 * Two markers, two clocks.
 *
 * The first says the JS bundle is running, and is given a generous budget
 * because on a debug build it includes fetching the bundle from Metro. The
 * second is the one Task 1.5 is about, and starts counting only from there —
 * otherwise a cold bundler would fail a test about Bugsee.
 */
const STEPS: readonly Step[] = [
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
    // That relaunch SETTLES is the assertion; what it resolves to is
    // secondary. iOS settles through the SDK's `started:` completion block,
    // so a path that never invokes it leaves the JS promise pending forever
    // -- indistinguishable from slowness, and invisible to every other check
    // in this repo. Android settles from its own callback.
    name: 'relaunch() resolved',
    pattern: /BUGSEE_E2E relaunch\(\) resolved (true|false)/,
    timeoutMs: 20_000,
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

jest.setTimeout(STEPS.reduce((total, step) => total + step.timeoutMs, 60_000));

describe('example app on a real device', () => {
  it('reaches Status.Launched within 10s of the JS bundle running', async () => {
    const platform = platformUnderTest();

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

    const launched = steps[1]!;
    console.log(
      `${platform}: Status.Launched ${launched.elapsedMs}ms after the bundle ran\n` +
        `  ${launched.matched?.trim()}`,
    );
    expect(launched.matched).toMatch(/BUGSEE_E2E status=2/);
  });
});
