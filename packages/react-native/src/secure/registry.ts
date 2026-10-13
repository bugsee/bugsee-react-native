import NativeBugsee from '../NativeBugsee';
import { errorName } from '../errorName';
import { flattenSecureRectangles } from './rectangles';
import type { SecureRectangle } from './rectangles';
import { MAIN_SURFACE } from './surface';
import { secureRectangleScale } from './unit';

/**
 * Who published a set of secure rectangles.
 *
 * `Bugsee.setSecureRectangles` owns `manual:<display>`, one per display, and
 * each mounted `<BugseeSecure>` owns a token object of its own. Keeping them
 * apart is the point: a component unmounting must never clear what the app set
 * by hand, and a manual clear must never uncover a mounted component.
 */
export type SecureOwner = object | `manual:${number}`;

export { MAIN_SURFACE };

interface OwnerEntry {
  readonly display: number;
  readonly surface: number;
  readonly rectangles: readonly SecureRectangle[];
}

/** Insertion-ordered, so the published union is stable across publishes. */
const owners = new Map<SecureOwner, OwnerEntry>();

/**
 * What last reached the bridge, per display and surface. A missing entry has
 * never been published by this JS runtime, so its first publish always
 * crosses, even an empty one: the native store outlives a JS reload and may
 * still hold a set this runtime knows nothing about.
 */
const published = new Map<string, readonly number[]>();

function publishKey(display: number, surface: number): string {
  return `${display}:${surface}`;
}

/**
 * The scale each lane's union was last flattened at, for as long as native
 * holds that union. Absent while a lane's last publish has not reached the
 * bridge, so nothing on it is skipped until one does.
 */
const laneScale = new Map<string, number>();

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRectangles(a: readonly SecureRectangle[], b: readonly SecureRectangle[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    const [p, q] = [a[index]!, b[index]!];
    if (p.x !== q.x || p.y !== q.y || p.width !== q.width || p.height !== q.height) {
      return false;
    }
  }
  return true;
}

/**
 * Publishes the union of every owner's rectangles on `display` for each
 * surface that has (or had) owners there.
 *
 * Re-flattened every time rather than cached per owner: the pixel ratio is
 * read per publish (see `secureRectangleScale`). A ratio change reaches each
 * lane the next time any owner on it publishes: an owner that has not moved
 * skips only while its lane was flattened at the current ratio.
 *
 * Skipping an unchanged union costs nothing observable: both native stores
 * already keep their version still for a no-op write. It saves a bridge hop
 * on every 100 ms re-measure that found nothing moved.
 */
function publish(display: number, surfaces: ReadonlySet<number>): void {
  const scale = secureRectangleScale();
  for (const surface of surfaces) {
    const union: SecureRectangle[] = [];
    for (const entry of owners.values()) {
      if (entry.display === display && entry.surface === surface) {
        union.push(...entry.rectangles);
      }
    }

    const flat = flattenSecureRectangles(union, scale);
    const key = publishKey(display, surface);
    const last = published.get(key);
    if (last !== undefined && sameList(last, flat)) {
      laneScale.set(key, scale);
      continue;
    }

    laneScale.delete(key);
    if (surface === MAIN_SURFACE) {
      NativeBugsee.setSecureRectangles(display, flat);
    } else {
      NativeBugsee.setSecureRectanglesOnSurface(display, surface, flat);
    }
    // Only after the call returned: a publish that threw was not published, and
    // recording it would skip the retry as "unchanged".
    published.set(key, flat);
    laneScale.set(key, scale);
  }
}

/**
 * Replaces `owner`'s rectangles with `rectangles` on `display`/`surface` and
 * publishes that lane's union.
 *
 * Throws, changing nothing, if any rectangle is malformed. The owner's
 * previous rectangles stay published: a bad call never uncovers a region.
 *
 * An owner republishing exactly what it holds, on the same lane, costs a
 * comparison and nothing else (every mounted `<BugseeSecure>` does so every
 * re-measure it has not moved), unless the lane's last publish failed or the
 * pixel ratio changed since.
 */
