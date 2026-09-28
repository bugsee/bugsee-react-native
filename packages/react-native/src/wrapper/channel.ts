import NativeBugsee from '../NativeBugsee';
import { LogLevel } from '../options/enums';

const LEVELS: ReadonlySet<number> = new Set(Object.values(LogLevel));

/**
 * Sends one line into the SDK's wrapper channel, attributed to the wrapper.
 *
 * Internal, and deliberately not exported from the package entry: Phase 4's
 * `log()` and Phase 9's `console.*` routing build on this, and there is to be
 * one native route for wrapper lines, not two.
 *
 * The app's log filter is NOT run here. Every channel line is filtered
 * natively, once (design doc §10.3); running it in JS as well would call a
 * customer's filter twice on one line.
 *
 * The level crosses by value, 1 Error .. 5 Verbose, identical on both
 * platforms. Anything else is rejected here rather than left to the native
 * default: 0 is iOS's `BugseeLogLevelInvalid`, and a fraction reaches Android
 * as a double that truncates into a level nobody asked for.
 */
export function forwardLog(message: string, level: LogLevel = LogLevel.Info): void {
  if (typeof message !== 'string') {
    throw new TypeError(`forwardLog requires message to be a string, got ${typeof message}`);
  }
  if (!LEVELS.has(level)) {
    throw new RangeError(
      `forwardLog requires a LogLevel (1-5), got ${String(level)}`,
    );
  }
  NativeBugsee.wrapperLog(message, level);
}
