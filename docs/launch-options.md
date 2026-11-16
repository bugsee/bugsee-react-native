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
a test fails when either SDK registers an option this package has no accessor for, and `yarn check:options-manifests`
(run in CI and before every publish) compares the option manifest each SDK release published at
`download.bugsee.com/sdk/options/<platform>/<version>.json` with this package. It fails when an SDK publishes an option
this package lacks (named in the message), or an option whose type, default or enum constants differ. It does not
complain about an option this package has and the SDK does not publish: the package may define options of its own,
which the SDK ignores. The same check also compares the pinned release's manifest with the one for the **previous pin**
(`scripts/sdk-baseline.json`) and fails on any option the newer one no longer has: the SDK removed it, and its accessor and
docs are now dead. That is the one place a removal can be seen, because this package's own option set cannot show it. When
`native-versions.json` moves, set `previous` to the old `current` and `current` to the new pin in that file; a removal is
either dealt with (accessor removed or deprecated) or acknowledged there, with the reason. The tables below are generated
from the accessors and those manifests
(`node scripts/cli-generate-launch-options-doc.ts`), and the check fails when they are stale. Options a
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
- `relaunch(options)` restarts with **exactly** the options you pass. Anything you leave out goes back to the SDK default;
  it does **not** keep what the previous launch set. Pass the full set each time.

## Reference

`Enum` types are exported from `@bugsee/react-native` and cross the bridge as the SDK's internal value (never an ordinal).

### Reporting triggers and dialog

| Accessor | Option key | Type | Platforms | Default | Notes |
|---|---|---|---|---|---|
| `reportingDefaultBugPriority` | `com.bugsee.option.reporting.defaults.bug-priority` | `enum IssueSeverity` | iOS, Android | `High` | Default priority of bug reports; see `IssueSeverity`. |
| `reportingDefaultCrashPriority` | `com.bugsee.option.reporting.defaults.crash-priority` | `enum IssueSeverity` | iOS, Android | `Blocker` | Default priority of crash reports; see `IssueSeverity`. |
| `reportingDefaultErrorPriority` | `com.bugsee.option.reporting.defaults.error-priority` | `enum IssueSeverity` | iOS, Android | `High` | Default priority of error reports; see `IssueSeverity`. |
| `triggerByBroadcast` | `com.bugsee.option.reporting.triggers.broadcast` | `boolean` | Android | `false` | Let a broadcast open the report dialog. |
| `triggerByNotification` | `com.bugsee.option.reporting.triggers.notification-bar` | `boolean` | Android | `true` | Let the user open the report dialog from the notification bar. The SDK default is on. |
| `triggerByScreenshot` | `com.bugsee.option.reporting.triggers.screenshot` | `boolean` | iOS, Android | `false` | Let the user open the report dialog by taking a screenshot. |
| `triggerByShake` | `com.bugsee.option.reporting.triggers.shake` | `boolean` | iOS, Android | `true` | Let the user open the report dialog by shaking the device. **The SDK default is on:** set this to `false` to turn shake-to-report off. |
| `reportingUIDescriptionRequired` | `com.bugsee.option.reporting.ui.description-required` | `boolean` | iOS, Android | `false` | Make the Description field mandatory in the report dialog. |
| `reportingUIEmailRequired` | `com.bugsee.option.reporting.ui.email-required` | `boolean` | iOS, Android | `false` | Make the Email field mandatory in the report dialog. |
| `reportingUILabelsEnabled` | `com.bugsee.option.reporting.ui.labels-enabled` | `boolean` | iOS, Android | `false` | Show the Labels field in the report dialog. |
| `reportingUILabelsRequired` | `com.bugsee.option.reporting.ui.labels-required` | `boolean` | iOS, Android | `false` | Make the Labels field mandatory in the report dialog. |
| `reportingUIPrioritySelectorEnabled` | `com.bugsee.option.reporting.ui.priority-selector-enabled` | `boolean` | iOS, Android | `false` | Let the user change the priority in the report dialog. |
| `reportingUIStyle` | `com.bugsee.option.reporting.ui.style` | `enum BugseeStyle` | iOS | `System` | Appearance of the report dialog; see `ReportingUIStyle`. |
| `reportingUISummaryRequired` | `com.bugsee.option.reporting.ui.summary-required` | `boolean` | iOS, Android | `false` | Make the Summary field mandatory in the report dialog. |

