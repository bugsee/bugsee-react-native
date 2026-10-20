/**
 * Builds and crosses a JS exception payload to the TurboModule stubs.
 *
 * Dedupes object values through two WeakSets, one per kind (`markReported`). Handled
 * `AggregateError`s are split (R14, first {@link EXCEPTION_MAX_AGGREGATE});
 * unhandled ones stay one report. Never throws from `reportHandled`; never
 * rejects from `reportUnhandled`.
 */

import { Platform } from 'react-native';
import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';
import { currentDebugIds } from './debugIds';
import { buildExceptionPayload } from './payload';
import { encodeExceptionOptions, type ExceptionOptions } from './options';

/** How long JS waits for native to take an unhandled exception: iOS. */
export const UNHANDLED_REPORT_WAIT_MS = 1500;
/**
 * The same on Android. Android's native call has no deadline of its own and
 * resolves the moment the SDK returns (median about 1.15 s on a mid-range
 * phone), so this only bounds a hung SDK. It must not be shorter than the
 * SDK's own worst case: 7.3.1 persists the exception payload only after the
 * report's view-hierarchy step, which alone may take 1000 + 500 + 250 ms, and
 * a fatal's process dies soon after this wait ends. At 1500 ms 1 natural JS
 * fatal in 10 lost its payload (`crash` absent `export_failed`;
 * https://github.com/bugsee/bugsee-android/issues/251).
 */
export const UNHANDLED_REPORT_WAIT_MS_ANDROID = 5000;

/** {@link UNHANDLED_REPORT_WAIT_MS_ANDROID} on Android, else {@link UNHANDLED_REPORT_WAIT_MS}. */
export function unhandledReportWaitMs(): number {
  return Platform.OS === 'android' ? UNHANDLED_REPORT_WAIT_MS_ANDROID : UNHANDLED_REPORT_WAIT_MS;
}
export const EXCEPTION_MAX_AGGREGATE = 10;

/** Objects reported in any form (handled or unhandled). */
const reported = new WeakSet<object>();
/** Objects reported as a crash. A handled report does not enter this set. */
const reportedUnhandled = new WeakSet<object>();

/**
 * true the first time an object is seen (WeakSet); always true for a primitive.
 *
 * A crash is never blocked by an earlier handled report of the same object,
 * so `logException(e)` followed by a rethrow that ends the app still reports
 * the crash. Anything already reported as a crash blocks every later report,
 * handled or not. Pass `'unhandled'` from the crash routes.
 */
export function markReported(
  error: unknown,
  kind: 'handled' | 'unhandled' = 'handled',
): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return true;
  }
  const key = error as object;
  if (kind === 'unhandled') {
    if (reportedUnhandled.has(key)) {
      return false;
    }
    reportedUnhandled.add(key);
    reported.add(key);
    return true;
  }
  if (reported.has(key)) {
    return false;
  }
  reported.add(key);
  return true;
}

type Extras = { componentStack?: string; fallbackStack?: string };

function platformOS(): 'android' | 'ios' {
  // PayloadInput accepts only these two; other Platform.OS values follow iOS.
  // Stryker disable next-line ConditionalExpression,StringLiteral -- ios branch needs a Platform.OS='ios' mock; android-only suite leaves the ios literal equivalent to ""
  return Platform.OS === 'android' ? 'android' : 'ios';
}

function payloadJson(error: unknown, extras?: Extras): string {
  const payload = buildExceptionPayload({
    error,
    platformOS: platformOS(),
    componentStack: extras?.componentStack,
    fallbackStack: extras?.fallbackStack,
    debugIds: currentDebugIds(),
  });
  return encodeBridgeObject(payload as unknown as Record<string, unknown>);
}

function isAggregateError(value: unknown): value is AggregateError {
  // Stryker disable next-line ConditionalExpression,StringLiteral -- AggregateError is always defined in our Jest/RN targets; the typeof guard is a belt-and-braces for older engines
  return typeof AggregateError !== 'undefined' && value instanceof AggregateError;
}

function sendHandled(
  error: unknown,
  options: ExceptionOptions | undefined,
  extras: Extras | undefined,
): void {
  const optionsJson = encodeExceptionOptions(options);
  NativeBugsee.logException(payloadJson(error, extras), optionsJson);
}

/**
 * Reports `error` as handled. Never throws; R14 splits an AggregateError into
 * at most {@link EXCEPTION_MAX_AGGREGATE} inner reports.
 *
 * Callers claim the value with {@link markReported} first. This function does
 * not re-claim the top-level `error` (handlers and the facade share the
 * same WeakSets); it still marks AggregateError inners so a shared Error crosses
 * once whichever route saw it first.
 */
export function reportHandled(
  error: unknown,
  options?: ExceptionOptions,
  extras?: Extras,
): void {
  try {
    if (isAggregateError(error)) {
      const inners = Array.isArray(error.errors) ? error.errors : [];
      const limit = Math.min(inners.length, EXCEPTION_MAX_AGGREGATE);
      for (let i = 0; i < limit; i += 1) {
        try {
          if (!markReported(inners[i])) {
            continue;
          }
          sendHandled(inners[i], options, extras);
        } catch {
          // A single inner must not stop the rest, and must not escape.
        }
      }
      return;
    }
    sendHandled(error, options, extras);
  } catch {
    // never throws
  }
}

let warnedUnhandledNativeFailure = false;

function warnUnhandledNativeFailureOnce(): void {
  if (warnedUnhandledNativeFailure) {
    return;
  }
  warnedUnhandledNativeFailure = true;
  console.warn('[Bugsee] logUnhandledException native call failed');
}

/**
 * Reports `error` as unhandled. Resolves when native resolves or after
 * {@link unhandledReportWaitMs}, whichever is first; never rejects.
 *
 * Callers claim the value with {@link markReported} first (same shared
 * WeakSets as {@link reportHandled}; a prior handled claim does not block a crash).
 */
export async function reportUnhandled(
  error: unknown,
  extras?: Extras,
): Promise<void> {
  let nativePromise: Promise<void>;
  try {
    nativePromise = Promise.resolve(NativeBugsee.logUnhandledException(payloadJson(error, extras)));
  } catch {
    warnUnhandledNativeFailureOnce();
    return;
  }

  const guarded = nativePromise.then(
    () => undefined,
    () => {
      warnUnhandledNativeFailureOnce();
    },
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, unhandledReportWaitMs());
  });

  try {
    await Promise.race([guarded, timeout]);
  } finally {
    // Stryker disable all -- clearTimeout is unobservable in unit tests; emptying this finally is equivalent under the suite
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    // Stryker restore all
  }
}
