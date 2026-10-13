import { errorName } from '../errorName';
import { measurePass } from './ancestry';

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

function measureAll(): void {
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

/** One pass: a ScrollView shared by many measurers is measured once. */
function tick(): void {
  measurePass(measureAll);
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

/** A frame, for the fallback where there is no `requestAnimationFrame`. */
export const FRAME_MS = 16;

/** Instances that re-measure every frame: withdrawn as hidden, or clipped. */
const frameMeasurers = new Set<Registration>();

/** Cancels the pending frame; set exactly while one is pending. */
let cancelFrame: (() => void) | undefined;

/**
 * Runs `callback` before the next frame, returning what cancels it. Looked
 * up per call, so it follows whatever the runtime provides at the time.
 */
function requestFrame(callback: () => void): () => void {
  const { requestAnimationFrame: request, cancelAnimationFrame: cancel } = globalThis as {
    requestAnimationFrame?: (callback: () => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  if (request === undefined || cancel === undefined) {
    const timer = setTimeout(callback, FRAME_MS);
    return () => clearTimeout(timer);
  }
  const handle = request(callback);
  return () => cancel(handle);
}

/** Every frame measurer, in one measure pass, then the next frame if any are left. */
function frame(): void {
  cancelFrame = undefined;
  measurePass(() => {
    for (const { measure } of [...frameMeasurers]) {
      try {
        measure();
      } catch (error) {
        console.warn('[Bugsee] a secure-region measurer threw', errorName(error));
      }
    }
  });
  if (frameMeasurers.size > 0) {
    cancelFrame ??= requestFrame(frame);
  }
}

/**
 * Calls `measure` before every frame until the returned function is called.
 * One frame callback serves every frame measurer, in one measure pass, so a
 * ScrollView they share is measured once a frame, and it runs only while
 * there is at least one.
 */
export function addFrameMeasurer(measure: () => void): () => void {
  const registration: Registration = { measure };
  frameMeasurers.add(registration);
  cancelFrame ??= requestFrame(frame);

  return () => {
    frameMeasurers.delete(registration);
    if (frameMeasurers.size === 0) {
      cancelFrame?.();
      cancelFrame = undefined;
    }
  };
}
