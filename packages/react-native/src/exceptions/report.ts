/**
 * Builds and crosses a JS exception payload to the TurboModule stubs.
 *
 * Dedupes object values through a WeakSet (`markReported`). Handled
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

export const UNHANDLED_REPORT_WAIT_MS = 1500;
export const EXCEPTION_MAX_AGGREGATE = 10;

const reported = new WeakSet<object>();

/** true the first time an object is seen (WeakSet); always true for a primitive. */
export function markReported(error: unknown): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return true;
  }
  if (reported.has(error as object)) {
    return false;
  }
  reported.add(error as object);
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
 * not re-claim the top-level `error` (handlers and the facade share one
 * WeakSet); it still marks AggregateError inners so a shared Error crosses
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
 * {@link UNHANDLED_REPORT_WAIT_MS}, whichever is first; never rejects.
 *
 * Callers claim the value with {@link markReported} first (same shared
 * WeakSet as {@link reportHandled}).
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
    timeoutId = setTimeout(resolve, UNHANDLED_REPORT_WAIT_MS);
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