### Capture

| Accessor | Option key | Type | Platforms | Default | Notes |
|---|---|---|---|---|---|
| `captureAVPlayer` | `com.bugsee.option.capture.avplayer` | `boolean` | iOS | `false` | Capture `AVPlayer` content. |
| `captureBluetoothStatus` | `com.bugsee.option.capture.bluetooth-status` | `boolean` | iOS | `false` | Record the Bluetooth status. |
| `captureBreadcrumbs` | `com.bugsee.option.capture.breadcrumbs` | `boolean` | iOS, Android | `false` | Capture breadcrumbs (user and system events). |
| `captureBreadcrumbsExtras` | `com.bugsee.option.capture.breadcrumbs.extras` | `boolean` | iOS, Android | `false` | Attach the extra detail of automatically collected device-event breadcrumbs. |
| `captureCameraPreview` | `com.bugsee.option.capture.camera-preview` | `boolean` | iOS | `false` | Capture camera preview layers. Read the iOS SDK's privacy and overhead notes before enabling. |
| `crashHandlerType` | `com.bugsee.option.capture.crash-handler-type` | `enum BugseeCrashHandlerType` | iOS | `MachAndBSD` | How the crash reporter intercepts crashes; see `CrashHandlerType`. Unset leaves the SDK default, `CrashHandlerType.MachAndBSD`. |
| `crashSignals` | `com.bugsee.option.capture.crash-signals` | `int` | iOS | `128` | The fatal signals the crash reporter intercepts, as the iOS SDK's `BugseeCrashSignals` bit set: ABRT 1, SEGV 2, BUS 4, ILL 8, FPE 16, TRAP 32. Unset leaves the SDK default (every signal). Added in 7.0.0-beta7. |
| `captureDeviceAndNetworkNames` | `com.bugsee.option.capture.device-network-names` | `boolean` | iOS | `false` | Record the device and network names. |
| `captureDiskSpace` | `com.bugsee.option.capture.disk-space` | `boolean` | iOS | `false` | Record free disk space. |
| `captureLogs` | `com.bugsee.option.capture.logs` | `boolean` | iOS, Android | `true` | Capture logs. Lines sent with `Bugsee.log()` are always recorded. |
| `logsUseAllSources` | `com.bugsee.option.capture.logs.allsources` | `boolean` | Android | `false` | Query every logging source (system, radio, ...) rather than only the default ones. |
| `captureLogsLevel` | `com.bugsee.option.capture.logs.level` | `enum LogLevel` | iOS, Android | `Verbose` | Least severe level captured; see `LogLevel`. Also accepts a plain `number`, which this accessor always took, so a level read from config still compiles. |
| `captureOSLogs` | `com.bugsee.option.capture.logs.oslog` | `boolean` | iOS | `false` | Has no effect: the iOS SDK accepts the key and ignores it. **Deprecated** — The iOS SDK permanently disables OSLog capture. |
| `captureNetwork` | `com.bugsee.option.capture.network` | `boolean` | iOS, Android | `true` | Capture network events. |
| `captureNetworkBodySizeLimit` | `com.bugsee.option.capture.network.body-size-limit` | `int` | iOS, Android | `20480` | Largest request or response body captured, in bytes. |
| `captureNetworkBodyWithoutType` | `com.bugsee.option.capture.network.body-without-type` | `boolean` | iOS, Android | `false` | Also capture bodies that declare no content type. Off keeps only textual bodies. |
| `captureNetworkUseDefaultSanitizer` | `com.bugsee.option.capture.network.default-sanitizer` | `boolean` | iOS, Android | `true` | Redact known-sensitive values (query parameters, headers, JSON bodies) when no network filter is set. |
| `captureNetworkOnLaunch` | `com.bugsee.option.capture.network.on-launch` | `boolean` | iOS, Android | `false` | Subscribe network capture synchronously during launch, so requests issued in the launch window are seen. |
| `captureOnDeviceSymbolication` | `com.bugsee.option.capture.on-device-symbolication` | `boolean` | iOS | `false` | Symbolicate stack traces on the device. |
| `captureRespectFlagSecure` | `com.bugsee.option.capture.respect-flag-secure` | `boolean` | Android | `true` | Honour `FLAG_SECURE`: blank secure windows in capture and treat such an activity as a full blackout. |
| `captureSampleBufferDisplayLayer` | `com.bugsee.option.capture.sample-buffer-display-layer` | `boolean` | iOS | `false` | Capture `AVSampleBufferDisplayLayer` content. |
| `captureScreenshot` | `com.bugsee.option.capture.screenshot` | `boolean` | iOS, Android | `true` | Capture screenshots for reports, independent of video. |
| `captureScreenshotScale` | `com.bugsee.option.capture.screenshot.scale` | `float` | iOS, Android | `1` | Privacy scaling applied to screenshots; below `1` removes fine detail such as text. |
| `captureStatusBarInfo` | `com.bugsee.option.capture.status-bar-info` | `boolean` | iOS | `false` | Show capture status in the status bar. Debug builds only; ignored in release. |
| `captureVideo` | `com.bugsee.option.capture.video` | `boolean` | iOS, Android | `true` | Record video for reports. |
| `captureVideoAdaptive` | `com.bugsee.option.capture.video.adaptive` | `boolean` | iOS, Android | Android `false` · iOS `true` | Skip capture work while the screen is idle. The SDKs' own defaults differ. |
| `captureVideoUsingCustomMuxer` | `com.bugsee.option.capture.video.custom-muxer` | `boolean` | Android | `false` | Use a lightweight MP4 muxer instead of `MediaMuxer`. |
| `captureVideoFrameRate` | `com.bugsee.option.capture.video.frame-rate` | `enum FrameRate` | iOS, Android | `High` | How often frames are captured; see `FrameRate`. |
| `captureVideoFullscreenKeepRunning` | `com.bugsee.option.capture.video.fullscreen-keep-running` | `boolean` | Android | `true` | Keep fullscreen (MediaProjection) capture running while the app is in the background. |
| `captureVideoFullscreenRememberUserDecision` | `com.bugsee.option.capture.video.fullscreen-remember-decision` | `boolean` | Android | `true` | Remember the user's screen-capture consent decision across launches. |
| `captureVideoMaxFramerate` | `com.bugsee.option.capture.video.max-frame-rate` | `int` | iOS | `0` | Highest frame rate captured, `0` to `30`; `0` leaves it to `captureVideoFrameRate`. |
| `captureVideoMinFramerate` | `com.bugsee.option.capture.video.min-frame-rate` | `int` | iOS | `0` | Lowest frame rate captured, `0` to `30`; `0` leaves it to `captureVideoFrameRate`. |
| `videoMode` | `com.bugsee.option.capture.video.mode` | `enum VideoMode` | Android | `V2` | Screen-capture mode; see `VideoMode`. Also accepts a plain `number`, which this accessor always took, so a value read from config still compiles. |
| `captureVideoPrivacyBlur` | `com.bugsee.option.capture.video.privacy-blur` | `boolean` | iOS | `true` | Blur transition frames instead of skipping them. |
| `captureVideoQuality` | `com.bugsee.option.capture.video.quality` | `enum VideoQuality` | iOS, Android | `Default` | Quality of the encoded video; see `VideoQuality`. |
| `captureVideoScale` | `com.bugsee.option.capture.video.scale` | `float` | iOS, Android | `1` | Extra down-scaling of recorded video; `0.5` halves width and height. |
| `captureVideoSecureScrolling` | `com.bugsee.option.capture.video.secure-scrolling` | `boolean` | Android | `false` | In `VideoMode.V1`, skip more frames while secure views are on screen. |
| `captureViewHierarchy` | `com.bugsee.option.capture.view-hierarchy` | `boolean` | iOS, Android | `true` | Capture the view hierarchy for reports. |
| `captureWebSocket` | `com.bugsee.option.capture.websocket` | `boolean` | iOS | `true` | Capture WebSocket traffic. |
| `captureWebViewAdvanced` | `com.bugsee.option.capture.webview.advanced` | `boolean` | iOS, Android | `true` | Inject the advanced WebView SDK into instrumented WebViews for full-fidelity in-page capture. |
| `captureWebViewDomainAllowlist` | `com.bugsee.option.capture.webview.domain-allowlist` | `string` | Android | `""` | Has no effect: the SDK no longer scopes WebView capture by domain. **Deprecated** — Android 7.1.2 deprecated this option and the SDK does not honour it. |
| `captureWebViewReportTrigger` | `com.bugsee.option.capture.webview.report-trigger` | `boolean` | iOS, Android | `false` | Let an incident raised inside an instrumented WebView open a native bug report. |

