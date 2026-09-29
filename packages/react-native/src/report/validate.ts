/**
 * Validation the JS side runs BEFORE crossing the bridge.
 *
 * Every function here either returns a wire-ready value or throws
 * `BugseeReportError` with code `BadArgument` -- never something a caller has
 * to translate. `validateReportPatch` is all-or-nothing: it fully validates
 * every field present before returning anything, so a caller that only
 * inspects its return value can never observe a half-applied patch.
 */
import type { IssueSeverity } from '../options/enums';
import { BugseeReportError, ReportErrorCode } from './errors';
import type { ReportPatch } from './types';

function badArgument(message: string): never {
  throw new BugseeReportError(ReportErrorCode.BadArgument, message);
}

/** Integers 1..5 -- the only values the SDKs accept as a severity to SET. */
export function isValidSeverityValue(value: unknown): value is IssueSeverity {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

export function validateSeverity(value: unknown): IssueSeverity {
  if (!isValidSeverityValue(value)) {
    badArgument(
      `severity must be an integer 1..5, got ${JSON.stringify(value)}`,
    );
  }
  return value as IssueSeverity;
}

/**
 * The severity a `read()` reports, or `undefined` for anything that is not a
 * valid 1..5 -- including iOS's 0-for-unset. Reading is more permissive than
 * writing on purpose: a value outside 1..5 arriving from native is not this
 * layer's argument to reject, only one it cannot say anything useful about.
 */
export function severityFromNative(value: unknown): IssueSeverity | undefined {
  return isValidSeverityValue(value) ? value : undefined;
}

export function validateLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    badArgument(`labels must be an array of strings, got ${typeof labels}`);
  }
  for (const label of labels) {
    if (typeof label !== 'string') {
      badArgument(`labels must all be strings, got ${typeof label}`);
    }
  }
  return [...(labels as string[])];
}

export function isValidAttributeValue(
  value: unknown,
): value is string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateAttributes(
  attributes: unknown,
): Record<string, string | number | boolean | null> {
  if (
    typeof attributes !== 'object' ||
    attributes === null ||
    Array.isArray(attributes)
  ) {
    badArgument('attributes must be a plain object');
  }
  // No prototype, so every name is an ordinary key -- "__proto__" included.
  // In a plain `{}` it would hit Object.prototype's setter instead and never
  // reach native: silently for a string or number, and by swapping this
  // object's prototype for null. Both SDKs store it like any other name.
  const result: Record<string, string | number | boolean | null> =
    Object.create(null);
  for (const [key, value] of Object.entries(
    attributes as Record<string, unknown>,
  )) {
    if (key.length === 0) {
      badArgument('attribute name must be a non-empty string');
    }
    if (!isValidAttributeValue(value)) {
      badArgument(
        `attribute "${key}" must be a string, boolean, finite number or null, got ${typeof value}`,
      );
    }
    result[key] = value;
  }
  return result;
}

export function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    badArgument(`${field} must be a non-empty string`);
  }
  return value as string;
}

const FILE_URL_PREFIX = 'file://';

/**
 * A `file://` URL is stripped and percent-decoded. Anything else is a plain
 * filesystem path and passes through verbatim: `%` is a legal filename
 * character, so decoding it would reject `/…/100%done.log` and silently turn
 * `/logs/a%41.log` into `/logs/aA.log`.
 */
export function normalizeFilePath(path: string): string {
  if (!path.startsWith(FILE_URL_PREFIX)) return path;
  try {
    return decodeURIComponent(path.slice(FILE_URL_PREFIX.length));
  } catch {
    return badArgument(
      `path is not valid percent-encoding: ${JSON.stringify(path)}`,
    );
  }
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function validateBase64(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    badArgument('data must be base64-encoded');
  }
  return value as string;
}

const PATCH_KEYS: ReadonlySet<string> = new Set([
  'summary',
  'description',
  'severity',
  'labels',
  'clearAttributes',
  'attributes',
]);

/**
 * Validates a whole `ReportPatch` and returns the exact object to send to
 * `reportUpdate`, or throws before anything is sent.
 *
 * An unknown key fails the whole patch rather than being ignored: a caller
 * that misspelled a field would otherwise see its patch silently drop part of
 * itself.
 */
export function validateReportPatch(patch: ReportPatch): Record<string, unknown> {
  if (typeof patch !== 'object' || patch === null) {
    badArgument('update() requires a patch object');
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) {
      badArgument(`update() received an unknown key "${key}"`);
    }
  }

  const wire: Record<string, unknown> = {};

  if ('summary' in patch) {
    const { summary } = patch;
    if (summary !== null && typeof summary !== 'string') {
      badArgument('summary must be a string or null');
    }
    wire.summary = summary;
  }
  if ('description' in patch) {
    const { description } = patch;
    if (description !== null && typeof description !== 'string') {
      badArgument('description must be a string or null');
    }
    wire.description = description;
  }
  if ('severity' in patch) {
    wire.severity = validateSeverity(patch.severity);
  }
  if ('labels' in patch) {
    wire.labels = validateLabels(patch.labels);
  }
  if ('clearAttributes' in patch) {
    if (patch.clearAttributes !== true) {
      badArgument('clearAttributes must be true when present');
    }
    wire.clearAttributes = true;
  }
  if ('attributes' in patch) {
    wire.attributes = validateAttributes(patch.attributes);
  }

  return wire;
}
