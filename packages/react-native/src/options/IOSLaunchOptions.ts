import { BugseeLaunchOptions } from './BugseeLaunchOptions';

/** Launch options for iOS, adding the keys only that SDK accepts. */
export class IOSLaunchOptions extends BugseeLaunchOptions {
  get captureAVPlayer(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.avplayer');
  }
  set captureAVPlayer(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.avplayer', value);
  }

  get captureMachExceptions(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.mach-exceptions');
  }
  set captureMachExceptions(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.mach-exceptions', value);
  }

  get captureDiskSpace(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.disk-space');
  }
  set captureDiskSpace(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.disk-space', value);
  }

  get detectAndReportKill(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.kill');
  }
  set detectAndReportKill(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.kill', value);
  }

  get maxDataSize(): number | undefined {
    return this.$get('com.bugsee.option.config.max-data-size');
  }
  set maxDataSize(value: number | undefined) {
    this.$set('com.bugsee.option.config.max-data-size', value);
  }
}
