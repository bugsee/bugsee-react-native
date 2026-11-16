import type { FrameRate, IssueSeverity, LogLevel, VideoQuality } from './enums';

/**
 * Launch options, keyed by the SDKs' real 7.x option keys.
 *
 * Both platforms accept the same `com.bugsee.option.*` namespace in 7.x, so
 * there is no translation layer here and no per-platform key mapping — the map
 * IS the payload. That is what makes {@link BugseeLaunchOptions.setCustomOption}
 * genuinely useful: a custom key and a first-class accessor write to the same
 * namespace, so an option the wrapper has not surfaced yet, including one added
 * in a future 7.x patch, is reachable with no wrapper release.
 *
 * Subclasses add the accessors for their platform; see `AndroidLaunchOptions`
 * and `IOSLaunchOptions`.
 */
export abstract class BugseeLaunchOptions {
  /** Sent to the native SDK verbatim. */
  private readonly nativeOptions = new Map<string, unknown>();

  /**
   * JS-only settings for the wrapper's own components, kept in a separate map
   * so they cannot reach the native payload. The native SDK never agreed to
   * these keys; one arriving there is at best ignored and at worst rejects the
   * launch.
   */
  private readonly localOptions = new Map<string, unknown>();

  /**
   * What the SDK last said is in effect. Read by getters, never serialised:
   * sending these back would hand the SDK its own defaults as if the app had
   * chosen them.
   */
  private reportedOptions = new Map<string, unknown>();

  /**
   * Writes a native option. `undefined` **deletes** the key rather than
   * storing an empty value: the payload must not carry a key the caller meant
   * to leave alone, or the native side takes it as an explicit override of the
   * SDK's own default.
   */
  protected $set(key: string, value: unknown): void {
    if (value === undefined) {
      this.nativeOptions.delete(key);
      return;
    }
    this.nativeOptions.set(key, value);
  }

  /**
   * What the app set, or failing that what the SDK last reported.
   *
   * The wrapper hardcodes no defaults. The 6.x implementation did, and
   * drifted: it shipped `videoMode = V3` after 7.x removed that value. The
   * SDKs know their own defaults; Android reports them even before launch.
   */
  protected $get<T>(key: string): T | undefined {
    if (this.nativeOptions.has(key)) {
      return this.nativeOptions.get(key) as T;
    }
    return this.reportedOptions.get(key) as T | undefined;
  }

  /** Writes a JS-only option. `undefined` deletes, as with {@link $set}. */
  protected $setLocal(key: string, value: unknown): void {
    if (value === undefined) {
      this.localOptions.delete(key);
      return;
    }
    this.localOptions.set(key, value);
  }

  protected $getLocal<T>(key: string): T | undefined {
    return this.localOptions.get(key) as T | undefined;
  }

  // Accessors for options BOTH platforms accept. Platform-specific ones
  // live on the subclasses, so an iOS-only key is not reachable from an
  // Android options object.

  /**
   * Capture logs. Lines sent with `Bugsee.log()` are always recorded.
   */
  get captureLogs(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.logs');
  }
  set captureLogs(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.logs', value);
  }

  /**
   * Least severe level captured; see {@link LogLevel}. Also accepts a plain `number`, which this
   * accessor always took, so a level read from config still compiles.
   */
  get captureLogsLevel(): LogLevel | number | undefined {
    return this.$get('com.bugsee.option.capture.logs.level');
  }
  set captureLogsLevel(value: LogLevel | number | undefined) {
    this.$set('com.bugsee.option.capture.logs.level', value);
  }

  /**
   * Capture network events.
   */
  get captureNetwork(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.network');
  }
  set captureNetwork(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.network', value);
  }

  /**
   * Largest request or response body captured, in bytes.
   */
  get captureNetworkBodySizeLimit(): number | undefined {
    return this.$get('com.bugsee.option.capture.network.body-size-limit');
  }
  set captureNetworkBodySizeLimit(value: number | undefined) {
    this.$set('com.bugsee.option.capture.network.body-size-limit', value);
  }

  /**
   * Also capture bodies that declare no content type. Off keeps only textual bodies.
   */
  get captureNetworkBodyWithoutType(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.network.body-without-type');
  }
  set captureNetworkBodyWithoutType(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.network.body-without-type', value);
  }

  /**
   * Redact known-sensitive values (query parameters, headers, JSON bodies) when no network filter is set.
   */
  get captureNetworkUseDefaultSanitizer(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.network.default-sanitizer');
  }
  set captureNetworkUseDefaultSanitizer(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.network.default-sanitizer', value);
  }

