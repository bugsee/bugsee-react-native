/**
 * The three stable codes a `BugseeReport` operation can fail with.
 *
 * Stable, and worth stating: an app matches on `.code`, so these strings are
 * part of the public contract, not an implementation detail free to change
 * between releases like an error message is.
 */
export const ReportErrorCode = {
  /**
   * The handle's callback has already settled, or its deadline already
   * passed. Raised locally -- without crossing the bridge -- for every
   * operation after that point, and reproduced with the same code when a
   * native rejection reports it instead.
   */
  HandleDead: 'E_REPORT_HANDLE_DEAD',
  /** Native declined an attachment (`addFileAttachment`/`addDataAttachment`). */
  AttachmentRejected: 'E_REPORT_ATTACHMENT_REJECTED',
  /** JS-side validation rejected the argument before it crossed the bridge. */
  BadArgument: 'E_REPORT_BAD_ARGUMENT',
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
