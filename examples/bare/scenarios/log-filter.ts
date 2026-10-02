/**
 * The log-filter scenario Task 9.2 drives on a device
 * (e2e/log-filter.test.ts).
 *
 * Installs `Bugsee.setLogFilter` before `launch()`. After `Launched` it sends
 * two `Bugsee.log` lines. The filter rewrites the first. The second's
 * callback never settles, so the SDK's own timeout drops it; this scenario
 * does not add a timeout that would pass the line through.
 *
 * The upload waits long enough for the rewrite's round trip to be recorded,
 * and not long enough for a second, local timeout to matter: the recording
 * `duration` stays the app's 90.
 */
import Bugsee, { LogLevel } from '@bugsee/react-native';

export const LOG_FILTER_SCENARIOS = ['log-filter'] as const;

export type LogFilterScenario = (typeof LOG_FILTER_SCENARIOS)[number];

export function isLogFilterScenario(name: string): name is LogFilterScenario {
  return (LOG_FILTER_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E log-filter ${message}`);
}

/** How long to wait, after both lines are sent, before uploading. */
const UPLOAD_AFTER_MS = 5_000;

/**
 * Called before `launch()`. The filter has to be in place before the lines
 * below are sent. A line that is not one of the two probes is returned
 * unchanged, so the SDK's own log capture still records.
 */
export function installLogFilter(nonce: string): void {
  Bugsee.setLogFilter((line) => {
    if (line.includes(`log-filter rewrite ${nonce}`)) {
      return line.replace('SECRET', 'REDACTED');
    }
    if (line.includes(`log-filter hang ${nonce}`)) {
      return new Promise(() => {});
    }
    return line;
  });
  mark(`filter installed nonce=${nonce}`);
}

/** Called once the SDK reaches `Launched`. */
export function runLogFilterScenario(nonce: string): void {
  Bugsee.log(`log-filter rewrite ${nonce} SECRET`, LogLevel.Warning);
  mark(`rewrite sent nonce=${nonce}`);
  Bugsee.log(`log-filter hang ${nonce} SECRET`, LogLevel.Warning);
  mark(`hang sent nonce=${nonce}`);
  setTimeout(() => {
    Bugsee.upload(`log-filter-${nonce}`, '');
    mark(`uploaded nonce=${nonce}`);
  }, UPLOAD_AFTER_MS);
}
