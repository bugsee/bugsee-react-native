import { errorName } from '../errorName';
import { measureFiber, measurePass } from './ancestry';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

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

/**
 * How many parked instances (clipped, and still) the tick re-checks, in
 * turn: their ScrollViews are watched every frame, so the tick only catches
 * what moves them otherwise, and a hundred of them must not cost a tick a
 * hundred measurements.
 */
export const PARKED_CHECKS_PER_TICK = 32;

/** Parked instances' checks, in the order they take turns. */
const parked: Registration[] = [];

/** Where the next tick's turns start in `parked`. */
let parkedCursor = 0;

function checkParked(): void {
  const turns = Math.min(PARKED_CHECKS_PER_TICK, parked.length);
  // A snapshot: a check may park or unpark one while the tick runs.
  const queue = [...parked];
  for (let turn = 0; turn < turns; turn += 1) {
    const registration = queue[(parkedCursor + turn) % queue.length] as Registration;
    try {
      registration.measure();
    } catch (error) {
      console.warn('[Bugsee] a secure-region measurer threw', errorName(error));
    }
  }
  parkedCursor = queue.length === 0 ? 0 : (parkedCursor + turns) % queue.length;
}

/** One pass: a ScrollView shared by many measurers is measured once. */
function tick(): void {
  measurePass(() => {
    measureAll();
    checkParked();
  });
}

/**
 * Adds `check` to the parked instances the tick re-checks in turn, at most
 * {@link PARKED_CHECKS_PER_TICK} a tick, until the returned function is
 * called. Only while some measurer keeps the tick running.
 */
export function addParked(check: () => void): () => void {
  const registration: Registration = { measure: check };
  parked.push(registration);
  return () => {
    const index = parked.indexOf(registration);
    if (index >= 0) {
      parked.splice(index, 1);
    }
  };
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

interface WatchedNode {
  /** What moved callbacks to call; a callback per subscription. */
  readonly subscribers: Set<{ readonly moved: () => void }>;
  /** Where the node was at the last frame, `undefined` before its first. */
  last: string | undefined;
}

/** Nodes measured every frame (a ScrollView's content, a clipping view), by fiber. */
const watched = new Map<FiberLike, WatchedNode>();

function where(rect: WindowRect | null | undefined): string {
  return rect == null ? String(rect) : `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

/** Measures every watched node once, and wakes the subscribers of each that moved. */
function watchNodes(): void {
  for (const [fiber, node] of [...watched]) {
    let now: string;
    try {
      now = where(measureFiber(fiber));
    } catch {
      // Stryker disable next-line StringLiteral -- any marker no rectangle reads as does
      now = 'throws';
    }
    if (node.last !== undefined && node.last !== now) {
      for (const { moved } of [...node.subscribers]) {
        moved();
      }
    }
    node.last = now;
  }
}

/** Watched nodes, then every frame measurer, in one measure pass; then the next frame if any are left. */
function frame(): void {
  cancelFrame = undefined;
  try {
    measurePass(() => {
      watchNodes();
      for (const { measure } of [...frameMeasurers]) {
        try {
          measure();
        } catch (error) {
          console.warn('[Bugsee] a secure-region measurer threw', errorName(error));
        }
      }
    });
  } finally {
    // In a finally: nothing thrown above (a warn included) may stop the loop.
    if (frameMeasurers.size > 0 || watched.size > 0) {
      cancelFrame ??= requestFrame(frame);
    }
  }
}

/**
 * Measures `fiber` every frame, and calls `moved` whenever it is somewhere
 * else than the frame before, until the returned function is called. Every
 * subscriber of one fiber shares one measurement a frame, and so does every
 * fiber of one host.
 */
export function watchNode(fiber: FiberLike, moved: () => void): () => void {
  let node = watched.get(fiber);
  if (node === undefined) {
    node = { subscribers: new Set(), last: undefined };
    watched.set(fiber, node);
  }
  const subscription = { moved };
  node.subscribers.add(subscription);
  cancelFrame ??= requestFrame(frame);
  const target = node;
  return () => {
    target.subscribers.delete(subscription);
    if (target.subscribers.size === 0 && watched.get(fiber) === target) {
      watched.delete(fiber);
    }
    stopFramesIfIdle();
  };
}

function stopFramesIfIdle(): void {
  if (frameMeasurers.size === 0 && watched.size === 0) {
    cancelFrame?.();
    cancelFrame = undefined;
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
    stopFramesIfIdle();
  };
}
