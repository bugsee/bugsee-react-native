import { BugseeLaunchOptions } from '../BugseeLaunchOptions';
import { AndroidLaunchOptions } from '../AndroidLaunchOptions';
import { IOSLaunchOptions } from '../IOSLaunchOptions';
import { ANDROID_ONLY_KEYS, IOS_ONLY_KEYS, SHARED_KEYS } from '../keys';

/**
 * The accessor-to-key contract, written out rather than derived.
 *
 * Deriving it from the implementation would assert nothing: a typo in a key
 * would appear on both sides and pass. A wrong key is silent -- the option
 * simply never reaches the SDK, and the SDK applies its default -- so this is
 * the only thing that catches it.
 */
const SHARED: [string, string, unknown][] = [
  ['captureLogs', 'com.bugsee.option.capture.logs', false],
  ['crashSignals', 'com.bugsee.option.capture.crash-signals', 7],
  ['captureLogsLevel', 'com.bugsee.option.capture.logs.level', 2],
  ['captureNetwork', 'com.bugsee.option.capture.network', false],
  ['captureNetworkBodySizeLimit', 'com.bugsee.option.capture.network.body-size-limit', 7],
  ['captureNetworkBodyWithoutType', 'com.bugsee.option.capture.network.body-without-type', false],
  ['captureNetworkUseDefaultSanitizer', 'com.bugsee.option.capture.network.default-sanitizer', false],
  ['captureNetworkOnLaunch', 'com.bugsee.option.capture.network.on-launch', false],
  ['captureBreadcrumbs', 'com.bugsee.option.capture.breadcrumbs', false],
  ['captureBreadcrumbsExtras', 'com.bugsee.option.capture.breadcrumbs.extras', false],
  ['captureScreenshot', 'com.bugsee.option.capture.screenshot', false],
  ['captureScreenshotScale', 'com.bugsee.option.capture.screenshot.scale', 0.5],
  ['captureVideo', 'com.bugsee.option.capture.video', false],
  ['captureVideoAdaptive', 'com.bugsee.option.capture.video.adaptive', false],
  ['captureVideoFrameRate', 'com.bugsee.option.capture.video.frame-rate', 2],
  ['captureVideoQuality', 'com.bugsee.option.capture.video.quality', 1],
  ['captureVideoScale', 'com.bugsee.option.capture.video.scale', 0.5],
  ['captureViewHierarchy', 'com.bugsee.option.capture.view-hierarchy', false],
  ['captureWebViewAdvanced', 'com.bugsee.option.capture.webview.advanced', false],
  ['captureWebViewReportTrigger', 'com.bugsee.option.capture.webview.report-trigger', false],
  ['duration', 'com.bugsee.option.config.duration', 7],
  ['maxDataSize', 'com.bugsee.option.config.max-data-size', 7],
  ['maxPendingReports', 'com.bugsee.option.config.max-pending-reports', 7],
  ['maxPendingReportAge', 'com.bugsee.option.config.max-pending-report-age', 7],
  ['notifyFlushDelay', 'com.bugsee.option.config.notify-flush-delay', 7],
  ['wifiOnlyUpload', 'com.bugsee.option.config.wifi-only-upload', false],
  ['detectAndReportAnomaly', 'com.bugsee.option.detect.anomaly', false],
  ['detectAndReportCrash', 'com.bugsee.option.detect.crash', false],
  ['detectAndReportEarlyCrash', 'com.bugsee.option.detect.early-crash', false],
  ['detectAndReportExit', 'com.bugsee.option.detect.exit', false],
  ['detectFrustration', 'com.bugsee.option.detect.frustration', false],
  ['detectAndReportHang', 'com.bugsee.option.detect.hang', false],
  ['detectAndReportHangFairLevel', 'com.bugsee.option.detect.hang.level.fair', 7],
  ['detectAndReportHangMediumLevel', 'com.bugsee.option.detect.hang.level.medium', 7],
  ['detectAndReportHangSevereLevel', 'com.bugsee.option.detect.hang.level.severe', 7],
  ['detectAndReportHttpErrors', 'com.bugsee.option.detect.http-errors', false],
  ['detectAndReportMainThreadMisuse', 'com.bugsee.option.detect.main_thread_misuse', false],
  ['performanceAdaptiveSampling', 'com.bugsee.option.performance.adaptive-sampling', false],
  ['performanceMonitoring', 'com.bugsee.option.performance.enabled', false],
  ['performanceSampleRate', 'com.bugsee.option.performance.sample-rate', 0.5],
  ['reportingDefaultBugPriority', 'com.bugsee.option.reporting.defaults.bug-priority', 4],
  ['reportingDefaultCrashPriority', 'com.bugsee.option.reporting.defaults.crash-priority', 4],
  ['reportingDefaultErrorPriority', 'com.bugsee.option.reporting.defaults.error-priority', 4],
  ['triggerByShake', 'com.bugsee.option.reporting.triggers.shake', false],
  ['triggerByScreenshot', 'com.bugsee.option.reporting.triggers.screenshot', false],
  ['reportingUIDescriptionRequired', 'com.bugsee.option.reporting.ui.description-required', false],
  ['reportingUIEmailRequired', 'com.bugsee.option.reporting.ui.email-required', false],
  ['reportingUILabelsEnabled', 'com.bugsee.option.reporting.ui.labels-enabled', false],
  ['reportingUILabelsRequired', 'com.bugsee.option.reporting.ui.labels-required', false],
  ['reportingUIPrioritySelectorEnabled', 'com.bugsee.option.reporting.ui.priority-selector-enabled', false],
  ['reportingUISummaryRequired', 'com.bugsee.option.reporting.ui.summary-required', false],
];

