/**
 * Plain data the campaign API scenarios and their e2e share (no React Native
 * import, so the Node e2e can import it too): the option values N-06 sets,
 * the option cases N-07 launches, and the colours N-13 / N-14 paint.
 */

const P = 'com.bugsee.option.';

/**
 * N-06: one non-default value per manifest key (option-keys.json). The
 * defaults run (`api-opt-defaults`) proves each is non-default on the
 * device rather than trusting this table. Enum keys carry their internal
 * value (option-enums.json), never an ordinal.
 *
 * `config.data-encryption` (iOS) is left out of the all-keys launch: an
 * encrypted data directory would make that run's bundle unreadable. Its
 * read-back is N-07's `env-diff` case.
 */
export const READBACK_SHARED: Readonly<Record<string, unknown>> = {
  [`${P}capture.breadcrumbs`]: true,
  [`${P}capture.breadcrumbs.extras`]: true,
  [`${P}capture.logs`]: false,
  [`${P}capture.logs.level`]: 2,
  [`${P}capture.network`]: false,
  [`${P}capture.network.body-size-limit`]: 4096,
  [`${P}capture.network.body-without-type`]: true,
  [`${P}capture.network.default-sanitizer`]: false,
  [`${P}capture.network.on-launch`]: true,
  [`${P}capture.screenshot`]: false,
  [`${P}capture.screenshot.scale`]: 0.5,
  [`${P}capture.video`]: false,
  [`${P}capture.video.adaptive`]: true,
  [`${P}capture.video.frame-rate`]: 2,
  [`${P}capture.video.quality`]: 2,
  [`${P}capture.video.scale`]: 0.5,
  [`${P}capture.view-hierarchy`]: false,
  [`${P}capture.webview.advanced`]: false,
  [`${P}capture.webview.report-trigger`]: true,
  [`${P}config.duration`]: 75,
  [`${P}config.max-data-size`]: 120,
  [`${P}config.notify-flush-delay`]: 7,
  [`${P}config.wifi-only-upload`]: true,
  [`${P}detect.anomaly`]: true,
  [`${P}detect.crash`]: false,
  [`${P}detect.early-crash`]: false,
  [`${P}detect.exit`]: false,
  [`${P}detect.frustration`]: true,
  [`${P}detect.hang`]: true,
  [`${P}detect.hang.level.fair`]: 3500,
  [`${P}detect.hang.level.medium`]: 5500,
  [`${P}detect.hang.level.severe`]: 11000,
  [`${P}detect.http-errors`]: true,
  [`${P}detect.main_thread_misuse`]: true,
  [`${P}performance.adaptive-sampling`]: false,
  [`${P}performance.enabled`]: false,
  [`${P}performance.sample-rate`]: 0.5,
  [`${P}reporting.defaults.bug-priority`]: 4,
  [`${P}reporting.defaults.crash-priority`]: 2,
  [`${P}reporting.defaults.error-priority`]: 1,
  [`${P}reporting.triggers.screenshot`]: true,
  [`${P}reporting.triggers.shake`]: false,
  [`${P}reporting.ui.description-required`]: true,
  [`${P}reporting.ui.email-required`]: true,
  [`${P}reporting.ui.labels-enabled`]: true,
  [`${P}reporting.ui.labels-required`]: true,
  [`${P}reporting.ui.priority-selector-enabled`]: true,
  [`${P}reporting.ui.summary-required`]: true,
};