### Detection

| Accessor | Option key | Type | Platforms | Default | Notes |
|---|---|---|---|---|---|
| `ndkIncludeTombstoneLogs` | `com.bugsee.option.crash-ndk.tombstone-logs` | `boolean` | Android | `false` | Attach the Android tombstone logs to NDK crash reports. |
| `detectAndReportAnomaly` | `com.bugsee.option.detect.anomaly` | `boolean` | iOS, Android | `false` | Detect and report performance anomalies. |
| `detectAndReportAnrSampling` | `com.bugsee.option.detect.anr.sampling` | `boolean` | Android | `true` | Sample the main thread during an ANR to attribute the report to culprit frames. |
| `detectAndReportCrash` | `com.bugsee.option.detect.crash` | `boolean` | iOS, Android | `true` | Detect and report crashes. |
| `detectAndReportNdkCrash` | `com.bugsee.option.detect.crash-ndk` | `boolean` | Android | `true` | Detect native (NDK) crashes. Needs `detectAndReportCrash`; this package bundles the NDK module. |
| `detectCrashFillEmptyExceptionStacks` | `com.bugsee.option.detect.crash.fill_empty_exception_stacks` | `boolean` | iOS | `false` | Fill the stack of an uncaught `NSException` that has none, which can change crash grouping. |
| `detectCrashSwiftAsyncStackTraces` | `com.bugsee.option.detect.crash.swift_async_stacktraces` | `boolean` | iOS | `true` | Stitch Swift async frames into C++ throw stacks (iOS 15+). |
| `detectAndReportEarlyCrash` | `com.bugsee.option.detect.early-crash` | `boolean` | iOS, Android | `true` | Recover crashes that happen during app start-up. |
| `detectAndReportExit` | `com.bugsee.option.detect.exit` | `boolean` | iOS, Android | `true` | Detect and report app exits. |
| `detectAndReportExitLowMemoryBackgroundAsError` | `com.bugsee.option.detect.exit.bg_low_memory_as_error` | `boolean` | Android | `false` | Report a low-memory kill of a process that was not in the foreground as a non-fatal error rather than a crash. Applies only while `detectAndReportExitLowMemory` is on. Android 7.3.0. |
| `detectAndReportExitDependencyDied` | `com.bugsee.option.detect.exit.dependency_died` | `boolean` | Android | `false` | Report exits caused by a dependency process dying. |
| `detectAndReportExitExcessiveResourceUsage` | `com.bugsee.option.detect.exit.excessive_resource_usage` | `boolean` | Android | `false` | Report exits caused by excessive resource usage. |
| `detectAndReportExitLowMemory` | `com.bugsee.option.detect.exit.low_memory` | `boolean` | Android | `true` | Report exits caused by low memory (the OOM killer). |
| `detectAndReportExitNotResponding` | `com.bugsee.option.detect.exit.not_responding` | `boolean` | Android | `true` | Report exits caused by the app not responding (ANR). |
| `detectAndReportExitNotRespondingAsCrash` | `com.bugsee.option.detect.exit.not_responding.as_crash` | `boolean` | Android | `false` | Report ANR exits as crashes instead of non-fatal errors. |
| `detectAndReportExitOther` | `com.bugsee.option.detect.exit.other` | `boolean` | Android | `false` | Report exits with an "other" reason. |
| `detectAndReportExitPackageStateChanged` | `com.bugsee.option.detect.exit.package_state_changed` | `boolean` | Android | `false` | Report exits caused by a package state change. |
| `detectAndReportExitPackageUpdated` | `com.bugsee.option.detect.exit.package_updated` | `boolean` | Android | `false` | Report exits caused by a package update. |
| `detectAndReportExitPermissionChanged` | `com.bugsee.option.detect.exit.permission_changed` | `boolean` | Android | `false` | Report exits caused by a runtime permission change. |
| `detectAndReportExitUnknown` | `com.bugsee.option.detect.exit.unknown` | `boolean` | Android | `false` | Report exits with an unknown reason. |
| `detectAndReportExitUserRequested` | `com.bugsee.option.detect.exit.user_requested` | `boolean` | Android | `false` | Report exits the user requested, such as a force stop. |
| `detectAndReportExitUserWasStopped` | `com.bugsee.option.detect.exit.user_was_stopped` | `boolean` | Android | `false` | Report exits caused by the system stopping the app. |
| `detectFrustration` | `com.bugsee.option.detect.frustration` | `boolean` | iOS, Android | `false` | Detect and report user-frustration patterns such as rage taps. |
| `detectAndReportHang` | `com.bugsee.option.detect.hang` | `boolean` | iOS, Android | `false` | Detect and report hangs. |
| `detectAndReportHangFairLevel` | `com.bugsee.option.detect.hang.level.fair` | `int` | iOS, Android | `3000` | Main-thread block, in milliseconds, that raises a "fair" hang. Less than the medium level. |
| `detectAndReportHangMediumLevel` | `com.bugsee.option.detect.hang.level.medium` | `int` | iOS, Android | `5000` | Main-thread block, in milliseconds, that raises a "medium" hang. |
| `detectAndReportHangSevereLevel` | `com.bugsee.option.detect.hang.level.severe` | `int` | iOS, Android | `10000` | Main-thread block, in milliseconds, that raises a "severe" hang. Greater than the medium level. |
| `detectAndReportHangSampling` | `com.bugsee.option.detect.hang.sampling` | `boolean` | Android | `true` | Sample the main thread during a hang to attribute the report to culprit frames. Needs `detectAndReportHang`. |
| `detectAndReportHttpErrors` | `com.bugsee.option.detect.http-errors` | `boolean` | iOS, Android | `false` | Turn HTTP 5xx responses into error reports. |
| `detectAndReportMainThreadMisuse` | `com.bugsee.option.detect.main_thread_misuse` | `boolean` | iOS, Android | `false` | Detect and report blocking work on the main thread. |
| `detectMemoryLeaks` | `com.bugsee.option.detect.memory_leaks` | `boolean` | Android | `true` | Detect memory leaks. Honoured only when the app also depends on `com.bugsee:bugsee-android-leak`, which this package does not add. |
| `detectMemoryLeaksDeepSampleRate` | `com.bugsee.option.detect.memory_leaks.deep_sample_rate` | `float` | Android | `1` | Fraction of sessions that run the deep leak modes. Needs `bugsee-android-leak`. |
| `detectMemoryLeaksMode` | `com.bugsee.option.detect.memory_leaks.mode` | `enum MemoryLeakMode` | Android | `FAST` | Leak detection depth; see `MemoryLeakMode`. Needs `bugsee-android-leak`. |
| `detectThreadLeaks` | `com.bugsee.option.detect.thread_leaks` | `boolean` | Android | `false` | Detect thread leaks. Needs `bugsee-android-leak`. |

