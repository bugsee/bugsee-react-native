/**
 * The lifecycle events the SDKs dispatch to a wrapper.
 *
 * Both platforms deliver these **by name**, under `com.bugsee.lifecycle.*`,
 * so the bridge needs no per-platform mapping. That is worth stating because
 * iOS also has a `BugseeLifecycleEventType` enum — but that is the app-facing
 * `BugseeDelegate` channel, not the wrapper's, and its raw values shift
 * between releases (7.0.0-beta2 deleted `Started`, `Resumed` and `Paused`,
 * renumbering everything after `Launched`). Consuming names rather than the
 * enum is what keeps this wrapper unaffected by that, and is a constraint to
 * keep rather than an accident.
 *
 * Every event here fires on both platforms as of Android 7.2.0 and iOS
 * 7.0.0-beta2, which implemented the wrapper channel. Availability is still
 * recorded per event: iOS 7.0.0-beta1 dispatched only six, and the shape is
 * needed again the moment the two SDKs diverge.
 */

/** Where an event is known to fire. */
export interface EventAvailability {
  android: boolean;
  ios: boolean;
}

/**
 * Keyed by the name both SDKs use. Android's wire value is the name prefixed
 * with `com.bugsee.lifecycle.`; iOS sends an enum the bridge maps back.
 */
export const LIFECYCLE_EVENTS = {
  Launching: { android: true, ios: true },
  Launched: { android: true, ios: true },
  Stopping: { android: true, ios: true },
  Stopped: { android: true, ios: true },
  BlackoutStarted: { android: true, ios: true },
  BlackoutEnded: { android: true, ios: true },
  RelaunchedAfterCrash: { android: true, ios: true },
  BeforeReportShown: { android: true, ios: true },
  AfterReportShown: { android: true, ios: true },
  BeforeReportAssembled: { android: true, ios: true },
  AfterReportAssembled: { android: true, ios: true },
  ReportAssemblyFailed: { android: true, ios: true },
  BeforeReportUploaded: { android: true, ios: true },
  AfterReportUploaded: { android: true, ios: true },
  ReportUploadFailed: { android: true, ios: true },
  ReportUploadFailedWithFutureRetry: { android: true, ios: true },
} as const satisfies Record<string, EventAvailability>;

/**
 * Events whose `data` carries the report's id. Every other event delivers
 * nil — including `Before`/`AfterReportShown`, which are announced from the
 * report UI before a report exists.
 */
export const EVENTS_CARRYING_REPORT_ID: readonly LifecycleEventName[] = [
  'BeforeReportAssembled',
  'AfterReportAssembled',
  'ReportAssemblyFailed',
  'BeforeReportUploaded',
  'AfterReportUploaded',
  'ReportUploadFailed',
  'ReportUploadFailedWithFutureRetry',
];

export type LifecycleEventName = keyof typeof LIFECYCLE_EVENTS;

/** The wire form on BOTH platforms since iOS 7.0.0-beta2. */
export const ANDROID_EVENT_PREFIX = 'com.bugsee.lifecycle.';

export function wireEventName(event: LifecycleEventName): string {
  return `${ANDROID_EVENT_PREFIX}${event}`;
}

/** The event an Android wire name refers to, or undefined if unknown. */
export function eventFromWireName(
  wire: string,
): LifecycleEventName | undefined {
  if (!wire.startsWith(ANDROID_EVENT_PREFIX)) {
    return undefined;
  }
  const name = wire.slice(ANDROID_EVENT_PREFIX.length);
  return name in LIFECYCLE_EVENTS ? (name as LifecycleEventName) : undefined;
}

/** Whether this event fires on the platform the app is running. */
export function firesOn(
  event: LifecycleEventName,
  platform: 'ios' | 'android',
): boolean {
  return LIFECYCLE_EVENTS[event][platform];
}
