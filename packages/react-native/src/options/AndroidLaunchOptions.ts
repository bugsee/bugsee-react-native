import { BugseeLaunchOptions } from './BugseeLaunchOptions';
import type { MemoryLeakMode, VideoMode } from './enums';
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

  /**
   * Query every logging source (system, radio, ...) rather than only the default ones.
   */
  get logsUseAllSources(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.logs.allsources');
  }
  set logsUseAllSources(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.logs.allsources', value);
  }

  /**
   * Honour `FLAG_SECURE`: blank secure windows in capture and treat such an activity as a full blackout.
   */
  get captureRespectFlagSecure(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.respect-flag-secure');
  }
  set captureRespectFlagSecure(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.respect-flag-secure', value);
  }

  /**
   * Use a lightweight MP4 muxer instead of `MediaMuxer`.
   */
  get captureVideoUsingCustomMuxer(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.video.custom-muxer');
  }
  set captureVideoUsingCustomMuxer(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.video.custom-muxer', value);
  }

  /**
   * Keep fullscreen (MediaProjection) capture running while the app is in the background.
   */
  get captureVideoFullscreenKeepRunning(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.video.fullscreen-keep-running');
  }
  set captureVideoFullscreenKeepRunning(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.video.fullscreen-keep-running', value);
  }

  /**
   * Remember the user's screen-capture consent decision across launches.
   */
  get captureVideoFullscreenRememberUserDecision(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.video.fullscreen-remember-decision');
  }
  set captureVideoFullscreenRememberUserDecision(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.video.fullscreen-remember-decision', value);
  }

  /**
   * Screen-capture mode; see {@link VideoMode}. Also accepts a plain `number`, which this accessor
   * always took, so a value read from config still compiles.
   */
  get videoMode(): VideoMode | number | undefined {
    return this.$get('com.bugsee.option.capture.video.mode');
  }
  set videoMode(value: VideoMode | number | undefined) {
    this.$set('com.bugsee.option.capture.video.mode', value);
  }

  /**
   * In `VideoMode.V1`, skip more frames while secure views are on screen.
   */
  get captureVideoSecureScrolling(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.video.secure-scrolling');
  }
  set captureVideoSecureScrolling(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.video.secure-scrolling', value);
  }

  /**
   * Has no effect: the SDK no longer scopes WebView capture by domain.
   *
   * @deprecated Android 7.1.2 deprecated this option and the SDK does not honour it.
   */
  get captureWebViewDomainAllowlist(): string | undefined {
    return this.$get('com.bugsee.option.capture.webview.domain-allowlist');
  }
  set captureWebViewDomainAllowlist(value: string | undefined) {
    this.$set('com.bugsee.option.capture.webview.domain-allowlist', value);
  }

  /**
   * Seconds before a report handler's completion callback is auto-fired; `0` disables the timeout.
   */
  get reportHandlerCallbackTimeout(): number | undefined {
    return this.$get('com.bugsee.option.config.report-handler-callback-timeout');
  }
  set reportHandlerCallbackTimeout(value: number | undefined) {
    this.$set('com.bugsee.option.config.report-handler-callback-timeout', value);
  }

  /**
   * Export and upload reports in-process on background threads instead of through JobScheduler.
   */
  get reportProcessingInProcess(): boolean | undefined {
    return this.$get('com.bugsee.option.config.report-processing-in-process');
  }
  set reportProcessingInProcess(value: boolean | undefined) {
    this.$set('com.bugsee.option.config.report-processing-in-process', value);
  }

  /**
   * Sample the main thread during an ANR to attribute the report to culprit frames.
   */
  get detectAndReportAnrSampling(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.anr.sampling');
  }
  set detectAndReportAnrSampling(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.anr.sampling', value);
  }

  /**
   * Report a low-memory kill of a process that was not in the foreground as a non-fatal error rather than a
   * crash. Applies only while {@link detectAndReportExitLowMemory} is on. Android 7.3.0.
   */
  get detectAndReportExitLowMemoryBackgroundAsError(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.bg_low_memory_as_error');
  }
  set detectAndReportExitLowMemoryBackgroundAsError(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.bg_low_memory_as_error', value);
  }

  /**
   * Report exits caused by a dependency process dying.
   */
  get detectAndReportExitDependencyDied(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.dependency_died');
  }
  set detectAndReportExitDependencyDied(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.dependency_died', value);
  }

  /**
   * Report exits caused by excessive resource usage.
   */
  get detectAndReportExitExcessiveResourceUsage(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.excessive_resource_usage');
  }
  set detectAndReportExitExcessiveResourceUsage(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.excessive_resource_usage', value);
  }

  /**
   * Report exits caused by low memory (the OOM killer).
   */
  get detectAndReportExitLowMemory(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.low_memory');
  }
  set detectAndReportExitLowMemory(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.low_memory', value);
  }

  /**
   * Report exits caused by the app not responding (ANR).
   */
  get detectAndReportExitNotResponding(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.not_responding');
  }
  set detectAndReportExitNotResponding(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.not_responding', value);
  }

  /**
   * Report ANR exits as crashes instead of non-fatal errors.
   */
  get detectAndReportExitNotRespondingAsCrash(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.not_responding.as_crash');
  }
  set detectAndReportExitNotRespondingAsCrash(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.not_responding.as_crash', value);
  }

  /**
   * Report exits with an "other" reason.
   */
  get detectAndReportExitOther(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.other');
  }
  set detectAndReportExitOther(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.other', value);
  }

  /**
   * Report exits caused by a package state change.
   */
  get detectAndReportExitPackageStateChanged(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.package_state_changed');
  }
  set detectAndReportExitPackageStateChanged(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.package_state_changed', value);
  }

  /**
   * Report exits caused by a package update.
   */
  get detectAndReportExitPackageUpdated(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.package_updated');
  }
  set detectAndReportExitPackageUpdated(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.package_updated', value);
  }

  /**
   * Report exits caused by a runtime permission change.
   */
  get detectAndReportExitPermissionChanged(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.permission_changed');
  }
  set detectAndReportExitPermissionChanged(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.permission_changed', value);
  }

  /**
   * Report exits with an unknown reason.
   */
  get detectAndReportExitUnknown(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.unknown');
  }
  set detectAndReportExitUnknown(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.unknown', value);
  }

  /**
   * Report exits the user requested, such as a force stop.
   */
  get detectAndReportExitUserRequested(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.user_requested');
  }
  set detectAndReportExitUserRequested(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.user_requested', value);
  }

  /**
   * Report exits caused by the system stopping the app.
   */
  get detectAndReportExitUserWasStopped(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit.user_was_stopped');
  }
  set detectAndReportExitUserWasStopped(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit.user_was_stopped', value);
  }

  /**
   * Sample the main thread during a hang to attribute the report to culprit frames. Needs {@link detectAndReportHang}.
   */
  get detectAndReportHangSampling(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.hang.sampling');
  }
  set detectAndReportHangSampling(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.hang.sampling', value);
  }

  /**
   * Upload mode for performance data: `'batched'` or `'realtime'`.
   */
  get performanceUploadMode(): string | undefined {
    return this.$get('com.bugsee.option.performance.upload-mode');
  }
  set performanceUploadMode(value: string | undefined) {
    this.$set('com.bugsee.option.performance.upload-mode', value);
  }

  /**
   * Let a broadcast open the report dialog.
   */
  get triggerByBroadcast(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.triggers.broadcast');
  }
  set triggerByBroadcast(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.triggers.broadcast', value);
  }

  /**
   * Let the user open the report dialog from the notification bar. The SDK default is off (Android 7.6.0; on before).
   */
  get triggerByNotification(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.triggers.notification-bar');
  }
  set triggerByNotification(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.triggers.notification-bar', value);
  }

  /**
   * Detect native (NDK) crashes. Needs {@link detectAndReportCrash}; this package bundles the NDK module.
   */
  get detectAndReportNdkCrash(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.crash-ndk');
  }
  set detectAndReportNdkCrash(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.crash-ndk', value);
  }

  /**
   * Attach the Android tombstone logs to NDK crash reports.
   */
  get ndkIncludeTombstoneLogs(): boolean | undefined {
    return this.$get('com.bugsee.option.crash-ndk.tombstone-logs');
  }
  set ndkIncludeTombstoneLogs(value: boolean | undefined) {
    this.$set('com.bugsee.option.crash-ndk.tombstone-logs', value);
  }

  /**
   * Detect memory leaks. Honoured only when the app also depends on `com.bugsee:bugsee-android-leak`, which this package does not add.
   */
  get detectMemoryLeaks(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.memory_leaks');
  }
  set detectMemoryLeaks(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.memory_leaks', value);
  }

  /**
   * Leak detection depth; see {@link MemoryLeakMode}. Needs `bugsee-android-leak`.
   */
  get detectMemoryLeaksMode(): MemoryLeakMode | undefined {
    return this.$get('com.bugsee.option.detect.memory_leaks.mode');
  }
  set detectMemoryLeaksMode(value: MemoryLeakMode | undefined) {
    this.$set('com.bugsee.option.detect.memory_leaks.mode', value);
  }

  /**
   * Fraction of sessions that run the deep leak modes. Needs `bugsee-android-leak`.
   */
  get detectMemoryLeaksDeepSampleRate(): number | undefined {
    return this.$get('com.bugsee.option.detect.memory_leaks.deep_sample_rate');
  }
  set detectMemoryLeaksDeepSampleRate(value: number | undefined) {
    this.$set('com.bugsee.option.detect.memory_leaks.deep_sample_rate', value);
  }

  /**
   * Detect thread leaks. Needs `bugsee-android-leak`.
   */
  get detectThreadLeaks(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.thread_leaks');
  }
  set detectThreadLeaks(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.thread_leaks', value);
  }
}
