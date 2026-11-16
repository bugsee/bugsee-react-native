import { BugseeLaunchOptions } from './BugseeLaunchOptions';
import type { CrashHandlerType, ReportingUIStyle } from './enums';
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

  /**
   * Capture `AVPlayer` content.
   */
  get captureAVPlayer(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.avplayer');
  }
  set captureAVPlayer(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.avplayer', value);
  }

  /**
   * Record the Bluetooth status.
   */
  get captureBluetoothStatus(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.bluetooth-status');
  }
  set captureBluetoothStatus(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.bluetooth-status', value);
  }

  /**
   * Capture camera preview layers. Read the iOS SDK's privacy and overhead notes before enabling.
   */
  get captureCameraPreview(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.camera-preview');
  }
  set captureCameraPreview(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.camera-preview', value);
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

  /**
   * Record the device and network names.
   */
  get captureDeviceAndNetworkNames(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.device-network-names');
  }
  set captureDeviceAndNetworkNames(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.device-network-names', value);
  }

  /**
   * Record free disk space.
   */
  get captureDiskSpace(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.disk-space');
  }
  set captureDiskSpace(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.disk-space', value);
  }

  /**
   * Has no effect: the iOS SDK accepts the key and ignores it.
   *
   * @deprecated The iOS SDK permanently disables OSLog capture.
   */
  get captureOSLogs(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.logs.oslog');
  }
  set captureOSLogs(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.logs.oslog', value);
  }

  /**
   * Symbolicate stack traces on the device.
   */
  get captureOnDeviceSymbolication(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.on-device-symbolication');
  }
  set captureOnDeviceSymbolication(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.on-device-symbolication', value);
  }

  /**
   * Capture `AVSampleBufferDisplayLayer` content.
   */
  get captureSampleBufferDisplayLayer(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.sample-buffer-display-layer');
  }
  set captureSampleBufferDisplayLayer(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.sample-buffer-display-layer', value);
  }

  /**
   * Show capture status in the status bar. Debug builds only; ignored in release.
   */
  get captureStatusBarInfo(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.status-bar-info');
  }
  set captureStatusBarInfo(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.status-bar-info', value);
  }

  /**
   * Highest frame rate captured, `0` to `30`; `0` leaves it to {@link captureVideoFrameRate}.
   */
  get captureVideoMaxFramerate(): number | undefined {
    return this.$get('com.bugsee.option.capture.video.max-frame-rate');
  }
  set captureVideoMaxFramerate(value: number | undefined) {
    this.$set('com.bugsee.option.capture.video.max-frame-rate', value);
  }

  /**
   * Lowest frame rate captured, `0` to `30`; `0` leaves it to {@link captureVideoFrameRate}.
   */
  get captureVideoMinFramerate(): number | undefined {
    return this.$get('com.bugsee.option.capture.video.min-frame-rate');
  }
  set captureVideoMinFramerate(value: number | undefined) {
    this.$set('com.bugsee.option.capture.video.min-frame-rate', value);
  }

  /**
   * Blur transition frames instead of skipping them.
   */
  get captureVideoPrivacyBlur(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.video.privacy-blur');
  }
  set captureVideoPrivacyBlur(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.video.privacy-blur', value);
  }

  /**
   * Capture WebSocket traffic.
   */
  get captureWebSocket(): boolean | undefined {
    return this.$get('com.bugsee.option.capture.websocket');
  }
  set captureWebSocket(value: boolean | undefined) {
    this.$set('com.bugsee.option.capture.websocket', value);
  }

  /**
   * Build target name attached to reports.
   */
  get buildTarget(): string | undefined {
    return this.$get('com.bugsee.option.config.build-target');
  }
  set buildTarget(value: string | undefined) {
    this.$set('com.bugsee.option.config.build-target', value);
  }

  /**
   * Build type attached to reports.
   */
  get buildType(): string | undefined {
    return this.$get('com.bugsee.option.config.build-type');
  }
  set buildType(value: string | undefined) {
    this.$set('com.bugsee.option.config.build-type', value);
  }

  /**
   * Fill the stack of an uncaught `NSException` that has none, which can change crash grouping.
   */
  get detectCrashFillEmptyExceptionStacks(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.crash.fill_empty_exception_stacks');
  }
  set detectCrashFillEmptyExceptionStacks(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.crash.fill_empty_exception_stacks', value);
  }

  /**
   * Stitch Swift async frames into C++ throw stacks (iOS 15+).
   */
  get detectCrashSwiftAsyncStackTraces(): boolean | undefined {
    return this.$get('com.bugsee.option.detect.crash.swift_async_stacktraces');
  }
  set detectCrashSwiftAsyncStackTraces(value: boolean | undefined) {
    this.$set('com.bugsee.option.detect.crash.swift_async_stacktraces', value);
  }

  /**
   * Appearance of the report dialog; see {@link ReportingUIStyle}.
   */
  get reportingUIStyle(): ReportingUIStyle | undefined {
    return this.$get('com.bugsee.option.reporting.ui.style');
  }
  set reportingUIStyle(value: ReportingUIStyle | undefined) {
    this.$set('com.bugsee.option.reporting.ui.style', value);
  }
}
