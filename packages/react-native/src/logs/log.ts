import NativeBugsee from '../NativeBugsee';
import { LogLevel } from '../options/enums';

const LEVELS: ReadonlySet<number> = new Set(Object.values(LogLevel));

/**
 * The app's own line, through the SDK's public `Bugsee.log` -- not the
 * wrapper channel, which carries only what this wrapper captured on its own
 * (`console.*`, RCTLog) and records nothing with `capture.logs` off
 * (`bugsee/specs` `sdk/wrapper-channel`).
 *
 * Native passes `requiresFiltering`, so the app's log filter still runs on
 * the line, natively and once, as it did while the line went through the
 * channel. Without the flag the native `Bugsee.log` skips the filter.
 *
 * The level crosses by value, 1 Error .. 5 Verbose, as on the channel
 * (`forwardLog`), and is rejected here otherwise, for the same reasons.
 */
export function log(message: string, level: LogLevel = LogLevel.Info): void {
  if (typeof message !== 'string') {
    throw new TypeError(`Bugsee.log requires message to be a string, got ${typeof message}`);
  }
  if (!LEVELS.has(level)) {
    throw new RangeError('Bugsee.log requires a LogLevel (1-5)');
  }
  NativeBugsee.log(message, level);
}
