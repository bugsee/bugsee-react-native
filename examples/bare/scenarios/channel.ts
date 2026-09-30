/**
 * The wrapper-channel scenario Task 3.5b drives on a device
 * (e2e/wrapper-channel.test.ts).
 *
 * `channel` sends one line through the wrapper channel before `launch()`,
 * which must not reach the bundle, and one after `Launched`, which the SDK
 * must capture as source `Custom` and which the test then finds in the
 * retained bundle's log file.
 *
 * Both platforms have a wrapper before this line. Android's init provider
 * registers one at process start, and iOS registers one at module init.
 * A channel therefore exists, and the SDK itself drops the line: nothing is
 * buffered before it is running.
 *
 * `forwardLog` is deep-imported from `@bugsee/react-native/src/wrapper/channel`
 * rather than from the package's public entry: Task 3.5a built the channel
 * seam ahead of Phase 4's `log()` and Phase 9's `console.*` routing, and the
 * function stays off the public surface until one of those lands.
 */
import Bugsee, { LogLevel } from '@bugsee/react-native';
import { forwardLog } from '@bugsee/react-native/src/wrapper/channel';

export const CHANNEL_SCENARIOS = ['channel'] as const;

export type ChannelScenario = (typeof CHANNEL_SCENARIOS)[number];

export function isChannelScenario(name: string): name is ChannelScenario {
  return (CHANNEL_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E channel ${message}`);
}

/**
 * Called before `launch()`. Sends the line the channel must drop, then marks
 * having sent it -- so the device e2e can assert the precondition it relies
 * on (that this really ran before `launch()`) rather than merely assume it
 * from source order.
 */
export function preLaunchChannelProbe(nonce: string): void {
  forwardLog(`pre-${nonce}`, LogLevel.Warning);
  mark(`pre-sent nonce=${nonce}`);
}

/** Called once the SDK reaches `Launched`. */
export function runChannelScenario(nonce: string): void {
  forwardLog(`BUGSEE_E2E channel ${nonce}`, LogLevel.Warning);
  mark(`sent nonce=${nonce}`);
  Bugsee.upload(`channel-${nonce}`, '');
}
