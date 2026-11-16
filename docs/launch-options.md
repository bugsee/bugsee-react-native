# Launch options

Every launch option either native SDK registers has a typed accessor on the options object
from `createDefaultLaunchOptions()`. The wrapper sets no defaults: an option you leave unset
takes the native SDK's own default, and `Bugsee.getLaunchOptions()` reports what is in effect.

```ts
import Bugsee, { createDefaultLaunchOptions } from '@bugsee/react-native';

const options = createDefaultLaunchOptions();
options.triggerByShake = false; // shake-to-report is ON by default in both SDKs
await Bugsee.launch('<your app token>', options);
```

The tables are checked against the SDK versions pinned in `native-versions.json` (Android 7.4.2, iOS 7.0.0):
a test fails when either SDK registers an option this package has no accessor for. Options a
*newer* SDK adds are reachable with `options.setCustomOption(key, value)` until the package catches up.

## Keys the SDK drops

Both SDKs accept an unknown key without an error. The Android SDK **silently drops it**; the iOS SDK stores it and
ignores it (it still maps its own 6.x names, which Android does not). So a 6.x name such as `ShakeToReport` works on
iOS, does nothing on Android, and reports nothing on either. `launch()` and `relaunch()` therefore log one
`console.warn` per unknown key, naming the 7.x key to use. The launch itself is unchanged.

## `launch()` and `relaunch()`

- `launch(token, options)` starts the SDK with `options`. If the SDK is **already running** (iOS, or an Android process the
  SDK relaunched itself after the OS killed it) the new options are **ignored**. Do not treat `true` as proof they were applied:
  check `getStatus()` before the call if the difference matters. Android SDK 7.5.1 resolves `false` in this case, earlier SDKs `true`.
