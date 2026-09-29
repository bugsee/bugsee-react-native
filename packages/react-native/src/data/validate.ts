/**
 * The value domain shared by `Bugsee.event` and `Bugsee.trace`.
 *
 * Both SDKs serialise nested maps, lists, strings, booleans, numbers and null
 * (design doc Phase 4, "Verified facts"), but neither does anything useful
 * with a value outside that set: a `Date` silently becomes whatever its
 * `HashMap`/`NSDictionary` conversion does with an opaque object, a cycle
 * hangs the native JSON writer, and `undefined` has no wire representation at
 * all. So everything here is checked and copied in JS, before crossing,
 * rather than left for native to discover.
 */

/** One value inside an event's params, recursively. */
export type EventParamValue =
  | string
  | number
  | boolean
  | null
  | readonly EventParamValue[]
  | { readonly [key: string]: EventParamValue | undefined };

/** An event's params: a plain object of {@link EventParamValue}s. */
export type EventParams = { readonly [key: string]: EventParamValue | undefined };

/** A trace's value: a string, a finite number or a boolean. */
export type TraceValue = string | number | boolean;

/**
 * Nesting past this is almost certainly a cycle or an accident, not a
 * deliberate payload. Rejected with the path that hit it.
 */
export const EVENT_PARAMS_MAX_DEPTH = 16;

/** A short, human-legible name for a rejected value's type. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') {
    if (value instanceof Date) return 'Date';
    if (value instanceof Map) return 'Map';
    if (value instanceof Set) return 'Set';
    if (ArrayBuffer.isView(value)) {
      return (value as object).constructor?.name ?? 'TypedArray';
    }
    return (value as object).constructor?.name ?? 'object';
  }
  return typeof value;
}

/**
 * A plain object: its prototype is `Object.prototype` or `null`. Excludes
 * arrays (their own branch), `Date`, `Map`, `Set`, typed arrays and class
 * instances, none of which either SDK's JSON writer round-trips faithfully.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One rejected value, at `path`, as a `TypeError` naming what it actually was. */
function rejectValue(path: string, value: unknown): never {
  throw new TypeError(
    `${path} must be a plain object, an array, a string, a finite number, ` +
      `a boolean or null; got ${describeType(value)}`,
  );
}

function copyValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${path} must be a finite number, got ${String(value)}`);
    }
    return value;
  }
  if (kind === 'object') {
    if (Array.isArray(value)) {
      return copyArray(value, path, depth, ancestors);
    }
    if (isPlainObject(value)) {
      return copyObject(value, path, depth, ancestors);
    }
  }
  return rejectValue(path, value);
}

function copyObject(
  obj: Record<string, unknown>,
  path: string,
  depth: number,
  ancestors: Set<object>,
): Record<string, unknown> {
  if (depth > EVENT_PARAMS_MAX_DEPTH) {
    throw new RangeError(
      `${path} nests deeper than the maximum of ${EVENT_PARAMS_MAX_DEPTH}`,
    );
  }
  if (ancestors.has(obj)) {
    throw new TypeError(`${path} is a cycle: it contains itself`);
  }
  ancestors.add(obj);
  try {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      // Omitted, as JSON.stringify does -- not an error. An array element
      // gets no such pass, since an array has no key to drop.
      if (value === undefined) continue;
      result[key] = copyValue(value, `${path}.${key}`, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(obj);
  }
}

function copyArray(
  arr: readonly unknown[],
  path: string,
  depth: number,
  ancestors: Set<object>,
): unknown[] {
  if (depth > EVENT_PARAMS_MAX_DEPTH) {
    throw new RangeError(
      `${path} nests deeper than the maximum of ${EVENT_PARAMS_MAX_DEPTH}`,
    );
  }
  if (ancestors.has(arr as object)) {
    throw new TypeError(`${path} is a cycle: it contains itself`);
  }
  ancestors.add(arr as object);
  try {
    const result: unknown[] = [];
    for (let i = 0; i < arr.length; i += 1) {
      const value = arr[i];
      if (value === undefined) {
        throw new TypeError(`${path}[${i}] must not be undefined`);
      }
      result.push(copyValue(value, `${path}[${i}]`, depth + 1, ancestors));
    }
    return result;
  } finally {
    ancestors.delete(arr as object);
  }
}

/**
 * Validates `params` against the accepted value domain and returns a fresh
 * plain copy, with `undefined` object members omitted.
 *
 * Throws `TypeError` for a value of the wrong type (naming its path, e.g.
 * `params.a.b[1]`) and `RangeError` for a non-finite number or nesting past
 * {@link EVENT_PARAMS_MAX_DEPTH}. The copy means a caller mutating its
 * original object afterwards cannot change what already crossed.
 */
export function copyEventParams(params: EventParams): Record<string, unknown> {
  if (!isPlainObject(params)) {
    throw new TypeError(
      `Bugsee.event requires params to be a plain object, got ${describeType(params)}`,
    );
  }
  return copyObject(params, 'params', 1, new Set());
}

/** Validates an event or trace name: a non-empty string. */
export function assertEventOrTraceName(
  kind: 'event' | 'trace',
  name: unknown,
): asserts name is string {
  if (typeof name !== 'string') {
    throw new TypeError(
      `Bugsee.${kind} requires name to be a string, got ${describeType(name)}`,
    );
  }
  if (name.length === 0) {
    throw new RangeError(`Bugsee.${kind} requires a non-empty name`);
  }
}

/** Validates a trace value: a string, a finite number or a boolean. */
export function assertTraceValue(value: unknown): asserts value is TraceValue {
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Bugsee.trace requires a finite number, got ${String(value)}`);
    }
    return;
  }
  throw new TypeError(
    `Bugsee.trace requires a string, a finite number or a boolean, got ${describeType(value)}`,
  );
}
