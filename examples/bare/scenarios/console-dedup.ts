/**
 * Task 9.7: one console call, one filter pass, in Debug and in Release.
 *
 * The filter appends `#N` and counts. Two routes would make `calls` 2, or
 * a second event. The patch still forwards in Release: RCTLog does not
 * carry `console.*` there, so dropping the patch would leave this line out.
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
  Bugsee.setLogFilter((line) => {
    if (line.includes(`dedup-line ${nonce}`)) {
      calls += 1;
      return `${line} #${calls}`;
    }
    return line;
  });
  console.log(`BUGSEE_E2E dedup-line ${nonce}`);
  setTimeout(() => {
    mark(`nonce=${nonce} calls=${calls}`);
    Bugsee.upload(`dedup-${nonce}`, '');
  }, UPLOAD_AFTER_MS);
}