  /**
   * Subscribe network capture synchronously during launch, so requests issued in the launch window are seen.
   */
  get captureNetworkOnLaunch(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.network.on-launch');
  }
  set captureNetworkOnLaunch(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.network.on-launch', value);
  }

  /**
   * Capture breadcrumbs (user and system events).
   */
  get captureBreadcrumbs(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.breadcrumbs');
  }
  set captureBreadcrumbs(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.breadcrumbs', value);
  }

  /**
   * Attach the extra detail of automatically collected device-event breadcrumbs.
   */
  get captureBreadcrumbsExtras(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.breadcrumbs.extras');
  }
  set captureBreadcrumbsExtras(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.breadcrumbs.extras', value);
  }

  /**
   * Capture screenshots for reports, independent of video.
   */
  get captureScreenshot(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.screenshot');
  }
  set captureScreenshot(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.screenshot', value);
  }

  /**
   * Privacy scaling applied to screenshots; below `1` removes fine detail such as text.
   */
  get captureScreenshotScale(): number | undefined {
    return this.$get('com.bugsee.option.capture.screenshot.scale');
  }
  set captureScreenshotScale(value: number | undefined) {
    this.$set('com.bugsee.option.capture.screenshot.scale', value);
  }

  /**
   * Record video for reports.
   */
  get captureVideo(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.video');
  }
  set captureVideo(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.video', value);
  }

  /**
   * Skip capture work while the screen is idle. The SDKs' own defaults differ.
   */
  get captureVideoAdaptive(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.video.adaptive');
  }
  set captureVideoAdaptive(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.video.adaptive', value);
  }

  /**
   * How often frames are captured; see {@link FrameRate}.
   */
  get captureVideoFrameRate(): FrameRate | undefined {
    return this.$get('com.bugsee.option.capture.video.frame-rate');
  }
  set captureVideoFrameRate(value: FrameRate | undefined) {
    this.$set('com.bugsee.option.capture.video.frame-rate', value);
  }

  /**
   * Quality of the encoded video; see {@link VideoQuality}.
   */
  get captureVideoQuality(): VideoQuality | undefined {
    return this.$get('com.bugsee.option.capture.video.quality');
  }
  set captureVideoQuality(value: VideoQuality | undefined) {
    this.$set('com.bugsee.option.capture.video.quality', value);
  }

  /**
   * Extra down-scaling of recorded video; `0.5` halves width and height.
   */
  get captureVideoScale(): number | undefined {
    return this.$get('com.bugsee.option.capture.video.scale');
  }
  set captureVideoScale(value: number | undefined) {
    this.$set('com.bugsee.option.capture.video.scale', value);
  }

  /**
   * Capture the view hierarchy for reports.
   */
  get captureViewHierarchy(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.view-hierarchy');
  }
  set captureViewHierarchy(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.view-hierarchy', value);
  }

  /**
   * Inject the advanced WebView SDK into instrumented WebViews for full-fidelity in-page capture.
   */
  get captureWebViewAdvanced(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.webview.advanced');
  }
  set captureWebViewAdvanced(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.webview.advanced', value);
  }

  /**
   * Let an incident raised inside an instrumented WebView open a native bug report.
   */
  get captureWebViewReportTrigger(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.webview.report-trigger');
  }
  set captureWebViewReportTrigger(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.webview.report-trigger', value);
  }

  /**
   * Seconds of history a report carries.
   */
  get duration(): number | undefined {
    return this.$get('com.bugsee.option.config.duration');
  }
  set duration(value: number | undefined) {
    this.$set('com.bugsee.option.config.duration', value);
  }

  /**
   * Disk space, in megabytes, that reports waiting to be sent may occupy. Past it the
   * oldest reports are deleted whole.
   */
  get maxDataSize(): number | undefined {
    return this.$get('com.bugsee.option.config.max-data-size');
  }
  set maxDataSize(value: number | undefined) {
    this.$set('com.bugsee.option.config.max-data-size', value);
  }

  /**
   * Most reports kept waiting to be sent. Android 7.3.0, iOS 7.0.0.
   */
  get maxPendingReports(): number | undefined {
    return this.$get('com.bugsee.option.config.max-pending-reports');
  }
  set maxPendingReports(value: number | undefined) {
    this.$set('com.bugsee.option.config.max-pending-reports', value);
  }

