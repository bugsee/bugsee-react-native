/**
 * The log-filter scenario Task 9.2 drives on a device
 * (e2e/log-filter.test.ts).
 *
 * After `Launched` it installs `Bugsee.setLogFilter` and then calls
 * `Bugsee.log` with `requiresFiltering` on the next line, with no await
 * between them. `log()` runs the filter in JS, inside the call, so that first
 * line is rewritten before it crosses the bridge. A second line is rewritten
 * the same way. A third line's callback never settles: `log()` drops it after
 * 10 s, and the upload at 5 s comes first, so the line is never sent. This
 * scenario does not add a timeout that would pass the line through. A fourth
 * line is sent without `requiresFiltering`, so the filter never sees it and it
 * is recorded as sent.
 *
 * The upload waits long enough for the rewritten lines to be recorded, and
 * not long enough for a second, local timeout to matter: the recording
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
      line.includes(`log-filter rewrite ${nonce}`) ||
      line.includes(`log-filter unfiltered ${nonce}`)
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
 * `Bugsee.log` are adjacent: nothing is awaited between them, so the filter
 * has to be in place when `setLogFilter` returns.
 */
export function runLogFilterScenario(nonce: string): void {
  installLogFilter(nonce);
  Bugsee.log(`log-filter immediate ${nonce} SECRET`, LogLevel.Warning, true);
  mark(`filter installed nonce=${nonce}`);
  mark(`immediate sent nonce=${nonce}`);
  Bugsee.log(`log-filter rewrite ${nonce} SECRET`, LogLevel.Warning, true);
  mark(`rewrite sent nonce=${nonce}`);
  Bugsee.log(`log-filter hang ${nonce} SECRET`, LogLevel.Warning, true);
  mark(`hang sent nonce=${nonce}`);
  Bugsee.log(`log-filter unfiltered ${nonce} SECRET`, LogLevel.Warning);
  mark(`unfiltered sent nonce=${nonce}`);
  setTimeout(() => {
    Bugsee.upload(`log-filter-${nonce}`, '');
    mark(`uploaded nonce=${nonce}`);
  }, UPLOAD_AFTER_MS);
}