export const READBACK_ANDROID: Readonly<Record<string, unknown>> = {
  [`${P}capture.logs.allsources`]: true,
  [`${P}capture.respect-flag-secure`]: false,
  [`${P}capture.video.custom-muxer`]: true,
  [`${P}capture.video.fullscreen-keep-running`]: false,
  [`${P}capture.video.fullscreen-remember-decision`]: false,
  [`${P}capture.video.mode`]: 21,
  [`${P}capture.video.secure-scrolling`]: true,
  [`${P}capture.webview.domain-allowlist`]: 'example.com',
  [`${P}config.max-pending-report-age`]: 7,
  [`${P}config.max-pending-reports`]: 9,
  [`${P}config.report-handler-callback-timeout`]: 12,
  // config.report-processing-in-process=false files no report on the
  // WOD_LX1 (option-effects.test.ts OPT-081), which this run needs for the
  // environment record: read back there instead.
  [`${P}detect.anr.sampling`]: false,
  [`${P}detect.exit.bg_low_memory_as_error`]: true,
  [`${P}detect.exit.dependency_died`]: true,
  [`${P}detect.exit.excessive_resource_usage`]: true,
  [`${P}detect.exit.low_memory`]: false,
  [`${P}detect.exit.not_responding`]: false,
  [`${P}detect.exit.not_responding.as_crash`]: true,
  [`${P}detect.exit.other`]: true,
  [`${P}detect.exit.package_state_changed`]: true,
  [`${P}detect.exit.package_updated`]: true,
  [`${P}detect.exit.permission_changed`]: true,
  [`${P}detect.exit.unknown`]: true,
  [`${P}detect.exit.user_requested`]: true,
  [`${P}detect.exit.user_was_stopped`]: true,
  [`${P}detect.hang.sampling`]: false,
  [`${P}performance.upload-mode`]: 'realtime',
  [`${P}reporting.triggers.broadcast`]: true,
  [`${P}reporting.triggers.notification-bar`]: false,
};

export const READBACK_IOS: Readonly<Record<string, unknown>> = {
  /** iOS defaults adaptive video on (Android off): flipped here. */
  [`${P}capture.video.adaptive`]: false,
  [`${P}capture.avplayer`]: true,
  [`${P}capture.bluetooth-status`]: true,
  [`${P}capture.camera-preview`]: true,
  [`${P}capture.device-network-names`]: true,
  [`${P}capture.disk-space`]: true,
  [`${P}capture.logs.oslog`]: true,
  [`${P}capture.mach-exceptions`]: false,
  [`${P}capture.on-device-symbolication`]: true,
  [`${P}capture.sample-buffer-display-layer`]: true,
  [`${P}capture.status-bar-info`]: true,
  [`${P}capture.video.max-frame-rate`]: 12,
  [`${P}capture.video.min-frame-rate`]: 4,
  [`${P}capture.video.privacy-blur`]: false,
  [`${P}capture.websocket`]: false,
  [`${P}config.build-target`]: 'api-e2e-target',
  [`${P}config.build-type`]: 'api-e2e-type',
  [`${P}detect.crash.fill_empty_exception_stacks`]: true,
  [`${P}detect.crash.swift_async_stacktraces`]: false,
  [`${P}detect.kill`]: true,
  /** BugseeStyleDusk (1); the default is BugseeStyleSystem (3). */
  [`${P}reporting.ui.style`]: 1,
};

/** The one iOS key N-06 reads back through N-07's env-diff case. */
export const IOS_DATA_ENCRYPTION = `${P}config.data-encryption`;

/**
 * The keys N-06 sets through a typed accessor rather than setCustomOption
 * (OPT-ACC-01..03), by accessor name.
 */
export const ACCESSOR_KEYS = {
  shared: {
    captureLogs: `${P}capture.logs`,
    captureLogsLevel: `${P}capture.logs.level`,
    captureNetwork: `${P}capture.network`,
    captureBreadcrumbs: `${P}capture.breadcrumbs`,
    captureVideo: `${P}capture.video`,
    detectAndReportCrash: `${P}detect.crash`,
    detectAndReportHang: `${P}detect.hang`,
    wifiOnlyUpload: `${P}config.wifi-only-upload`,
    duration: `${P}config.duration`,
    maxDataSize: `${P}config.max-data-size`,
  },
  android: {
    videoMode: `${P}capture.video.mode`,
    logsUseAllSources: `${P}capture.logs.allsources`,
    detectAndReportExitLowMemory: `${P}detect.exit.low_memory`,
    detectAndReportExitLowMemoryBackgroundAsError: `${P}detect.exit.bg_low_memory_as_error`,
    maxPendingReports: `${P}config.max-pending-reports`,
    maxPendingReportAge: `${P}config.max-pending-report-age`,
    triggerByNotification: `${P}reporting.triggers.notification-bar`,
  },
  ios: {
    captureAVPlayer: `${P}capture.avplayer`,
    captureMachExceptions: `${P}capture.mach-exceptions`,
    captureDiskSpace: `${P}capture.disk-space`,
    detectAndReportKill: `${P}detect.kill`,
  },
} as const;