- `relaunch()` with **no argument** keeps your options: it replays `getHostLaunchOptions()`, the SDK's record of what the
  app supplied. (The native SDKs' bare relaunch restarts with defaults.) `relaunch(options)`, including `relaunch({})`,
  restarts with **exactly** the options you pass; anything you leave out goes back to the SDK default.

## Reference

`Enum` types are exported from `@bugsee/react-native` and cross the bridge as the SDK's internal value (never an ordinal).

### Reporting triggers and dialog

| Accessor | Option key | Type | Platforms | Notes |
|---|---|---|---|---|
| `reportingDefaultBugPriority` | `com.bugsee.option.reporting.defaults.bug-priority` | `IssueSeverity` | iOS, Android | Default priority of bug reports; see `IssueSeverity`. |
| `reportingDefaultCrashPriority` | `com.bugsee.option.reporting.defaults.crash-priority` | `IssueSeverity` | iOS, Android | Default priority of crash reports; see `IssueSeverity`. |
| `reportingDefaultErrorPriority` | `com.bugsee.option.reporting.defaults.error-priority` | `IssueSeverity` | iOS, Android | Default priority of error reports; see `IssueSeverity`. |
| `triggerByBroadcast` | `com.bugsee.option.reporting.triggers.broadcast` | `boolean` | Android | Let a broadcast open the report dialog. |
| `triggerByNotification` | `com.bugsee.option.reporting.triggers.notification-bar` | `boolean` | Android | Let the user open the report dialog from the notification bar. The SDK default is on. |
| `triggerByScreenshot` | `com.bugsee.option.reporting.triggers.screenshot` | `boolean` | iOS, Android | Let the user open the report dialog by taking a screenshot. |
| `triggerByShake` | `com.bugsee.option.reporting.triggers.shake` | `boolean` | iOS, Android | Let the user open the report dialog by shaking the device. **The SDK default is on:** set this to `false` to turn shake-to-report off. |
| `reportingUIDescriptionRequired` | `com.bugsee.option.reporting.ui.description-required` | `boolean` | iOS, Android | Make the Description field mandatory in the report dialog. |
| `reportingUIEmailRequired` | `com.bugsee.option.reporting.ui.email-required` | `boolean` | iOS, Android | Make the Email field mandatory in the report dialog. |
| `reportingUILabelsEnabled` | `com.bugsee.option.reporting.ui.labels-enabled` | `boolean` | iOS, Android | Show the Labels field in the report dialog. |
| `reportingUILabelsRequired` | `com.bugsee.option.reporting.ui.labels-required` | `boolean` | iOS, Android | Make the Labels field mandatory in the report dialog. |
| `reportingUIPrioritySelectorEnabled` | `com.bugsee.option.reporting.ui.priority-selector-enabled` | `boolean` | iOS, Android | Let the user change the priority in the report dialog. |
| `reportingUIStyle` | `com.bugsee.option.reporting.ui.style` | `ReportingUIStyle` | iOS | Appearance of the report dialog; see `ReportingUIStyle`. |
| `reportingUISummaryRequired` | `com.bugsee.option.reporting.ui.summary-required` | `boolean` | iOS, Android | Make the Summary field mandatory in the report dialog. |

### Capture

| Accessor | Option key | Type | Platforms | Notes |
|---|---|---|---|---|
| `captureAVPlayer` | `com.bugsee.option.capture.avplayer` | `boolean` | iOS | Capture `AVPlayer` content. |
| `captureBluetoothStatus` | `com.bugsee.option.capture.bluetooth-status` | `boolean` | iOS | Record the Bluetooth status. |
| `captureBreadcrumbs` | `com.bugsee.option.capture.breadcrumbs` | `boolean` | iOS, Android | Capture breadcrumbs (user and system events). |
| `captureBreadcrumbsExtras` | `com.bugsee.option.capture.breadcrumbs.extras` | `boolean` | iOS, Android | Attach the extra detail of automatically collected device-event breadcrumbs. |
| `captureCameraPreview` | `com.bugsee.option.capture.camera-preview` | `boolean` | iOS | Capture camera preview layers. Read the iOS SDK's privacy and overhead notes before enabling. |
| `crashHandlerType` | `com.bugsee.option.capture.crash-handler-type` | `CrashHandlerType` | iOS | How the crash reporter intercepts crashes; see `CrashHandlerType`. Unset leaves the SDK default, `CrashHandlerType.MachAndBSD`. |
| `crashSignals` | `com.bugsee.option.capture.crash-signals` | `number` | iOS | The fatal signals the crash reporter intercepts, as the iOS SDK's `BugseeCrashSignals` bit set: ABRT 1, SEGV 2, BUS 4, ILL 8, FPE 16, TRAP 32. Unset leaves the SDK default (every signal). Added in 7.0.0-beta7. |
| `captureDeviceAndNetworkNames` | `com.bugsee.option.capture.device-network-names` | `boolean` | iOS | Record the device and network names. |
| `captureDiskSpace` | `com.bugsee.option.capture.disk-space` | `boolean` | iOS | Record free disk space. |
| `captureLogs` | `com.bugsee.option.capture.logs` | `boolean` | iOS, Android | Capture logs. Lines sent with `Bugsee.log()` are always recorded. |
| `logsUseAllSources` | `com.bugsee.option.capture.logs.allsources` | `boolean` | Android | Query every logging source (system, radio, ...) rather than only the default ones. |
| `captureLogsLevel` | `com.bugsee.option.capture.logs.level` | `LogLevel` | iOS, Android | Least severe level captured; see `LogLevel`. |
| `captureOSLogs` | `com.bugsee.option.capture.logs.oslog` | `boolean` | iOS | Has no effect: the iOS SDK accepts the key and ignores it. |
| `captureNetwork` | `com.bugsee.option.capture.network` | `boolean` | iOS, Android | Capture network events. |
| `captureNetworkBodySizeLimit` | `com.bugsee.option.capture.network.body-size-limit` | `number` | iOS, Android | Largest request or response body captured, in bytes. |
| `captureNetworkBodyWithoutType` | `com.bugsee.option.capture.network.body-without-type` | `boolean` | iOS, Android | Also capture bodies that declare no content type. Off keeps only textual bodies. |
| `captureNetworkUseDefaultSanitizer` | `com.bugsee.option.capture.network.default-sanitizer` | `boolean` | iOS, Android | Redact known-sensitive values (query parameters, headers, JSON bodies) when no network filter is set. |
| `captureNetworkOnLaunch` | `com.bugsee.option.capture.network.on-launch` | `boolean` | iOS, Android | Subscribe network capture synchronously during launch, so requests issued in the launch window are seen. |
| `captureOnDeviceSymbolication` | `com.bugsee.option.capture.on-device-symbolication` | `boolean` | iOS | Symbolicate stack traces on the device. |
| `captureRespectFlagSecure` | `com.bugsee.option.capture.respect-flag-secure` | `boolean` | Android | Honour `FLAG_SECURE`: blank secure windows in capture and treat such an activity as a full blackout. |
| `captureSampleBufferDisplayLayer` | `com.bugsee.option.capture.sample-buffer-display-layer` | `boolean` | iOS | Capture `AVSampleBufferDisplayLayer` content. |
| `captureScreenshot` | `com.bugsee.option.capture.screenshot` | `boolean` | iOS, Android | Capture screenshots for reports, independent of video. |
| `captureScreenshotScale` | `com.bugsee.option.capture.screenshot.scale` | `number` | iOS, Android | Privacy scaling applied to screenshots; below `1` removes fine detail such as text. |
| `captureStatusBarInfo` | `com.bugsee.option.capture.status-bar-info` | `boolean` | iOS | Show capture status in the status bar. Debug builds only; ignored in release. |
| `captureVideo` | `com.bugsee.option.capture.video` | `boolean` | iOS, Android | Record video for reports. |
| `captureVideoAdaptive` | `com.bugsee.option.capture.video.adaptive` | `boolean` | iOS, Android | Skip capture work while the screen is idle. The SDKs' own defaults differ. |
| `captureVideoUsingCustomMuxer` | `com.bugsee.option.capture.video.custom-muxer` | `boolean` | Android | Use a lightweight MP4 muxer instead of `MediaMuxer`. |
| `captureVideoFrameRate` | `com.bugsee.option.capture.video.frame-rate` | `FrameRate` | iOS, Android | How often frames are captured; see `FrameRate`. |
| `captureVideoFullscreenKeepRunning` | `com.bugsee.option.capture.video.fullscreen-keep-running` | `boolean` | Android | Keep fullscreen (MediaProjection) capture running while the app is in the background. |
| `captureVideoFullscreenRememberUserDecision` | `com.bugsee.option.capture.video.fullscreen-remember-decision` | `boolean` | Android | Remember the user's screen-capture consent decision across launches. |
| `captureVideoMaxFramerate` | `com.bugsee.option.capture.video.max-frame-rate` | `number` | iOS | Highest frame rate captured, `0` to `30`; `0` leaves it to `captureVideoFrameRate`. |
| `captureVideoMinFramerate` | `com.bugsee.option.capture.video.min-frame-rate` | `number` | iOS | Lowest frame rate captured, `0` to `30`; `0` leaves it to `captureVideoFrameRate`. |
| `videoMode` | `com.bugsee.option.capture.video.mode` | `VideoMode` | Android | Screen-capture mode; see `VideoMode`. |
| `captureVideoPrivacyBlur` | `com.bugsee.option.capture.video.privacy-blur` | `boolean` | iOS | Blur transition frames instead of skipping them. |
| `captureVideoQuality` | `com.bugsee.option.capture.video.quality` | `VideoQuality` | iOS, Android | Quality of the encoded video; see `VideoQuality`. |
| `captureVideoScale` | `com.bugsee.option.capture.video.scale` | `number` | iOS, Android | Extra down-scaling of recorded video; `0.5` halves width and height. |
| `captureVideoSecureScrolling` | `com.bugsee.option.capture.video.secure-scrolling` | `boolean` | Android | In `VideoMode.V1`, skip more frames while secure views are on screen. |
| `captureViewHierarchy` | `com.bugsee.option.capture.view-hierarchy` | `boolean` | iOS, Android | Capture the view hierarchy for reports. |
| `captureWebSocket` | `com.bugsee.option.capture.websocket` | `boolean` | iOS | Capture WebSocket traffic. |
| `captureWebViewAdvanced` | `com.bugsee.option.capture.webview.advanced` | `boolean` | iOS, Android | Inject the advanced WebView SDK into instrumented WebViews for full-fidelity in-page capture. |
| `captureWebViewDomainAllowlist` | `com.bugsee.option.capture.webview.domain-allowlist` | `string` | Android | Has no effect: the SDK no longer scopes WebView capture by domain. |
| `captureWebViewReportTrigger` | `com.bugsee.option.capture.webview.report-trigger` | `boolean` | iOS, Android | Let an incident raised inside an instrumented WebView open a native bug report. |

### Detection

| Accessor | Option key | Type | Platforms | Notes |
|---|---|---|---|---|
| `ndkIncludeTombstoneLogs` | `com.bugsee.option.crash-ndk.tombstone-logs` | `boolean` | Android | Attach the Android tombstone logs to NDK crash reports. |
| `detectAndReportAnomaly` | `com.bugsee.option.detect.anomaly` | `boolean` | iOS, Android | Detect and report performance anomalies. |
| `detectAndReportAnrSampling` | `com.bugsee.option.detect.anr.sampling` | `boolean` | Android | Sample the main thread during an ANR to attribute the report to culprit frames. |
| `detectAndReportCrash` | `com.bugsee.option.detect.crash` | `boolean` | iOS, Android | Detect and report crashes. |
| `detectAndReportNdkCrash` | `com.bugsee.option.detect.crash-ndk` | `boolean` | Android | Detect native (NDK) crashes. Needs `detectAndReportCrash`; this package bundles the NDK module. |
| `detectCrashFillEmptyExceptionStacks` | `com.bugsee.option.detect.crash.fill_empty_exception_stacks` | `boolean` | iOS | Fill the stack of an uncaught `NSException` that has none, which can change crash grouping. |
| `detectCrashSwiftAsyncStackTraces` | `com.bugsee.option.detect.crash.swift_async_stacktraces` | `boolean` | iOS | Stitch Swift async frames into C++ throw stacks (iOS 15+). |
| `detectAndReportEarlyCrash` | `com.bugsee.option.detect.early-crash` | `boolean` | iOS, Android | Recover crashes that happen during app start-up. |
| `detectAndReportExit` | `com.bugsee.option.detect.exit` | `boolean` | iOS, Android | Detect and report app exits. |
| `detectAndReportExitLowMemoryBackgroundAsError` | `com.bugsee.option.detect.exit.bg_low_memory_as_error` | `boolean` | Android | Report a low-memory kill of a process that was not in the foreground as a non-fatal error rather than a crash. Applies only while `detectAndReportExitLowMemory` is on. Android 7.3.0. |
| `detectAndReportExitDependencyDied` | `com.bugsee.option.detect.exit.dependency_died` | `boolean` | Android | Report exits caused by a dependency process dying. |
| `detectAndReportExitExcessiveResourceUsage` | `com.bugsee.option.detect.exit.excessive_resource_usage` | `boolean` | Android | Report exits caused by excessive resource usage. |
| `detectAndReportExitLowMemory` | `com.bugsee.option.detect.exit.low_memory` | `boolean` | Android | Report exits caused by low memory (the OOM killer). |
| `detectAndReportExitNotResponding` | `com.bugsee.option.detect.exit.not_responding` | `boolean` | Android | Report exits caused by the app not responding (ANR). |
| `detectAndReportExitNotRespondingAsCrash` | `com.bugsee.option.detect.exit.not_responding.as_crash` | `boolean` | Android | Report ANR exits as crashes instead of non-fatal errors. |
| `detectAndReportExitOther` | `com.bugsee.option.detect.exit.other` | `boolean` | Android | Report exits with an "other" reason. |
| `detectAndReportExitPackageStateChanged` | `com.bugsee.option.detect.exit.package_state_changed` | `boolean` | Android | Report exits caused by a package state change. |
| `detectAndReportExitPackageUpdated` | `com.bugsee.option.detect.exit.package_updated` | `boolean` | Android | Report exits caused by a package update. |
| `detectAndReportExitPermissionChanged` | `com.bugsee.option.detect.exit.permission_changed` | `boolean` | Android | Report exits caused by a runtime permission change. |
| `detectAndReportExitUnknown` | `com.bugsee.option.detect.exit.unknown` | `boolean` | Android | Report exits with an unknown reason. |
| `detectAndReportExitUserRequested` | `com.bugsee.option.detect.exit.user_requested` | `boolean` | Android | Report exits the user requested, such as a force stop. |
| `detectAndReportExitUserWasStopped` | `com.bugsee.option.detect.exit.user_was_stopped` | `boolean` | Android | Report exits caused by the system stopping the app. |
| `detectFrustration` | `com.bugsee.option.detect.frustration` | `boolean` | iOS, Android | Detect and report user-frustration patterns such as rage taps. |
| `detectAndReportHang` | `com.bugsee.option.detect.hang` | `boolean` | iOS, Android | Detect and report hangs. |
| `detectAndReportHangFairLevel` | `com.bugsee.option.detect.hang.level.fair` | `number` | iOS, Android | Main-thread block, in milliseconds, that raises a "fair" hang. Less than the medium level. |
| `detectAndReportHangMediumLevel` | `com.bugsee.option.detect.hang.level.medium` | `number` | iOS, Android | Main-thread block, in milliseconds, that raises a "medium" hang. |
| `detectAndReportHangSevereLevel` | `com.bugsee.option.detect.hang.level.severe` | `number` | iOS, Android | Main-thread block, in milliseconds, that raises a "severe" hang. Greater than the medium level. |
| `detectAndReportHangSampling` | `com.bugsee.option.detect.hang.sampling` | `boolean` | Android | Sample the main thread during a hang to attribute the report to culprit frames. Needs `detectAndReportHang`. |
| `detectAndReportHttpErrors` | `com.bugsee.option.detect.http-errors` | `boolean` | iOS, Android | Turn HTTP 5xx responses into error reports. |
| `detectAndReportMainThreadMisuse` | `com.bugsee.option.detect.main_thread_misuse` | `boolean` | iOS, Android | Detect and report blocking work on the main thread. |
| `detectMemoryLeaks` | `com.bugsee.option.detect.memory_leaks` | `boolean` | Android | Detect memory leaks. Honoured only when the app also depends on `com.bugsee:bugsee-android-leak`, which this package does not add. |
| `detectMemoryLeaksDeepSampleRate` | `com.bugsee.option.detect.memory_leaks.deep_sample_rate` | `number` | Android | Fraction of sessions that run the deep leak modes. Needs `bugsee-android-leak`. |
| `detectMemoryLeaksMode` | `com.bugsee.option.detect.memory_leaks.mode` | `MemoryLeakMode` | Android | Leak detection depth; see `MemoryLeakMode`. Needs `bugsee-android-leak`. |
| `detectThreadLeaks` | `com.bugsee.option.detect.thread_leaks` | `boolean` | Android | Detect thread leaks. Needs `bugsee-android-leak`. |

### Configuration

| Accessor | Option key | Type | Platforms | Notes |
|---|---|---|---|---|
| `buildTarget` | `com.bugsee.option.config.build-target` | `string` | iOS | Build target name attached to reports. |
| `buildType` | `com.bugsee.option.config.build-type` | `string` | iOS | Build type attached to reports. |
| `duration` | `com.bugsee.option.config.duration` | `number` | iOS, Android | Seconds of history a report carries. |
| `maxDataSize` | `com.bugsee.option.config.max-data-size` | `number` | iOS, Android | Disk space, in megabytes, that reports waiting to be sent may occupy. Past it the oldest reports are deleted whole. The SDKs' defaults can differ; the wrapper sets neither. |
| `maxPendingReportAge` | `com.bugsee.option.config.max-pending-report-age` | `number` | iOS, Android | Oldest a report waiting to be sent may get, in days; `0` or less keeps reports until they are sent or evicted. Android 7.3.0, iOS 7.0.0. |
| `maxPendingReports` | `com.bugsee.option.config.max-pending-reports` | `number` | iOS, Android | Most reports kept waiting to be sent. Android 7.3.0, iOS 7.0.0. |
| `notifyFlushDelay` | `com.bugsee.option.config.notify-flush-delay` | `number` | iOS, Android | Coalesce window, in milliseconds, before `Bugsee.notify` uploads flush; `0` posts as soon as the item is on disk. |
| `reportHandlerCallbackTimeout` | `com.bugsee.option.config.report-handler-callback-timeout` | `number` | Android | Seconds before a report handler's completion callback is auto-fired; `0` disables the timeout. |
| `reportProcessingInProcess` | `com.bugsee.option.config.report-processing-in-process` | `boolean` | Android | Export and upload reports in-process on background threads instead of through JobScheduler. |
| `wifiOnlyUpload` | `com.bugsee.option.config.wifi-only-upload` | `boolean` | iOS, Android | Upload only over Wi-Fi. |

### Performance

| Accessor | Option key | Type | Platforms | Notes |
|---|---|---|---|---|
| `performanceAdaptiveSampling` | `com.bugsee.option.performance.adaptive-sampling` | `boolean` | iOS, Android | Promote "interesting" transactions that lost the random sampling draw. |
| `performanceMonitoring` | `com.bugsee.option.performance.enabled` | `boolean` | iOS, Android | Enable performance monitoring (APM). |
| `performanceSampleRate` | `com.bugsee.option.performance.sample-rate` | `number` | iOS, Android | Probability, `0` to `1`, that a transaction is sampled. |
| `performanceUploadMode` | `com.bugsee.option.performance.upload-mode` | `string` | Android | Upload mode for performance data: `'batched'` or `'realtime'`. |

### Not exposed on purpose

- `com.bugsee.option.config.data-encryption` (iOS): declared in the SDK's private header, not its public API.
- `com.bugsee.option.$$DEBUG`, `$$WRAPPER` (Android): internal; the package registers itself as the wrapper.
- `endpoint` / `$$ENDPOINT`: use the `endpoint` accessor, which writes the right key for the platform.