export function setOwnerRectangles(
  owner: SecureOwner,
  display: number,
  rectangles: readonly SecureRectangle[],
  surface: number = MAIN_SURFACE,
): void {
  const previous = owners.get(owner);
  if (
    previous !== undefined &&
    previous.display === display &&
    previous.surface === surface &&
    laneScale.get(publishKey(display, surface)) === secureRectangleScale() &&
    sameRectangles(previous.rectangles, rectangles)
  ) {
    return;
  }

  // Validation first, before the entry changes.
  flattenSecureRectangles(rectangles, secureRectangleScale());

  // A copy: the caller keeps its array and objects, and an edit through them
  // must not change what a later publish for some other owner sends.
  owners.set(owner, {
    display,
    surface,
    rectangles: rectangles.map(({ x, y, width, height }) => ({ x, y, width, height })),
  });

  const surfaces = new Set<number>([surface]);
  if (previous !== undefined) {
    surfaces.add(previous.surface);
  }
  // The new display is covered before the old one is uncovered.
  publishOrDefer(display, surfaces);
  if (previous !== undefined && previous.display !== display) {
    publishOrDefer(previous.display, new Set([previous.surface]));
  }
}

/** The lanes changed inside {@link publishTogether}, by display, in the order they changed. */
let deferred: Map<number, Set<number>> | undefined;

/**
 * Lanes whose last publish inside {@link publishTogether} threw: the next
 * call that retries publishes them again, whether or not anything on them
 * changed (an owner that has not moved never asks again).
 */
let failed = new Map<number, Set<number>>();

/** Lanes warned about since they last published: one warning per lane per outage. */
const warned = new Set<string>();

function addLanes(into: Map<number, Set<number>>, display: number, surfaces: ReadonlySet<number>): void {
  const lanes = into.get(display) ?? new Set<number>();
  surfaces.forEach((surface) => lanes.add(surface));
  into.set(display, lanes);
}

function publishOrDefer(display: number, surfaces: ReadonlySet<number>): void {
  if (deferred === undefined) {
    publish(display, surfaces);
    return;
  }
  addLanes(deferred, display, surfaces);
}

/**
 * Runs `changes`, publishing every lane they changed once, at the end,
 * rather than once per change: every instance re-measured in one tick or
 * frame changes its lane, and each publish re-flattens the lane's whole
 * union. A lane whose publish throws is logged once until it publishes
 * again, and published again by the next call that `retryFailed` (the tick,
 * so at most every 100 ms), changed or not; a call that changes it publishes
 * it anyway. Inside another call, it simply runs `changes`.
 */
export function publishTogether(changes: () => void, retryFailed = false): void {
  if (deferred !== undefined) {
    changes();
    return;
  }
  deferred = new Map();
  if (retryFailed) {
    failed.forEach((surfaces, display) => addLanes(deferred as Map<number, Set<number>>, display, surfaces));
    failed = new Map();
  }
  try {
    changes();
  } finally {
    const lanes = deferred;
    deferred = undefined;
    for (const [display, surfaces] of lanes) {
      const keys = [...surfaces].map((surface) => publishKey(display, surface));
      try {
        publish(display, surfaces);
        // Still listed as failed, a lane that went through here republishes
        // the same list on the next retry, which the registry skips.
        keys.forEach((key) => warned.delete(key));
      } catch (error) {
        addLanes(failed, display, surfaces);
        if (keys.some((key) => !warned.has(key))) {
          keys.forEach((key) => warned.add(key));
          console.warn('[Bugsee] could not publish secure rectangles', errorName(error));
        }
      }
    }
  }
}

/** Removes `owner`'s rectangles and republishes what the other owners hold. */
export function clearOwner(owner: SecureOwner): void {
  const previous = owners.get(owner);
  if (previous === undefined) {
    return;
  }
  owners.delete(owner);
  publish(previous.display, new Set([previous.surface]));
}
