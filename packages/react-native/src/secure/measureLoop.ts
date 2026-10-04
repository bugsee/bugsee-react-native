import { errorName } from '../errorName';

/**
 * How often every mounted `<BugseeSecure>` re-measures itself.
 *
 * `onLayout` does not fire when an ancestor scrolls, so a region measured only
 * on layout stays where the view was while the view itself moves on screen and
 * is recorded. 100 ms is well under the SDK's ~350 ms pull interval.
 */
export const SECURE_REMEASURE_MS = 100;

interface Registration {
  readonly measure: () => void;
}

/** A registration per call, so one function added twice is two measurers. */
const measurers = new Set<Registration>();

/** Stops the running interval; set exactly while one is running. */
let stopTimer: (() => void) | undefined;

function tick(): void {
  // A snapshot: a measurer may add or remove one while the tick runs.
  for (const { measure } of [...measurers]) {
    // One broken measurer must not leave the rest stale for this tick.
    try {
      measure();
    } catch (error) {
      console.warn('[Bugsee] a secure-region measurer threw', errorName(error));
    }
  }
}

/**
 * Calls `measure` every `SECURE_REMEASURE_MS` until the returned function is
 * called. One interval serves every measurer, and it runs only while there is
 * at least one.
 */
export function addMeasurer(measure: () => void): () => void {
  const registration: Registration = { measure };
  measurers.add(registration);
  if (stopTimer === undefined) {
    const timer = setInterval(tick, SECURE_REMEASURE_MS);
    stopTimer = () => clearInterval(timer);
  }

  return () => {
    measurers.delete(registration);
    if (measurers.size === 0) {
      stopTimer?.();
      stopTimer = undefined;
    }
  };
}