  /**
   * Oldest a report waiting to be sent may get, in days; `0` or less keeps reports until
   * they are sent or evicted. Android 7.3.0, iOS 7.0.0.
   */
  get maxPendingReportAge(): number | undefined {
    return this.$get('com.bugsee.option.config.max-pending-report-age');
  }
  set maxPendingReportAge(value: number | undefined) {
    this.$set('com.bugsee.option.config.max-pending-report-age', value);
  }

  /**
   * Coalesce window, in milliseconds, before `Bugsee.notify` uploads flush; `0` posts as soon as the item is on disk.
   */
  get notifyFlushDelay(): number | undefined {
    return this.$get('com.bugsee.option.config.notify-flush-delay');
  }
  set notifyFlushDelay(value: number | undefined) {
    this.$set('com.bugsee.option.config.notify-flush-delay', value);
  }

  /**
   * Upload only over Wi-Fi.
   */
  get wifiOnlyUpload(): boolean | undefined {
    return this.$get('com.bugsee.option.config.wifi-only-upload');
  }
  set wifiOnlyUpload(value: boolean | undefined) {
    this.$set('com.bugsee.option.config.wifi-only-upload', value);
  }

  /**
   * Detect and report performance anomalies.
   */
  get detectAndReportAnomaly(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.anomaly');
  }
  set detectAndReportAnomaly(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.anomaly', value);
  }

  /**
   * Detect and report crashes.
   */
  get detectAndReportCrash(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.crash');
  }
  set detectAndReportCrash(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.crash', value);
  }

  /**
   * Recover crashes that happen during app start-up.
   */
  get detectAndReportEarlyCrash(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.early-crash');
  }
  set detectAndReportEarlyCrash(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.early-crash', value);
  }

  /**
   * Detect and report app exits.
   */
  get detectAndReportExit(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.exit');
  }
  set detectAndReportExit(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.exit', value);
  }

  /**
   * Detect and report user-frustration patterns such as rage taps.
   */
  get detectFrustration(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.frustration');
  }
  set detectFrustration(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.frustration', value);
  }

  /**
   * Detect and report hangs.
   */
  get detectAndReportHang(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.hang');
  }
  set detectAndReportHang(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.hang', value);
  }

  /**
   * Main-thread block, in milliseconds, that raises a "fair" hang. Less than the medium level.
   */
  get detectAndReportHangFairLevel(): number | undefined {
    return this.$get('com.bugsee.option.detect.hang.level.fair');
  }
  set detectAndReportHangFairLevel(value: number | undefined) {
    this.$set('com.bugsee.option.detect.hang.level.fair', value);
  }

  /**
   * Main-thread block, in milliseconds, that raises a "medium" hang.
   */
  get detectAndReportHangMediumLevel(): number | undefined {
    return this.$get('com.bugsee.option.detect.hang.level.medium');
  }
  set detectAndReportHangMediumLevel(value: number | undefined) {
    this.$set('com.bugsee.option.detect.hang.level.medium', value);
  }

  /**
   * Main-thread block, in milliseconds, that raises a "severe" hang. Greater than the medium level.
   */
  get detectAndReportHangSevereLevel(): number | undefined {
    return this.$get('com.bugsee.option.detect.hang.level.severe');
  }
  set detectAndReportHangSevereLevel(value: number | undefined) {
    this.$set('com.bugsee.option.detect.hang.level.severe', value);
  }

  /**
   * Turn HTTP 5xx responses into error reports.
   */
  get detectAndReportHttpErrors(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.http-errors');
  }
  set detectAndReportHttpErrors(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.http-errors', value);
  }

  /**
   * Detect and report blocking work on the main thread.
   */
  get detectAndReportMainThreadMisuse(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.main_thread_misuse');
  }
  set detectAndReportMainThreadMisuse(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.main_thread_misuse', value);
  }

  /**
   * Promote "interesting" transactions that lost the random sampling draw.
   */
  get performanceAdaptiveSampling(): boolean | undefined {
    return this.$get('com.bugsee.option.performance.adaptive-sampling');
  }
  set performanceAdaptiveSampling(value: boolean | undefined) {
    this.$set('com.bugsee.option.performance.adaptive-sampling', value);
  }

  /**
   * Enable performance monitoring (APM).
   */
  get performanceMonitoring(): boolean | undefined {
    return this.$get('com.bugsee.option.performance.enabled');
  }
  set performanceMonitoring(value: boolean | undefined) {
    this.$set('com.bugsee.option.performance.enabled', value);
  }

  /**
   * Probability, `0` to `1`, that a transaction is sampled.
   */
  get performanceSampleRate(): number | undefined {
    return this.$get('com.bugsee.option.performance.sample-rate');
  }
  set performanceSampleRate(value: number | undefined) {
    this.$set('com.bugsee.option.performance.sample-rate', value);
  }