/**
 * OPT-ACC-08: every internal value of every enum-typed key, each launched
 * once (through relaunch) and read back.
 */
export const ENUM_VALUES: Readonly<Record<string, readonly number[]>> = {
  [`${P}capture.logs.level`]: [1, 2, 3, 4, 5],
  [`${P}capture.video.quality`]: [0, 1, 2],
  [`${P}capture.video.frame-rate`]: [1, 2, 3, 4],
  [`${P}reporting.defaults.bug-priority`]: [1, 2, 3, 4, 5],
  [`${P}reporting.defaults.crash-priority`]: [1, 2, 3, 4, 5],
  [`${P}reporting.defaults.error-priority`]: [1, 2, 3, 4, 5],
};

/** The Android-only enum key, VideoMode None 0 / V1 1 / V2 2 / Fullscreen 20 / DirectBuffers 21. */
export const ANDROID_ENUM_VALUES: Readonly<Record<string, readonly number[]>> = {
  [`${P}capture.video.mode`]: [0, 1, 2, 20, 21],
};

/**
 * N-07: the option set each `api-eff-<case>` scenario launches with, on top
 * of the app's (endpoint, duration 90). A `-control` case is the same work
 * at the defaults.
 */
export const EFFECT_OPTIONS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'crash-off': { [`${P}detect.crash`]: false },
  exit: { [`${P}detect.exit`]: true, [`${P}detect.exit.user_requested`]: true },
  'exit-control': { [`${P}detect.exit`]: true, [`${P}detect.exit.user_requested`]: false },
  kill: { [`${P}detect.kill`]: true },
  hang: { [`${P}detect.hang`]: true, [`${P}detect.hang.level.fair`]: 2000 },
  'hang-control': { [`${P}detect.hang`]: false },
  'http-errors': { [`${P}detect.http-errors`]: true },
  'http-errors-control': {},
  'sanitizer-off': { [`${P}capture.network.default-sanitizer`]: false },
  'sanitizer-control': {},
  'body-no-type': { [`${P}capture.network.body-without-type`]: true },
  'body-no-type-control': {},
  'net-on-launch': { [`${P}capture.network.on-launch`]: true },
  'net-on-launch-control': {},
  'notify-flush': { [`${P}config.notify-flush-delay`]: 10 },
  'notify-flush-control': {},
  'crumb-extras': { [`${P}capture.breadcrumbs`]: true, [`${P}capture.breadcrumbs.extras`]: true },
  'crumb-extras-control': { [`${P}capture.breadcrumbs`]: true },
  'ui-fields': {
    [`${P}reporting.ui.labels-enabled`]: true,
    [`${P}reporting.ui.priority-selector-enabled`]: true,
  },
  'ui-fields-control': {},
  'env-diff': {
    [`${P}capture.bluetooth-status`]: true,
    [`${P}capture.device-network-names`]: true,
    [`${P}capture.disk-space`]: true,
    [`${P}capture.status-bar-info`]: true,
    [`${P}config.build-target`]: 'api-e2e-target',
    [`${P}config.build-type`]: 'api-e2e-type',
    [IOS_DATA_ENCRYPTION]: 1,
  },
  'env-diff-control': {},
  oslog: { [`${P}capture.logs.oslog`]: true },
  'oslog-control': {},
  allsources: { [`${P}capture.logs.allsources`]: true },
  'allsources-control': {},
  'mach-off': { [`${P}capture.mach-exceptions`]: false },
  'ondevice-sym': { [`${P}capture.on-device-symbolication`]: true },
  'ondevice-sym-control': { [`${P}capture.on-device-symbolication`]: false },
  'fps-max': { [`${P}capture.video.max-frame-rate`]: 2 },
  'fps-min': { [`${P}capture.video.min-frame-rate`]: 20 },
  'fps-control': {},
  'websocket-off': { [`${P}capture.websocket`]: false },
  'websocket-control': {},
  'flag-secure': { [`${P}capture.respect-flag-secure`]: true },
  'flag-secure-off': { [`${P}capture.respect-flag-secure`]: false },
  'handler-timeout': { [`${P}config.report-handler-callback-timeout`]: 5 },
  'handler-timeout-control': {},
  /** Why the Android all-keys run (N-06) files no report: one suspect alone. */
  'out-of-process': { [`${P}config.report-processing-in-process`]: false },
};

