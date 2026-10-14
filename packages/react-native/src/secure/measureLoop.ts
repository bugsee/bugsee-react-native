import { errorName } from '../errorName';
import { measureFiber, measurePass } from './ancestry';
import { publishTogether } from './registry';
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

/** Parked instances' checks (clipped and still): every tick runs every one. */
const parked = new Set<Registration>();

/**
 * Every parked instance's check, every tick. Each measures its view alone
 * (no ancestors, nothing published while it has not moved), so a tick costs
 * one measurement per parked instance, as a tick-mode instance's does; no
 * frame costs any.
 */
function checkParked(): void {
  // A snapshot: a check may park or unpark one while the tick runs.
  for (const { measure } of [...parked]) {
    try {
      measure();
    } catch (error) {
      console.warn('[Bugsee] a secure-region measurer threw', errorName(error));
    }
  }
}

/** One pass: a ScrollView shared by many measurers is measured once. */
function tick(): void {
  measurePass(() =>
    publishTogether(() => {
      measureAll();
      checkParked();
      // A lane that failed is retried here, once a tick, not every frame.
    }, true),
  );
}

/**
 * Adds `check` to the parked instances every tick re-checks, until the
 * returned function is called. Only while some measurer keeps the tick
 * running.
 */
export function addParked(check: () => void): () => void {
  const registration: Registration = { measure: check };
  parked.add(registration);
  return () => {
    parked.delete(registration);
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
  /** Whether any subscriber wants its geometry; one watching its props alone does not measure it. */
  geometry: boolean;
  /** Where the node was at the last frame (or when first watched); unmeasured, always the same. */
  last: string;
  /** Its two fibers' props objects then: a commit that changes either may change how it clips. */
  props: readonly unknown[];
}

/** Nodes measured every frame (a ScrollView's content, a clipping view), by fiber. */
const watched = new Map<FiberLike, WatchedNode>();

function where(rect: WindowRect | null | undefined): string {
  return rect == null ? String(rect) : `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

function whereNow(fiber: FiberLike): string {
  try {
    return where(measureFiber(fiber));
  } catch {
    // Unknown, as a node that does not answer is.
    return where(undefined);
  }
}

/**
 * The props objects of both fibers of `fiber`'s pair. Whichever is
 * committed, a commit that changes its props replaces one of them, so
 * comparing both by identity catches every such commit (and, harmlessly,
 * renders that never commit).
 */
function propsOf(fiber: FiberLike): unknown[] {
  return [fiber.memoizedProps, fiber.alternate?.memoizedProps];
}

/**
 * Measures every watched node once, and wakes the subscribers of each that
 * moved or whose props changed (an `overflow` that stops clipping moves
 * nothing).
 */
function watchNodes(): void {
  for (const [fiber, node] of [...watched]) {
    const now = node.geometry ? whereNow(fiber) : node.last;
    const props = propsOf(fiber);
    const changed = now !== node.last || props.some((value, index) => value !== node.props[index]);
    node.last = now;
    node.props = props;
    if (changed) {
      for (const { moved } of [...node.subscribers]) {
        moved();
      }
    }
  }
}

/** Watched nodes, then every frame measurer, in one measure pass; then the next frame if any are left. */
function frame(): void {
  cancelFrame = undefined;
  try {
    measurePass(() =>
      publishTogether(() => {
        watchNodes();
        for (const { measure } of [...frameMeasurers]) {
          try {
            measure();
          } catch (error) {
            console.warn('[Bugsee] a secure-region measurer threw', errorName(error));
          }
        }
      }),
    );
  } finally {
    // In a finally: nothing thrown above (a warn included) may stop the loop.
    if (frameMeasurers.size > 0 || watched.size > 0) {
      cancelFrame ??= requestFrame(frame);
    }
  }
}

/**
 * Measures `fiber` every frame, and calls `moved` whenever it is somewhere
 * else than the frame before, or its props changed, until the returned
 * function is called. Every subscriber of one fiber shares one measurement a
 * frame, and so does every fiber of one host. With `geometry` false the
 * subscriber wants its props alone (a `<Modal>` host hidden by a commit), and
 * the node is measured only if another subscriber wants that.
 */
export function watchNode(fiber: FiberLike, moved: () => void, geometry = true): () => void {
  let node = watched.get(fiber);
  if (node === undefined) {
    // Measured at once: a move before the next frame is a move.
    node = { subscribers: new Set(), geometry, last: geometry ? whereNow(fiber) : '', props: propsOf(fiber) };
    watched.set(fiber, node);
  } else if (geometry && !node.geometry) {
    node.geometry = true;
    node.last = whereNow(fiber);
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
