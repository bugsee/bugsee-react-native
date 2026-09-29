/**
 * The two stable codes an attribute or identity operation can fail with.
 *
 * Stable, and worth stating: an app matches on `.code`, so these strings are
 * part of the public contract, not an implementation detail free to change
 * between releases like an error message is.
 */
export const AttributeErrorCode = {
  /** JS-side validation rejected the name or value before it crossed the bridge. */
  BadArgument: 'E_ATTRIBUTE_BAD_ARGUMENT',
  /**
   * Native did not keep the value: it was over a size limit (iOS's archived-
   * size limit; the value crossed, but a native read-back afterwards found
   * something else), or dropped for any other reason.
   */
  Rejected: 'E_ATTRIBUTE_REJECTED',
} as const;

export type AttributeErrorCode =
  (typeof AttributeErrorCode)[keyof typeof AttributeErrorCode];

/**
 * What every attribute or identity rejection is an instance of, whether it
 * was raised locally (JS validation) or translated from a native rejection
 * that carried one of the codes above.
 */
export class BugseeAttributeError extends Error {
  readonly code: AttributeErrorCode;

  constructor(code: AttributeErrorCode, message: string) {
    super(message);
    this.name = 'BugseeAttributeError';
    this.code = code;
    // Restores `instanceof` across the ES5 transpile some consumers still
    // build with -- without it, `Error` subclasses lose their prototype chain
    // and `error instanceof BugseeAttributeError` reads false for a real one.
    Object.setPrototypeOf(this, BugseeAttributeError.prototype);
  }
}
