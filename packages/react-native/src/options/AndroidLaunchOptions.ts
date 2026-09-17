import { BugseeLaunchOptions } from './BugseeLaunchOptions';

/** Launch options for Android, adding the keys only that SDK accepts. */
export class AndroidLaunchOptions extends BugseeLaunchOptions {
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
