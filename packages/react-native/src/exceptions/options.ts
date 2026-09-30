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
    throw new TypeError('ExceptionOptions must be a plain object');
  }

  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new TypeError(`ExceptionOptions has unknown key "${key}"`);
    }
  }

  // Built in domain → labels → includeVideo order so the wire text is stable.
  const out: Record<string, unknown> = {};

  if (record.domain !== undefined) {
    if (typeof record.domain !== 'string') {
      throw new TypeError('ExceptionOptions.domain must be a string');
    }
    if (record.domain.length === 0) {
      throw new RangeError('ExceptionOptions.domain must be non-empty');
    }
    if (record.domain.length > EXCEPTION_DOMAIN_MAX_LENGTH) {
      throw new RangeError(
        `ExceptionOptions.domain must be at most ${EXCEPTION_DOMAIN_MAX_LENGTH} characters`,
      );
    }
    out.domain = record.domain;
  }

  if (record.labels !== undefined) {
    if (!Array.isArray(record.labels)) {
      throw new TypeError('ExceptionOptions.labels must be an array of strings');
    }
    for (const label of record.labels) {
      if (typeof label !== 'string') {
        throw new TypeError('ExceptionOptions.labels must be an array of strings');
      }
    }
    out.labels = [...record.labels];
  }

  if (record.includeVideo !== undefined) {
    if (typeof record.includeVideo !== 'boolean') {
      throw new TypeError('ExceptionOptions.includeVideo must be a boolean');
    }
    out.includeVideo = record.includeVideo;
  }

  if (Object.keys(out).length === 0) {
    return null;
  }
  return JSON.stringify(out);
}
