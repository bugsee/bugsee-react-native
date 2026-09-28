import type { IssueSeverity } from '../options/enums';

/**
 * A report's kind, as the native side names it.
 *
 * An open set, deliberately: `'bug' | 'crash' | 'error'` is what both SDKs
 * emit today, but a newer native SDK adding a kind must still reach a JS
 * handler rather than being rejected by a wrapper that predates it.
 */
export type ReportType = 'bug' | 'crash' | 'error' | (string & {});

/** The report's fields as of one `read()`. */
export interface BugseeReportSnapshot {
  summary: string | undefined;
  description: string | undefined;
  /** iOS reports 0 for "unset"; anything outside 1..5 reads as `undefined`. */
  severity: IssueSeverity | undefined;
  labels: string[];
  attributes: Record<string, string | number | boolean>;
  /** Ascending, always -- native is not guaranteed to be (Android #178). */
  screenshotDisplayIds: number[];
  attachmentNames: string[];
}

/**
 * A patch applied to a report through `update()`.
 *
 * Every field is optional and, together, all-or-nothing: nothing is applied
 * unless every field present is valid. `labels` REPLACES the report's whole
 * list (Android `setLabels`, iOS `replaceLabels:`), not appends to it.
 * `clearAttributes` is applied before `attributes`, so a patch can clear and
 * then set in one call. Within `attributes`, a `null` value removes that key
 * rather than setting it to null.
 */
export interface ReportPatch {
  summary?: string | null;
  description?: string | null;
  severity?: IssueSeverity;
  labels?: readonly string[];
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  clearAttributes?: true;
}

/**
 * A live handle onto the report a `BugseeReportHandler` callback was given.
 *
 * Scoped to the handle the native event carried: every operation crosses the
 * bridge with the same `handleId`, and every one of them rejects with
 * `BugseeReportError` code `E_REPORT_HANDLE_DEAD` -- without crossing the
 * bridge at all -- once the callback that received this report has settled or
 * its deadline has passed. `id` and `type` need no round trip: both arrive
 * with the event that produced this proxy.
 */
export interface BugseeReport {
  readonly id: string;
  readonly type: ReportType;

  /** One native call; every getter below is sugar over this. */
  read(): Promise<BugseeReportSnapshot>;

  getSummary(): Promise<string | undefined>;
  setSummary(value: string | null): Promise<void>;
  getDescription(): Promise<string | undefined>;
  setDescription(value: string | null): Promise<void>;
  getSeverity(): Promise<IssueSeverity | undefined>;
  setSeverity(value: IssueSeverity): Promise<void>;
  getLabels(): Promise<string[]>;
  /** Replaces the whole list, in one `reportUpdate` call. */
  setLabels(labels: readonly string[]): Promise<void>;
  getAttributes(): Promise<Record<string, string | number | boolean>>;
  /** `value: null` removes the attribute rather than setting it to null. */
  setAttribute(
    name: string,
    value: string | number | boolean | null,
  ): Promise<void>;
  clearAttributes(): Promise<void>;
  getScreenshotDisplayIds(): Promise<number[]>;
  getAttachmentNames(): Promise<string[]>;
  addFileAttachment(
    path: string,
    options: { name: string; mimeType?: string; move?: boolean },
  ): Promise<void>;
  addDataAttachment(
    base64: string,
    options: { name: string; mimeType?: string },
  ): Promise<void>;
  update(patch: ReportPatch): Promise<void>;
}

/**
 * Registered through `setReportHandler`. Register before `launch()` to see
 * reports the SDK recovers at launch.
 *
 * `onBeforeReportCreated` is at-most-once and may be skipped entirely for a
 * given report -- a crash recovered at launch, for instance, can go straight
 * to `onAfterReportCreated`. `onAfterReportCreated` is at-least-once and MUST
 * be idempotent: prefer `setLabels`/`setAttribute` over appending, and check
 * `getAttachmentNames()` before adding an attachment a previous delivery may
 * already have added. A mutation made after the callback settles, or after
 * its handle's deadline passes, does not reach the report -- the deadline is
 * the SDK's own, not something the app negotiates.
 */
export interface BugseeReportHandler {
  onBeforeReportCreated?(report: BugseeReport): void | Promise<void>;
  onAfterReportCreated?(report: BugseeReport): void | Promise<void>;
}
