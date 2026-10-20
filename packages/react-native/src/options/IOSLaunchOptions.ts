import { BugseeLaunchOptions } from './BugseeLaunchOptions';
import type { CrashHandlerType } from './enums';
import { IOS_ENDPOINT_KEY, endpointFor } from './endpoint';

/** Launch options for iOS, adding the keys only that SDK accepts. */
export class IOSLaunchOptions extends BugseeLaunchOptions {
  /**
   * The API endpoint override.
   *
   * Reads back what the SDK will actually receive rather than what
   * was assigned, because the two differ on iOS.
   */
  get endpoint(): string | undefined {
    return this.$get(IOS_ENDPOINT_KEY);
  }
  set endpoint(value: string | undefined) {
    const payload = endpointFor('ios', value);
    this.$set(IOS_ENDPOINT_KEY, payload[IOS_ENDPOINT_KEY]);
  }

  get captureAVPlayer(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.avplayer');
  }
  set captureAVPlayer(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.avplayer', value);
  }

  /**
   * The fatal signals the crash reporter intercepts, as the iOS SDK's
   * `BugseeCrashSignals` bit set: ABRT 1, SEGV 2, BUS 4, ILL 8, FPE 16,
   * TRAP 32. Unset leaves the SDK default (every signal). Added in 7.0.0-beta7.
   */
  get crashSignals(): number | undefined {
    return this.$get('com.bugsee.option.capture.crash-signals');
  }
  set crashSignals(value: number | undefined) {
    this.$set('com.bugsee.option.capture.crash-signals', value);
  }

  /**
   * How the crash reporter intercepts crashes; see {@link CrashHandlerType}.
   * Unset leaves the SDK default, `CrashHandlerType.MachAndBSD`.
   */
  get crashHandlerType(): CrashHandlerType | undefined {
    return this.$get('com.bugsee.option.capture.crash-handler-type');
  }
  set crashHandlerType(value: CrashHandlerType | undefined) {
    this.$set('com.bugsee.option.capture.crash-handler-type', value);
  }

  get captureDiskSpace(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.disk-space');
  }
  set captureDiskSpace(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.disk-space', value);
  }
}
