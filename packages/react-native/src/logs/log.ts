import { Platform } from 'react-native';

import NativeBugsee from '../NativeBugsee';
import { LogLevel } from '../options/enums';
import { currentLogFilter, type LogFilter } from './filter';

const LEVELS: ReadonlySet<number> = new Set(Object.values(LogLevel));

/**
 * How long a filter's promise is waited on. Android's SDK drops a line whose
 * filter has not answered in 10 s (`FILTER_CALLBACK_TIMEOUT_MS`); the filter
 * now runs here, so the bound does too. On expiry the line is dropped, never
 * passed through.
 */
const FILTER_TIMEOUT_MS = 10_000;

/** Set while the app's filter runs synchronously inside `log()`. */
let insideFilter = false;

/**
 * Counts the sessions the wrapper has been told about: bumped when `launch`,
 * `relaunch`, `attach` or `stop` is called. A filtered line whose filter settles
 * later is sent only if no such call happened in between: native would record it
 * in whichever session is live then, which can be a later one (or none), not the
 * one the line was logged in.
 *
 * The bump is on the call, whether or not the call takes effect (a `launch` that
 * resolves `false` because the SDK already runs, a `stop` on a stopped SDK). That
 * can drop a line in a session that did not change; it never records one in the
 * wrong session, and bumping only after the native call resolved would let a line
 * logged during that window through.
 */
let session = 0;

/** A session starts or ends: lines still waiting on a filter are not sent. */
export function endLogSession(): void {
  session += 1;
}

/** `result.then` is app code's object: reading it can throw. */
function isThenable(result: unknown): result is PromiseLike<unknown> {
  try {
    return typeof (result as { then?: unknown } | null | undefined)?.then === 'function';
  } catch {
    return false;
  }
}

/**
 * The app's own line, through the SDK's public `Bugsee.log` -- not the
 * wrapper channel, which carries only what this wrapper captured on its own
 * (`console.*`, RCTLog) and records nothing with `capture.logs` off
 * (`bugsee/specs` `sdk/wrapper-channel`).
 *
 * As in the native SDKs, the app's log filter skips the line unless
 * `requiresFiltering` is `true`. Then it runs here, on the JS thread, inside
 * this call: the filter lives in JS, and asking it through native would cross
 * the bridge three times for one line. Native gets the result with
 * `requiresFiltering` false, so the filter does not run on it again.
 *
 * A string the filter returns is sent at once. A promise is waited on for at
 * most `FILTER_TIMEOUT_MS`; the line is then stamped when it settles, not when
 * it was logged, and only if no `launch`, `relaunch`, `attach` or `stop` was
 * called meanwhile (it would land in another session). A throw, a rejection, a
 * timeout, or anything that is not a string drops the line. On iOS an empty
 * `message` is never sent, whatever the filter returns: the SDK drops an empty
 * line before it filters, so a replacement would record a line it never records. A filtered line logged while the filter runs, before
 * it returns, is dropped too: filtering it would recurse. One logged later,
 * after an `await` or in a callback, is filtered again.
 *
 * The level crosses by value, 1 Error .. 5 Verbose, as on the channel
 * (`forwardLog`), and is rejected here otherwise, for the same reasons.
 */
export function log(
  message: string,
  level: LogLevel = LogLevel.Info,
  requiresFiltering: boolean = false,
): void {
  if (typeof message !== 'string') {
    throw new TypeError(`Bugsee.log requires message to be a string, got ${typeof message}`);
  }
  if (!LEVELS.has(level)) {
    throw new RangeError('Bugsee.log requires a LogLevel (1-5)');
  }
  if (typeof requiresFiltering !== 'boolean') {
    throw new TypeError(
      `Bugsee.log requires requiresFiltering to be a boolean, got ${typeof requiresFiltering}`,
    );
  }
  const filter = requiresFiltering ? currentLogFilter() : undefined;
  if (filter === undefined) {
    NativeBugsee.log(message, level, false);
    return;
  }
  if (insideFilter) {
    return;
  }
  const loggedIn = session;
  const dropsEmpty = Platform.OS === 'ios' && message === '';
  let result: ReturnType<LogFilter>;
  insideFilter = true;
  try {
    result = filter(message);
  } catch {
    return;
  } finally {
    insideFilter = false;
  }
  if (typeof result === 'string') {
    // The filter itself may have called launch/relaunch/attach/stop before returning.
    if (!dropsEmpty && loggedIn === session) NativeBugsee.log(result, level, false);
  } else if (isThenable(result)) {
    sendWhenSettled(result, level, loggedIn, dropsEmpty);
  }
}

/**
 * Sends the string `result` settles to, if it settles in time. Nothing here
 * reaches the caller: a rejection drops the line, and so does a native throw
 * once the bridge is gone.
 *
 * An answer that comes due with the deadline can land on either side of it.
 * It is sent when its microtasks run before this timer: bridgeless drains them
 * after each timer, and iOS fires the timer set first first. It is dropped
 * otherwise: on the bridge `JSTimers` runs timers due together in one batch,
 * and Android does not order timers due in the same millisecond. Either way
 * the original line is never sent.
 */
function sendWhenSettled(
  result: PromiseLike<unknown>,
  level: LogLevel,
  loggedIn: number,
  dropsEmpty: boolean,
): void {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
  }, FILTER_TIMEOUT_MS);
  Promise.resolve(result)
    .then((line) => {
      if (!expired && typeof line === 'string' && loggedIn === session && !dropsEmpty) {
        NativeBugsee.log(line, level, false);
      }
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
