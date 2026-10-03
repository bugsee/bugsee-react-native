/**
 * Terminal status of a span, the integer both SDKs use.
 *
 * Android `SpanStatus` is a plain enum whose ordinal is this value
 * (`OK` is 0). iOS `BGSSpanStatus` declares the same integers. The bundle
 * writes the name (`OK`, `ERROR`, `DEADLINE_EXCEEDED`); this is the value
 * `setStatus` and `finish(status)` cross.
 */
export const SpanStatus = {
  OK: 0,
  Error: 1,
  Timeout: 2,
  Cancelled: 3,
  DeadlineExceeded: 4,
  Unknown: 5,
} as const;
export type SpanStatus = (typeof SpanStatus)[keyof typeof SpanStatus];

export const SpanErrorCode = {
  /**
   * `finish` already released this span, or a parent finish released it.
   * Raised locally, without crossing, for every operation after that.
   */
  HandleDead: 'E_SPAN_HANDLE_DEAD',
} as const;
export type SpanErrorCode = (typeof SpanErrorCode)[keyof typeof SpanErrorCode];

export class BugseeSpanError extends Error {
  readonly code: SpanErrorCode;

  constructor(code: SpanErrorCode, message: string) {
    super(message);
    this.name = 'BugseeSpanError';
    this.code = code;
  }
}

/** A span attribute. Both SDKs take a string, number or boolean. */
export type SpanAttribute = string | number | boolean;

/**
 * What `startTransaction` / `startSpan` / `getActiveSpan` / `spanStartChild`
 * return. `handle` `''` means there is no span. `name` is present only for
 * a transaction.
 */
export interface SpanWire {
  handle: string;
  spanId: string;
  traceId: string;
  operation: string;
  description: string | null;
  status: number;
  finished: boolean;
  attributesJson: string;
  name?: string;
  sampled?: boolean;
}
