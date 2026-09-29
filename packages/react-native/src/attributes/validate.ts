/**
 * The value domain `Bugsee.setAttribute` accepts, and the domain a read can
 * come back as.
 *
 * The domain is the intersection of both native SDKs (design doc Phase 5,
 * "Planner decisions"): `string | number | boolean`. Android also takes
 * `Set<String>`; iOS takes any property-list object. Neither is common to
 * both, so neither is accepted going in -- but a `Set<String>` can come back
 * OUT on Android, as a `string[]`, since `getAllAttributes`/`getAttribute`
 * must still be able to report a value an app (or an older wrapper) set that
 * way.
 */
import {
  BUNDLE_NUMBER_LIMIT_DECIMAL,
  isWithinBundleNumberLimit,
} from '../data/validate';
import { AttributeErrorCode, BugseeAttributeError } from './errors';

/** One value `setAttribute` accepts. */
export type AttributeValue = string | number | boolean;

/**
 * One value a read can report. `string[]` only ever comes back for a
 * `Set<String>` Android native code set directly -- `setAttribute` cannot
 * produce one.
 */
export type AttributeReadValue = string | number | boolean | string[];

/** Android's per-value string limit, inclusive, counted in UTF-16 units. */
export const ATTRIBUTE_STRING_MAX_LENGTH = 1024;

function badArgument(message: string): never {
  throw new BugseeAttributeError(AttributeErrorCode.BadArgument, message);
}

/** A short, human-legible name for a rejected value's type. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'object') {
    return (value as object).constructor?.name ?? 'object';
  }
  return typeof value;
}

/** Validates an attribute name: a non-empty string. Throws `BugseeAttributeError`. */
export function validateAttributeName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    badArgument(
      `attribute name must be a non-empty string, got ${describeType(name)}`,
    );
  }
  return name as string;
}

/**
 * Validates an attribute value against the accepted domain. Throws
 * `BugseeAttributeError` code `BadArgument` for anything outside it,
 * including a number failing {@link isWithinBundleNumberLimit} (which also covers
 * `NaN`/`Infinity`/`-Infinity`, all non-finite) or a string over
 * {@link ATTRIBUTE_STRING_MAX_LENGTH} UTF-16 units -- `.length` counts UTF-16
 * units natively, so no surrogate-aware counting is needed here.
 */
export function validateAttributeValue(value: unknown): AttributeValue {
  if (typeof value === 'string') {
    if (value.length > ATTRIBUTE_STRING_MAX_LENGTH) {
      badArgument(
        `attribute value must be at most ${ATTRIBUTE_STRING_MAX_LENGTH} ` +
          `UTF-16 units, got ${value.length}`,
      );
    }
    return value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!isWithinBundleNumberLimit(value)) {
      // Never echo the rejected value -- see
      // {@link BUNDLE_NUMBER_LIMIT_DECIMAL} for why even the bound itself
      // must not be printed via `Number`'s own string conversion.
      badArgument(
        `attribute value must be a finite number smaller than ` +
          `2^63 (${BUNDLE_NUMBER_LIMIT_DECIMAL}) in magnitude`,
      );
    }
    return value;
  }
  badArgument(
    `attribute value must be a string, a number or a boolean, got ${describeType(value)}`,
  );
}

/**
 * `raw` (whatever `getAttribute`'s native `{ value }` member held, or
 * `undefined` for a native `{}`) as an {@link AttributeReadValue}, or
 * `undefined` for anything that is not one -- including a native `{}`, since
 * its absent `value` member is already `undefined` by the time it gets here.
 */
export function normalizeAttributeReadValue(raw: unknown): AttributeReadValue | undefined {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return raw;
  }
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
    return [...(raw as string[])];
  }
  return undefined;
}

/**
 * `raw` (native `getAllAttributes`'s map, or `{}` for none) as a plain
 * record of {@link AttributeReadValue}s. A member whose value does not
 * normalize is dropped rather than surfaced as something it is not.
 *
 * Built on `Object.create(null)`: an attribute literally named `__proto__`
 * (a legal name on both SDKs) must be kept as an ordinary own key rather
 * than silently vanishing into a plain `{}`'s prototype setter.
 */
export function normalizeAttributesMap(raw: unknown): Record<string, AttributeReadValue> {
  const result: Record<string, AttributeReadValue> = Object.create(null);
  if (typeof raw !== 'object' || raw === null) {
    return result;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeAttributeReadValue(value);
    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }
  return result;
}

/**
 * `raw` (whatever `getUserIdentifier`'s native `{ value }` member held, or
 * `undefined` for a native `{}`) as the identifier, or `undefined` for
 * anything else -- including an empty string, which both SDKs treat as "no
 * identifier" (the ruling: an empty identifier clears, and a read reports it
 * as absent on both platforms).
 */
export function normalizeIdentifier(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Validates a `setUserIdentifier` argument: a string. Throws `TypeError`, synchronously. */
export function assertIdentifierString(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `Bugsee.setUserIdentifier requires a string, got ${describeType(value)}`,
    );
  }
}