### Configuration

| Accessor | Option key | Type | Platforms | Default | Notes |
|---|---|---|---|---|---|
| `buildTarget` | `com.bugsee.option.config.build-target` | `string` | iOS | unset | Build target name attached to reports. |
| `buildType` | `com.bugsee.option.config.build-type` | `string` | iOS | unset | Build type attached to reports. |
| `duration` | `com.bugsee.option.config.duration` | `int` | iOS, Android | `60` | Seconds of history a report carries. |
| `maxDataSize` | `com.bugsee.option.config.max-data-size` | `int` | iOS, Android | `150` | Disk space, in megabytes, that reports waiting to be sent may occupy. Past it the oldest reports are deleted whole. |
| `maxPendingReportAge` | `com.bugsee.option.config.max-pending-report-age` | `int` | iOS, Android | `30` | Oldest a report waiting to be sent may get, in days; `0` or less keeps reports until they are sent or evicted. Android 7.3.0, iOS 7.0.0. |
| `maxPendingReports` | `com.bugsee.option.config.max-pending-reports` | `int` | iOS, Android | `30` | Most reports kept waiting to be sent. Android 7.3.0, iOS 7.0.0. |
| `notifyFlushDelay` | `com.bugsee.option.config.notify-flush-delay` | `int` | iOS, Android | `0` | Coalesce window, in milliseconds, before `Bugsee.notify` uploads flush; `0` posts as soon as the item is on disk. |
| `reportHandlerCallbackTimeout` | `com.bugsee.option.config.report-handler-callback-timeout` | `int` | Android | `30` | Seconds before a report handler's completion callback is auto-fired; `0` disables the timeout. |
| `reportProcessingInProcess` | `com.bugsee.option.config.report-processing-in-process` | `boolean` | Android | `true` | Export and upload reports in-process on background threads instead of through JobScheduler. |
| `wifiOnlyUpload` | `com.bugsee.option.config.wifi-only-upload` | `boolean` | iOS, Android | `false` | Upload only over Wi-Fi. |

