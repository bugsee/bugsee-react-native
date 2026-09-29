/**
 * The data scenario Task 4.3 drives on a device (e2e/data.test.ts).
 *
 * `data` sends log lines at every level, two events and four traces through
 * the public API once the SDK is `Launched`, then uploads, so the test can
 * read each back from the retained bundle's `log`, `events.user` and
 * `traces.user` files. One of each is also sent before `launch()`, which must
 * not reach the bundle: the log line is dropped by the inert channel, and the
 * event and trace by the SDK, which has no consumer before it starts.
 *
 * Every name and value carries the run's nonce, so nothing an earlier run
 * left behind can pass for this one.
 */
import Bugsee, { type EventParams, type LogLevel } from '@bugsee/react-native';

export const DATA_SCENARIOS = ['data'] as const;

export type DataScenario = (typeof DATA_SCENARIOS)[number];

export function isDataScenario(name: string): name is DataScenario {
  return (DATA_SCENARIOS as readonly string[]).includes(name);
}

/**
 * The event params, one of each value kind the bridge must carry. The e2e
 * holds its own copy of this shape (e2e/data.test.ts `paramsFor`): the two
 * must agree, and the test would fail if they did not.
 */
export function dataParams(nonce: string): EventParams {
  return {
    str: `s-${nonce}`,
    int: 3,
    neg: -7,
    frac: 1.5,
    big: 9007199254740991,
    yes: true,
    no: false,
    nil: null,
    nested: { list: [1, 'two', { deep: false }], empty: {} },
    skipped: undefined,
  };
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E data ${message}`);
}

/**
 * Called before `launch()`. Sends what must be dropped, then marks having
 * sent it -- so the e2e can assert this really ran before `launch()` rather
 * than assume it from source order.
 */
export function preLaunchDataProbe(nonce: string): void {
  Bugsee.log(`pre-${nonce}`);
  Bugsee.event(`pre-${nonce}`);
  Bugsee.trace(`pre-${nonce}`, 1);
  mark(`pre-sent nonce=${nonce}`);
}

/** Called once the SDK reaches `Launched`. */
export function runDataScenario(nonce: string): void {
  for (let level = 1; level <= 5; level += 1) {
    Bugsee.log(`BUGSEE_E2E data log L${level} ${nonce}`, level as LogLevel);
  }
  Bugsee.log(`BUGSEE_E2E data log default ${nonce}`);

  Bugsee.event(`data-${nonce}`, dataParams(nonce));
  Bugsee.event(`data-bare-${nonce}`);

  Bugsee.trace(`data-num-${nonce}`, 42);
  Bugsee.trace(`data-frac-${nonce}`, 0.25);
  Bugsee.trace(`data-str-${nonce}`, 'on');
  Bugsee.trace(`data-bool-${nonce}`, true);

  mark(`sent nonce=${nonce}`);
  Bugsee.upload(`data-${nonce}`, '');
}