const IOS: [string, string, unknown][] = [
  ['captureAVPlayer', 'com.bugsee.option.capture.avplayer', false],
  ['captureBluetoothStatus', 'com.bugsee.option.capture.bluetooth-status', false],
  ['captureCameraPreview', 'com.bugsee.option.capture.camera-preview', false],
  ['crashHandlerType', 'com.bugsee.option.capture.crash-handler-type', 2],
  ['captureDeviceAndNetworkNames', 'com.bugsee.option.capture.device-network-names', false],
  ['captureDiskSpace', 'com.bugsee.option.capture.disk-space', false],
  ['captureOSLogs', 'com.bugsee.option.capture.logs.oslog', false],
  ['captureOnDeviceSymbolication', 'com.bugsee.option.capture.on-device-symbolication', false],
  ['captureSampleBufferDisplayLayer', 'com.bugsee.option.capture.sample-buffer-display-layer', false],
  ['captureStatusBarInfo', 'com.bugsee.option.capture.status-bar-info', false],
  ['captureVideoMaxFramerate', 'com.bugsee.option.capture.video.max-frame-rate', 7],
  ['captureVideoMinFramerate', 'com.bugsee.option.capture.video.min-frame-rate', 7],
  ['captureVideoPrivacyBlur', 'com.bugsee.option.capture.video.privacy-blur', false],
  ['captureWebSocket', 'com.bugsee.option.capture.websocket', false],
  ['buildTarget', 'com.bugsee.option.config.build-target', 'probe'],
  ['buildType', 'com.bugsee.option.config.build-type', 'probe'],
  ['detectCrashFillEmptyExceptionStacks', 'com.bugsee.option.detect.crash.fill_empty_exception_stacks', false],
  ['detectCrashSwiftAsyncStackTraces', 'com.bugsee.option.detect.crash.swift_async_stacktraces', false],
  ['reportingUIStyle', 'com.bugsee.option.reporting.ui.style', 1],
];

