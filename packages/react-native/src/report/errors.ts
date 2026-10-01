/**
 * The four stable codes a report operation can fail with.
 *
 * Stable, and worth stating: an app matches on `.code`, so these strings are
 * part of the public contract, not an implementation detail free to change
 * between releases like an error message is.
 */
export const ReportErrorCode = {
  /**
   * The handle's callback has already settled, or its deadline already
   * passed, or a created report has already been uploaded. Raised locally --
   * without crossing the bridge -- for every operation after that point, and
   * reproduced with the same code when a native rejection reports it instead.
   */
  HandleDead: 'E_REPORT_HANDLE_DEAD',
  /** Native declined an attachment (`addFileAttachment`/`addDataAttachment`). */
  AttachmentRejected: 'E_REPORT_ATTACHMENT_REJECTED',
  /** JS-side validation rejected the argument before it crossed the bridge. */
  BadArgument: 'E_REPORT_BAD_ARGUMENT',
  /**
   * A created report is already outstanding. A second `createReport()` rejects
   * with this until that report is uploaded. iOS beta3 keeps created-report
   * attributes in file-scope globals, so a second create would wipe the first.
   */
  CreateBusy: 'E_REPORT_CREATE_BUSY',
} as const;

export type ReportErrorCode =
  (typeof ReportErrorCode)[keyof typeof ReportErrorCode];

/**
 * What every `BugseeReport` rejection is an instance of, whether it was
 * raised locally (JS validation, a dead handle) or translated from a native
 * rejection that carried one of the codes above.
 */
export class BugseeReportError extends Error {
  readonly code: ReportErrorCode;

  constructor(code: ReportErrorCode, message: string) {
    super(message);
    this.name = 'BugseeReportError';
    this.code = code;
    // Restores `instanceof` across the ES5 transpile some consumers still
    // build with -- without it, `Error` subclasses lose their prototype chain
    // and `error instanceof BugseeReportError` reads false for a real one.
    Object.setPrototypeOf(this, BugseeReportError.prototype);
  }
}