  /**
   * Default priority of bug reports; see {@link IssueSeverity}.
   */
  get reportingDefaultBugPriority(): IssueSeverity | undefined {
    return this.$get('com.bugsee.option.reporting.defaults.bug-priority');
  }
  set reportingDefaultBugPriority(value: IssueSeverity | undefined) {
    this.$set('com.bugsee.option.reporting.defaults.bug-priority', value);
  }

  /**
   * Default priority of crash reports; see {@link IssueSeverity}.
   */
  get reportingDefaultCrashPriority(): IssueSeverity | undefined {
    return this.$get('com.bugsee.option.reporting.defaults.crash-priority');
  }
  set reportingDefaultCrashPriority(value: IssueSeverity | undefined) {
    this.$set('com.bugsee.option.reporting.defaults.crash-priority', value);
  }

  /**
   * Default priority of error reports; see {@link IssueSeverity}.
   */
  get reportingDefaultErrorPriority(): IssueSeverity | undefined {
    return this.$get('com.bugsee.option.reporting.defaults.error-priority');
  }
  set reportingDefaultErrorPriority(value: IssueSeverity | undefined) {
    this.$set('com.bugsee.option.reporting.defaults.error-priority', value);
  }

  /**
   * Let the user open the report dialog by shaking the device. **The SDK default is on:**
   * set this to `false` to turn shake-to-report off.
   */
  get triggerByShake(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.triggers.shake');
  }
  set triggerByShake(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.triggers.shake', value);
  }

  /**
   * Let the user open the report dialog by taking a screenshot.
   */
  get triggerByScreenshot(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.triggers.screenshot');
  }
  set triggerByScreenshot(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.triggers.screenshot', value);
  }

  /**
   * Make the Description field mandatory in the report dialog.
   */
  get reportingUIDescriptionRequired(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.ui.description-required');
  }
  set reportingUIDescriptionRequired(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.ui.description-required', value);
  }

  /**
   * Make the Email field mandatory in the report dialog.
   */
  get reportingUIEmailRequired(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.ui.email-required');
  }
  set reportingUIEmailRequired(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.ui.email-required', value);
  }

  /**
   * Show the Labels field in the report dialog.
   */
  get reportingUILabelsEnabled(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.ui.labels-enabled');
  }
  set reportingUILabelsEnabled(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.ui.labels-enabled', value);
  }

  /**
   * Make the Labels field mandatory in the report dialog.
   */
  get reportingUILabelsRequired(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.ui.labels-required');
  }
  set reportingUILabelsRequired(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.ui.labels-required', value);
  }

  /**
   * Let the user change the priority in the report dialog.
   */
  get reportingUIPrioritySelectorEnabled(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.ui.priority-selector-enabled');
  }
  set reportingUIPrioritySelectorEnabled(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.ui.priority-selector-enabled', value);
  }

  /**
   * Make the Summary field mandatory in the report dialog.
   */
  get reportingUISummaryRequired(): boolean | undefined {
    return this.$get('com.bugsee.option.reporting.ui.summary-required');
  }
  set reportingUISummaryRequired(value: boolean | undefined) {
    this.$set('com.bugsee.option.reporting.ui.summary-required', value);
  }

  /**
   * Sets any option by its real `com.bugsee.option.*` key, surfaced or not.
   * `undefined` deletes, exactly as a first-class accessor does.
   */
  setCustomOption(key: string, value: unknown): void {
    this.$set(key, value);
  }

  /**
   * The native payload: a plain object, snapshotted. Callers hold on to the
   * result, so handing back a live view of the map would let a later write
   * change a payload that was already sent.
   */
  static serialize(options: BugseeLaunchOptions): Record<string, unknown> {
    return Object.fromEntries(options.nativeOptions);
  }

  /**
   * Installs the set the SDK reports as being in effect, replacing any
   * previous report rather than merging — a merge would keep answering with
   * an option the SDK has since stopped applying.
   */
  static refreshFrom(
    options: BugseeLaunchOptions,
    reported: Record<string, unknown>,
  ): void {
    if (reported === null || typeof reported !== 'object') {
      return;
    }
    options.reportedOptions = new Map(Object.entries(reported));
  }

  /** The JS-only settings, handed to the wrapper's components separately. */
  static localSettings(options: BugseeLaunchOptions): Record<string, unknown> {
    return Object.fromEntries(options.localOptions);
  }
}
