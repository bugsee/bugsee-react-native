import { errorName } from '../errorName';

/**
 * Options for a handled JS exception (`Bugsee.logException`).
 *
 * Encoded as JSON text for the TurboModule: `{domain?, labels?, includeVideo?}`
 * or `null` when nothing was set. Unknown keys are rejected; messages name the
 * field and never the rejected value.
 */

export interface ExceptionOptions {
  /** Groups the issue on the dashboard. Non-empty, at most 256 characters. */
  domain?: string;
  /** Issue labels. Android 7.3.0 ignores them (to raise); iOS applies them. */
  labels?: readonly string[];
  /** Recorded in the report's exception options on iOS; neither 7.x SDK acts on it yet. */
  includeVideo?: boolean;
}

export const EXCEPTION_DOMAIN_MAX_LENGTH = 256;

const ALLOWED_KEYS = new Set(['domain', 'labels', 'includeVideo']);

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

  // Built in domain → labels → includeVideo order so the wire text is stable.
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

  if (record.labels !== undefined) {
    if (!Array.isArray(record.labels)) {
      refuse(new TypeError('ExceptionOptions.labels must be an array of strings'));
    }
    for (const label of record.labels) {
      if (typeof label !== 'string') {
        refuse(new TypeError('ExceptionOptions.labels must be an array of strings'));
      }
    }
    out.labels = [...record.labels];
  }

  if (record.includeVideo !== undefined) {
    if (typeof record.includeVideo !== 'boolean') {
      refuse(new TypeError('ExceptionOptions.includeVideo must be a boolean'));
    }
    out.includeVideo = record.includeVideo;
  }

  if (Object.keys(out).length === 0) {
    return null;
  }
  return JSON.stringify(out);
}
