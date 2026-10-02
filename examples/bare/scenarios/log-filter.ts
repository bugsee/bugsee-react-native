/**
 * The log-filter scenario Task 9.2 drives on a device
 * (e2e/log-filter.test.ts).
 *
 * After `Launched` it installs `Bugsee.setLogFilter` and then calls
 * `Bugsee.log` on the next line, with no await between them. That first line
 * is rewritten. A second line is rewritten the same way. A third line's
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

/** How long to wait, after the lines are sent, before uploading. */
const UPLOAD_AFTER_MS = 5_000;

/**
 * A line that is not one of the probes is returned unchanged, so the SDK's
 * own log capture still records.
 */
export function installLogFilter(nonce: string): void {
  Bugsee.setLogFilter((line) => {
    if (
      line.includes(`log-filter immediate ${nonce}`) ||
      line.includes(`log-filter rewrite ${nonce}`)
    ) {
      return line.replace('SECRET', 'REDACTED');
    }
    if (line.includes(`log-filter hang ${nonce}`)) {
      return new Promise(() => {});
    }
    return line;
  });
}

/**
 * Called once the SDK reaches `Launched`. `setLogFilter` and the first
 * `Bugsee.log` are adjacent: nothing is awaited between them, so the native
 * registration has to have finished before `setLogFilter` returns.
 */
export function runLogFilterScenario(nonce: string): void {
  installLogFilter(nonce);
  Bugsee.log(`log-filter immediate ${nonce} SECRET`, LogLevel.Warning);
  mark(`filter installed nonce=${nonce}`);
  mark(`immediate sent nonce=${nonce}`);
  Bugsee.log(`log-filter rewrite ${nonce} SECRET`, LogLevel.Warning);
  mark(`rewrite sent nonce=${nonce}`);
  Bugsee.log(`log-filter hang ${nonce} SECRET`, LogLevel.Warning);
  mark(`hang sent nonce=${nonce}`);
  setTimeout(() => {
    Bugsee.upload(`log-filter-${nonce}`, '');
    mark(`uploaded nonce=${nonce}`);
  }, UPLOAD_AFTER_MS);
}
