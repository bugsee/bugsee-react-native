import NativeBugsee from '../NativeBugsee';
import { LogLevel } from '../options/enums';

const LEVELS: ReadonlySet<number> = new Set(Object.values(LogLevel));

/**
 * The app's own line, through the SDK's public `Bugsee.log` -- not the
 * wrapper channel, which carries only what this wrapper captured on its own
 * (`console.*`, RCTLog) and records nothing with `capture.logs` off
 * (`bugsee/specs` `sdk/wrapper-channel`).
 *
 * `requiresFiltering` is passed through as the app chose it. As in the
 * native SDKs, the app's log filter skips the line unless it is `true`; then
 * the filter runs on it natively, once.
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
  NativeBugsee.log(message, level, requiresFiltering);
}
