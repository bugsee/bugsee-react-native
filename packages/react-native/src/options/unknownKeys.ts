import { keysFor } from './keys';

type Platform = 'ios' | 'android';

/**
 * 6.x option names mapped to their 7.x keys.
 *
 * Neither SDK treats these the same way, and that is the trap: the iOS SDK still
 * maps its own legacy aliases onto the 7.x keys, while the Android SDK silently
 * DROPS any key it does not know. A 6.x name such as `ShakeToReport` therefore
 * works on iOS and does nothing on Android, with no error on either.
 *
 * The list is the iOS SDK's alias table plus the 6.x Android names the wrapper
 * spec records. It only feeds the message: whether a key warns is decided by
 * {@link keysFor}, never by this table.
 */
export const LEGACY_OPTION_KEYS: Readonly<Record<string, string>> = {
  MaxRecordingTime: 'com.bugsee.option.config.duration',
  WifiOnlyUpload: 'com.bugsee.option.config.wifi-only-upload',
  NotifyFlushDelay: 'com.bugsee.option.config.notify-flush-delay',
  MaxDataSize: 'com.bugsee.option.config.max-data-size',
  CrashReport: 'com.bugsee.option.detect.crash',
  DetectAppExit: 'com.bugsee.option.detect.exit',
  DetectAppLaunchCrash: 'com.bugsee.option.detect.early-crash',
  HandleAnr: 'com.bugsee.option.detect.hang',
  MonitorNetwork: 'com.bugsee.option.capture.network',
  bodySizeLimit: 'com.bugsee.option.capture.network.body-size-limit',
  MaxNetworkBodySize: 'com.bugsee.option.capture.network.body-size-limit',
  RecordHttpBodyWithoutType: 'com.bugsee.option.capture.network.body-without-type',
  SanitizeNetworkData: 'com.bugsee.option.capture.network.default-sanitizer',
  VideoEnabled: 'com.bugsee.option.capture.video',
  ScreenshotEnabled: 'com.bugsee.option.capture.screenshot',
  VideoScale: 'com.bugsee.option.capture.video.scale',
  VideoQuality: 'com.bugsee.option.capture.video.quality',
  VideoMode: 'com.bugsee.option.capture.video.mode',
  FrameRate: 'com.bugsee.option.capture.video.frame-rate',
  ViewHierarchyEnabled: 'com.bugsee.option.capture.view-hierarchy',
  CaptureLogs: 'com.bugsee.option.capture.logs',
  LogLevel: 'com.bugsee.option.capture.logs.level',
  ShakeToReport: 'com.bugsee.option.reporting.triggers.shake',
  ShakeToTrigger: 'com.bugsee.option.reporting.triggers.shake',
  ScreenshotToReport: 'com.bugsee.option.reporting.triggers.screenshot',
  ScreenshotToTrigger: 'com.bugsee.option.reporting.triggers.screenshot',
  NotificationBarTrigger: 'com.bugsee.option.reporting.triggers.notification-bar',
  BugseeDefaultCrashPriority: 'com.bugsee.option.reporting.defaults.crash-priority',
  BugseeDefaultBugPriority: 'com.bugsee.option.reporting.defaults.bug-priority',
  BugseeDefaultErrorPriority: 'com.bugsee.option.reporting.defaults.error-priority',
  ReportSummaryRequired: 'com.bugsee.option.reporting.ui.summary-required',
  ReportDescriptionRequired: 'com.bugsee.option.reporting.ui.description-required',
  ReportEmailRequired: 'com.bugsee.option.reporting.ui.email-required',
  ReportLabelsEnabled: 'com.bugsee.option.reporting.ui.labels-enabled',
  ReportLabelsRequired: 'com.bugsee.option.reporting.ui.labels-required',
  BugseeReportPrioritySelector: 'com.bugsee.option.reporting.ui.priority-selector-enabled',
  BugseeStyle: 'com.bugsee.option.reporting.ui.style',
  PerformanceMonitoring: 'com.bugsee.option.performance.enabled',
  PerformanceSampleRate: 'com.bugsee.option.performance.sample-rate',
  PerformanceAdaptiveSampling: 'com.bugsee.option.performance.adaptive-sampling',
};

/** Edit distance, capped: a distance past `limit` is as good as any other. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (previous[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length] as number;
}

function closestKey(platform: Platform, key: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const known of keysFor(platform)) {
    const d = distance(key, known, 3);
    if (d < bestDistance) {
      best = known;
      bestDistance = d;
    }
  }
  return best;
}

/** The keys of `options` that `platform`'s SDK does not know. */
export function unknownOptionKeys(
  platform: Platform,
  options: Readonly<Record<string, unknown>>,
): string[] {
  const known = keysFor(platform);
  return Object.keys(options).filter((key) => !known.has(key));
}

/** One sentence naming the key, what the SDK does with it, and what to use. */
export function describeUnknownKey(platform: Platform, key: string): string {
  const sdk = platform === 'ios' ? 'iOS' : 'Android';
  const legacy = LEGACY_OPTION_KEYS[key];
  if (legacy !== undefined) {
    const effect =
      platform === 'android'
        ? 'The Android SDK ignores it, so the setting has NO effect there'
        : 'The iOS SDK still maps it, but the Android SDK ignores it';
    return `[Bugsee] "${key}" is a 6.x option name. ${effect}. Use "${legacy}" (or its accessor on the launch options object).`;
  }
  const suggestion = closestKey(platform, key);
  const hint = suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`;
  return (
    `[Bugsee] "${key}" is not a launch option the ${sdk} SDK knows, so the SDK ignores it.` +
    hint
  );
}

const warned = new Set<string>();

/**
 * The warning's only sink. Audited by name in `scripts/raw-messages.ts`: its
 * message comes from {@link describeUnknownKey}, which sees the option KEY and
 * the wrapper's own key tables and is never handed a value.
 */
function emitUnknownOptionWarning(message: string): void {
  console.warn(message);
}

/**
 * Warns once per key for every option `platform`'s SDK would silently drop.
 *
 * Both SDKs accept an unknown key without complaint, and the customer who sets
 * one is left believing the setting is applied -- the case that prompted this
 * was shake-to-report staying on. The launch itself proceeds unchanged: a key
 * this build does not know may belong to a newer SDK than the one the wrapper
 * was checked against, and refusing it would make `setCustomOption` useless.
 */
export function warnUnknownOptions(
  platform: Platform,
  options: Readonly<Record<string, unknown>>,
  warn: (message: string) => void = emitUnknownOptionWarning,
): void {
  for (const key of unknownOptionKeys(platform, options)) {
    const id = `${platform}:${key}`;
    if (warned.has(id)) {
      continue;
    }
    warned.add(id);
    warn(describeUnknownKey(platform, key));
  }
}

/** Forgets what was warned about. For tests. */
export function resetUnknownOptionWarnings(): void {
  warned.clear();
}