const ANDROID: [string, string, unknown][] = [
  ['logsUseAllSources', 'com.bugsee.option.capture.logs.allsources', false],
  ['captureRespectFlagSecure', 'com.bugsee.option.capture.respect-flag-secure', false],
  ['captureVideoUsingCustomMuxer', 'com.bugsee.option.capture.video.custom-muxer', false],
  ['captureVideoFullscreenKeepRunning', 'com.bugsee.option.capture.video.fullscreen-keep-running', false],
  ['captureVideoFullscreenRememberUserDecision', 'com.bugsee.option.capture.video.fullscreen-remember-decision', false],
  ['videoMode', 'com.bugsee.option.capture.video.mode', 20],
  ['captureVideoSecureScrolling', 'com.bugsee.option.capture.video.secure-scrolling', false],
  ['captureWebViewDomainAllowlist', 'com.bugsee.option.capture.webview.domain-allowlist', 'probe'],
  ['reportHandlerCallbackTimeout', 'com.bugsee.option.config.report-handler-callback-timeout', 7],
  ['reportProcessingInProcess', 'com.bugsee.option.config.report-processing-in-process', false],
  ['detectAndReportAnrSampling', 'com.bugsee.option.detect.anr.sampling', false],
  ['detectAndReportExitLowMemoryBackgroundAsError', 'com.bugsee.option.detect.exit.bg_low_memory_as_error', false],
  ['detectAndReportExitDependencyDied', 'com.bugsee.option.detect.exit.dependency_died', false],
  ['detectAndReportExitExcessiveResourceUsage', 'com.bugsee.option.detect.exit.excessive_resource_usage', false],
  ['detectAndReportExitLowMemory', 'com.bugsee.option.detect.exit.low_memory', false],
  ['detectAndReportExitNotResponding', 'com.bugsee.option.detect.exit.not_responding', false],
  ['detectAndReportExitNotRespondingAsCrash', 'com.bugsee.option.detect.exit.not_responding.as_crash', false],
  ['detectAndReportExitOther', 'com.bugsee.option.detect.exit.other', false],
  ['detectAndReportExitPackageStateChanged', 'com.bugsee.option.detect.exit.package_state_changed', false],
  ['detectAndReportExitPackageUpdated', 'com.bugsee.option.detect.exit.package_updated', false],
  ['detectAndReportExitPermissionChanged', 'com.bugsee.option.detect.exit.permission_changed', false],
  ['detectAndReportExitUnknown', 'com.bugsee.option.detect.exit.unknown', false],
  ['detectAndReportExitUserRequested', 'com.bugsee.option.detect.exit.user_requested', false],
  ['detectAndReportExitUserWasStopped', 'com.bugsee.option.detect.exit.user_was_stopped', false],
  ['detectAndReportHangSampling', 'com.bugsee.option.detect.hang.sampling', false],
  ['performanceUploadMode', 'com.bugsee.option.performance.upload-mode', 'realtime'],
  ['triggerByBroadcast', 'com.bugsee.option.reporting.triggers.broadcast', false],
  ['triggerByNotification', 'com.bugsee.option.reporting.triggers.notification-bar', false],
  ['detectAndReportNdkCrash', 'com.bugsee.option.detect.crash-ndk', false],
  ['ndkIncludeTombstoneLogs', 'com.bugsee.option.crash-ndk.tombstone-logs', false],
  ['detectMemoryLeaks', 'com.bugsee.option.detect.memory_leaks', false],
  ['detectMemoryLeaksMode', 'com.bugsee.option.detect.memory_leaks.mode', 'DEEP_DEBUG_ONLY'],
  ['detectMemoryLeaksDeepSampleRate', 'com.bugsee.option.detect.memory_leaks.deep_sample_rate', 0.5],
  ['detectThreadLeaks', 'com.bugsee.option.detect.thread_leaks', false],
];

type Bag = Record<string, unknown>;

describe.each([
  ['shared, on iOS', SHARED, () => new IOSLaunchOptions()],
  ['shared, on Android', SHARED, () => new AndroidLaunchOptions()],
  ['iOS-only', IOS, () => new IOSLaunchOptions()],
  ['Android-only', ANDROID, () => new AndroidLaunchOptions()],
] as const)('%s accessors', (_name, table, make) => {
  it.each(table)('%s writes %s', (accessor, key, value) => {
    const options = make() as unknown as Bag;
    options[accessor] = value;
    expect(BugseeLaunchOptions.serialize(options as never)).toEqual({
      [key]: value,
    });
  });

  it.each(table)('%s reads back what it wrote', (accessor, _key, value) => {
    const options = make() as unknown as Bag;
    options[accessor] = value;
    expect(options[accessor]).toEqual(value);
  });

  it.each(table)('%s deletes on undefined', (accessor, _key, value) => {
    const options = make() as unknown as Bag;
    options[accessor] = value;
    options[accessor] = undefined;
    expect(BugseeLaunchOptions.serialize(options as never)).toEqual({});
  });
});

// A key that is not in the extracted set is one the SDK will ignore.
describe('every accessor targets a key the SDK actually accepts', () => {
  it.each(SHARED)('%s -> %s is shared', (_a, key) => {
    expect(SHARED_KEYS).toContain(key);
  });

  it.each(IOS)('%s -> %s is iOS-only', (_a, key) => {
    expect(IOS_ONLY_KEYS).toContain(key);
  });

  it.each(ANDROID)('%s -> %s is Android-only', (_a, key) => {
    expect(ANDROID_ONLY_KEYS).toContain(key);
  });
});
