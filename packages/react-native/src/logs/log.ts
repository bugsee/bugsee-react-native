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
 * it was logged. A throw, a rejection, a timeout, or anything that is not a
 * string drops the line. A filtered line logged while the filter runs, before
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
    NativeBugsee.log(result, level, false);
  } else if (typeof result?.then === 'function') {
    sendWhenSettled(result, level);
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
function sendWhenSettled(result: PromiseLike<unknown>, level: LogLevel): void {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
  }, FILTER_TIMEOUT_MS);
  Promise.resolve(result)
    .then((line) => {
      if (!expired && typeof line === 'string') {
        NativeBugsee.log(line, level, false);
      }
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
