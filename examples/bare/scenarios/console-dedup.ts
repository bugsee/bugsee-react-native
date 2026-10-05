/**
 * Task 9.7: one console call, one filter pass, in Debug and in Release.
 *
 * The filter appends `#N` and counts. Two routes would make `calls` 2, or
 * a second event. The patch still forwards in Release: RCTLog does not
 * carry `console.*` there, so dropping the patch would leave this line out.
 *
 * Two lines, one per echo the native side must drop. The `BUGSEE_E2E`
 * marker line is NSLogged on iOS, so its echo is a stamped stderr line. The
 * `dedup-raw` line is not a marker: in an iOS Debug build it takes only the
 * example's raw stderr mirror, so its echo is an unstamped stdio line. Each
 * is counted on its own (`calls`, `rawCalls`).
 *
 * `duration` stays 90. This scenario does not pass launch options.
 */
import Bugsee from '@bugsee/react-native';

export const CONSOLE_DEDUP_SCENARIOS = ['console-dedup'] as const;

export type ConsoleDedupScenario = (typeof CONSOLE_DEDUP_SCENARIOS)[number];

export function isConsoleDedupScenario(name: string): name is ConsoleDedupScenario {
  return (CONSOLE_DEDUP_SCENARIOS as readonly string[]).includes(name);
}

/** How long to wait for a late echo before uploading. */
const UPLOAD_AFTER_MS = 2_000;

function mark(message: string): void {
  console.log(`BUGSEE_E2E dedup-result ${message}`);
}

/** Called once the SDK reaches `Launched`. */
export function runConsoleDedupScenario(nonce: string): void {
  let calls = 0;
  let rawCalls = 0;
  Bugsee.setLogFilter((line) => {
    if (line.includes(`dedup-line ${nonce}`)) {
      calls += 1;
      return `${line} #${calls}`;
    }
    if (line.includes(`dedup-raw ${nonce}`)) {
      rawCalls += 1;
      return `${line} #${rawCalls}`;
    }
    return line;
  });
  console.log(`BUGSEE_E2E dedup-line ${nonce}`);
  // No BUGSEE_E2E prefix on purpose: see the file comment.
  console.log(`dedup-raw ${nonce}`);
  setTimeout(() => {
    mark(`nonce=${nonce} calls=${calls} rawCalls=${rawCalls}`);
    Bugsee.upload(`dedup-${nonce}`, '');
  }, UPLOAD_AFTER_MS);
}