### Performance

| Accessor | Option key | Type | Platforms | Default | Notes |
|---|---|---|---|---|---|
| `performanceAdaptiveSampling` | `com.bugsee.option.performance.adaptive-sampling` | `boolean` | iOS, Android | `true` | Promote "interesting" transactions that lost the random sampling draw. |
| `performanceMonitoring` | `com.bugsee.option.performance.enabled` | `boolean` | iOS, Android | `true` | Enable performance monitoring (APM). |
| `performanceSampleRate` | `com.bugsee.option.performance.sample-rate` | `float` | iOS, Android | `0.01` | Probability, `0` to `1`, that a transaction is sampled. |
| `performanceUploadMode` | `com.bugsee.option.performance.upload-mode` | `string` | Android | `"batched"` | Upload mode for performance data: `'batched'` or `'realtime'`. |

### Not exposed on purpose

- `com.bugsee.option.config.data-encryption`: declared in the iOS SDK's private header (BGSOptionsPrivate.h), not its public API.
- `com.bugsee.option.$$DEBUG`: internal.
- `com.bugsee.option.$$WRAPPER`: internal; the wrapper registers itself.
- `com.bugsee.option.$$ENDPOINT`: reached through the `endpoint` accessor.
- `endpoint`: reached through the `endpoint` accessor.
