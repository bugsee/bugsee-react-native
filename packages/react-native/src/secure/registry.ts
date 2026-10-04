import NativeBugsee from '../NativeBugsee';
import { flattenSecureRectangles } from './rectangles';
import type { SecureRectangle } from './rectangles';
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

/** The activity React root's surface; matches native `MAIN_SURFACE`. */
export const MAIN_SURFACE = 0;

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

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Publishes the union of every owner's rectangles on `display` for each
 * surface that has (or had) owners there.
 *
 * Re-flattened every time rather than cached per owner: the pixel ratio is
 * read per publish (see `secureRectangleScale`), so a ratio change reaches the
 * whole display the next time any owner on it moves.
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
      continue;
    }

    if (surface === MAIN_SURFACE) {
      NativeBugsee.setSecureRectangles(display, flat);
    } else {
      NativeBugsee.setSecureRectanglesOnSurface(display, surface, flat);
    }
    // Only after the call returned: a publish that threw was not published, and
    // recording it would skip the retry as "unchanged".
    published.set(key, flat);
  }
}

/**
 * Replaces `owner`'s rectangles with `rectangles` on `display`/`surface` and
 * publishes that lane's union.
 *
 * Throws, changing nothing, if any rectangle is malformed. The owner's
 * previous rectangles stay published: a bad call never uncovers a region.
 */
export function setOwnerRectangles(
  owner: SecureOwner,
  display: number,
  rectangles: readonly SecureRectangle[],
  surface: number = MAIN_SURFACE,
): void {
  // Validation first, before the entry changes.
  flattenSecureRectangles(rectangles, secureRectangleScale());

  const previous = owners.get(owner);
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
  publish(display, surfaces);
  if (previous !== undefined && previous.display !== display) {
    publish(previous.display, new Set([previous.surface]));
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