/** N-13: one colour per report appearance key (`#rrggbb`, opaque). */
export const REPORT_COLOURS: Readonly<Record<string, string>> = {
  actionBarButtonBackgroundClickedColor: '#804000',
  actionBarColor: '#ff00ff',
  actionBarTextColor: '#00ff00',
  backgroundColor: '#ffd000',
  cellBackgroundColor: '#00c0ff',
  closeButtonColor: '#ff0080',
  editTextBackgroundColor: '#00c0ff',
  hintColor: '#8000ff',
  navigationBarColor: '#ff00ff',
  placeholderColor: '#8000ff',
  sendButtonColor: '#00ff00',
  severityLabelActiveColor: '#ff0080',
  textColor: '#0000ff',
  versionColor: '#ff4000',
};

/** N-13: the keys each platform binds (packages/react-native/src/appearance/report.ts). */
export const REPORT_KEYS = {
  android: [
    'actionBarButtonBackgroundClickedColor',
    'actionBarColor',
    'actionBarTextColor',
    'backgroundColor',
    'editTextBackgroundColor',
    'hintColor',
    'severityLabelActiveColor',
    'textColor',
    'versionColor',
  ],
  ios: [
    'backgroundColor',
    'cellBackgroundColor',
    'closeButtonColor',
    'navigationBarColor',
    'placeholderColor',
    'sendButtonColor',
    'textColor',
    'versionColor',
  ],
} as const;

/** N-14: one colour per feedback appearance key (`#rrggbb`, opaque). */
export const FEEDBACK_COLOURS: Readonly<Record<string, string>> = {
  actionBarColor: '#ff00ff',
  actionBarButtonBackgroundClickedColor: '#804000',
  backgroundColor: '#112233',
  barsColor: '#ff00ff',
  bottomDelimiterColor: '#00ff00',
  closeButtonColor: '#ff0080',
  dateTextColor: '#406080',
  emailBackgroundColor: '#00c0ff',
  emailContinueActiveColor: '#80ff00',
  emailContinueClickedColor: '#408000',
  emailContinueNotActiveColor: '#ff4000',
  emailSkipBackgroundClickedColor: '#600060',
  emailSkipColor: '#ff0080',
  emailSkipTextColor: '#ff0080',
  errorTextColor: '#a00000',
  incomingBubbleColor: '#004040',
  incomingTextColor: '#c0c000',
  inputBackgroundColor: '#ffd000',
  inputTextColor: '#0000ff',
  inputTextHintColor: '#8000ff',
  loadingBarBackgroundColor: '#202060',
  loadingTextColor: '#606020',
  navigationBarColor: '#00ff00',
  outgoingBubbleColor: '#400040',
  outgoingTextColor: '#00a0a0',
  titleTextColor: '#ffd000',
  versionChangedBackgroundColor: '#204020',
  versionChangedTextColor: '#a0a0a0',
};

/** N-14: the keys each platform binds (packages/react-native-feedback/src/appearance.ts). */
export const FEEDBACK_KEYS = {
  android: [
    'actionBarColor',
    'actionBarButtonBackgroundClickedColor',
    'backgroundColor',
    'bottomDelimiterColor',
    'dateTextColor',
    'emailBackgroundColor',
    'emailContinueActiveColor',
    'emailContinueClickedColor',
    'emailContinueNotActiveColor',
    'emailSkipBackgroundClickedColor',
    'emailSkipTextColor',
    'errorTextColor',
    'incomingBubbleColor',
    'incomingTextColor',
    'inputTextColor',
    'inputTextHintColor',
    'loadingBarBackgroundColor',
    'loadingTextColor',
    'outgoingBubbleColor',
    'outgoingTextColor',
    'titleTextColor',
    'versionChangedBackgroundColor',
    'versionChangedTextColor',
  ],
  ios: [
    'backgroundColor',
    'barsColor',
    'closeButtonColor',
    'emailBackgroundColor',
    'emailContinueActiveColor',
    'emailContinueNotActiveColor',
    'emailSkipColor',
    'incomingBubbleColor',
    'incomingTextColor',
    'inputBackgroundColor',
    'inputTextColor',
    'navigationBarColor',
    'outgoingBubbleColor',
    'outgoingTextColor',
    'titleTextColor',
  ],
} as const;
