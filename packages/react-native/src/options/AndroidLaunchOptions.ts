import { BugseeLaunchOptions } from './BugseeLaunchOptions';
import { ANDROID_ENDPOINT_KEY, endpointFor } from './endpoint';

/** Launch options for Android, adding the keys only that SDK accepts. */
export class AndroidLaunchOptions extends BugseeLaunchOptions {
  /**
   * The API endpoint override.
   *
   * Reads back what the SDK will actually receive rather than what
   * was assigned, because the two differ on iOS.
   */
  get endpoint(): string | undefined {
    return this.$get(ANDROID_ENDPOINT_KEY);
  }
  set endpoint(value: string | undefined) {
    const payload = endpointFor('android', value);
    this.$set(ANDROID_ENDPOINT_KEY, payload[ANDROID_ENDPOINT_KEY]);
  }

  get videoMode(): number | undefined {
    return this.$get('com.bugsee.option.capture.video.mode');
  }
  set videoMode(value: number | undefined) {
    this.$set('com.bugsee.option.capture.video.mode', value);
  }

  get logsUseAllSources(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.logs.allsources');
  }
  set logsUseAllSources(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.logs.allsources', value);
  }

  get detectAndReportExitLowMemory(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.low_memory');
  }
  set detectAndReportExitLowMemory(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.low_memory', value);
  }

  get triggerByNotification(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.triggers.notification-bar');
  }
  set triggerByNotification(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.triggers.notification-bar', value);
  }
}
