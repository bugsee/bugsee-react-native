import { errorName } from '../errorName';

/**
 * Options for a handled JS exception (`Bugsee.logException`).
 *
 * Encoded as JSON text for the TurboModule: `{domain?}` or `null` when nothing
 * was set. Labels are set on the report through `setReportHandler`; the native
 * SDKs take no per-call labels or `includeVideo`. Unknown keys are rejected; messages name the
 * field and never the rejected value.
 */

export interface ExceptionOptions {
  /** The exception domain. Android groups issues by it; iOS records it with the report. Non-empty, at most 256 characters. */
  domain?: string;
}

export const EXCEPTION_DOMAIN_MAX_LENGTH = 256;

const ALLOWED_KEYS = new Set(['domain']);

/** Every error `encodeExceptionOptions` threw: by identity, not by text. */
const thrownHere = new WeakSet<Error>();

function refuse(error: Error): never {
  thrownHere.add(error);
  throw error;
}

/**
 * What a log line may say about `cause`: the message of an error
 * `encodeExceptionOptions` threw -- this package's own validation text, which
 * names fields and never values (`scripts/raw-messages.ts` checks every one
 * of them) -- and only the class name of anything else. Never throws.
 */
export function exceptionOptionsMessage(cause: unknown): string {
  // WeakSet.has, not instanceof: it never runs app code (a Proxy trap), never
  // throws, and is false for a primitive, so this is safe inside the catch
  // that calls it. A member is one of this file's own TypeError/RangeError
  // instances, whose `message` is a plain data property.
  return thrownHere.has(cause as Error) ? (cause as Error).message : errorName(cause);
}

/**
 * TypeError or RangeError naming the field and never its value; null for
 * undefined or {}.
 */
export function encodeExceptionOptions(
  options: ExceptionOptions | undefined,
): string | null {
  if (options === undefined) {
    return null;
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    refuse(new TypeError('ExceptionOptions must be a plain object'));
  }

  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      refuse(new TypeError(`ExceptionOptions has unknown key "${key}"`));
    }
  }

  const out: Record<string, unknown> = {};

  if (record.domain !== undefined) {
    if (typeof record.domain !== 'string') {
      refuse(new TypeError('ExceptionOptions.domain must be a string'));
    }
    if (record.domain.length === 0) {
      refuse(new RangeError('ExceptionOptions.domain must be non-empty'));
    }
    if (record.domain.length > EXCEPTION_DOMAIN_MAX_LENGTH) {
      refuse(new RangeError(
        `ExceptionOptions.domain must be at most ${EXCEPTION_DOMAIN_MAX_LENGTH} characters`,
      ));
    }
    out.domain = record.domain;
  }

  if (Object.keys(out).length === 0) {
    return null;
  }
  return JSON.stringify(out);
}
