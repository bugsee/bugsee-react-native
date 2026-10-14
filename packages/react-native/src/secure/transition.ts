import { measureFiber } from './ancestry';
import type { Ancestry } from './ancestry';
import { MODAL_HOST_TYPE } from './surface';
import { FiberTag } from '../viewtree/fiber';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

/**
 * Native transitions carry a `<BugseeSecure>` where its measurements cannot
 * follow, and draw it after React is done with it.
 *
 * A react-native-screens stack animates a pushed screen in, and a popped one
 * out, natively: React mounts the new screen, or unmounts the popped one, at
 * the start, and the screen is then drawn moving (Android 13+: 10% sideways
 * over 450 ms; before that a 0.85 to 1 scale about its centre; iOS: the whole
 * width) for as long as the animation runs. A `<Modal>`'s dialog slides in
 * from the bottom of the display and out again the same way, with its content
 * laid out where it ends. None of this is in the shadow tree, so
 * `measureInWindow` reads where the view rests, and a popped screen's views
 * are not measurable at all.
 *
 * So for {@link SECURE_TRANSITION_HOLD_MS} from the commit that starts such a
 * transition, a view it carries also covers everywhere the transition can
 * draw it:
 *  - a screen pushed onto, or popped off, a stack: the screen's own
 *    rectangle. The stack clips what its screens draw to its bounds, and
 *    every stack animation (slide, scale, fade, either direction, RTL) keeps
 *    a screen inside them, so this holds whatever animation the app chose;
 *  - a `<Modal animationType="slide">` opening or closing: the band from the
 *    view's top down to the bottom of the surface, the path it slides along;
 *  - a `<Modal animationType="fade">` closing: the view's own rectangle, which
 *    stays drawn while the dialog fades.
 *
 * A transition is told apart from a view coming and going inside a screen
 * that stays by the fiber tree alone: in the commit that mounts a view, an
 * ancestor created by that same commit has no alternate yet; in the commit
 * that unmounts it, the root of what is deleted is listed in its parent's
 * `deletions`.
 */
export const SECURE_TRANSITION_HOLD_MS = 1000;

/**
 * A rectangle past every edge of any surface, for a cover whose bounds cannot
 * be measured: both SDKs cut what they mask to the display.
 */
export const WHOLE_SURFACE: WindowRect = { x: 0, y: 0, width: 100_000, height: 100_000 };

/** The react-native-screens stacks, which animate screens in and out natively. */
export const STACK_HOST_TYPES: ReadonlySet<unknown> = new Set(['RNSScreenStack']);

/** What carries a view through a transition: its nearest stack screen, or its `<Modal>`. */
export interface Carrier {
  readonly kind: 'screen' | 'modal';
  /** Where the screen's, or the Modal's, host is in `Ancestry.path`. */
  readonly index: number;
}

/**
 * The nearest screen in a stack above the view, or else the `<Modal>` it is
 * in; `null` when neither carries it.
 */
export function carrierOf(ancestry: Ancestry): Carrier | null {
  for (const host of ancestry.hosts) {
    if (host.screen && STACK_HOST_TYPES.has(ancestry.path[host.above]?.type)) {
      return { kind: 'screen', index: host.index };
    }
  }
  const index = ancestry.path.findIndex(
    (fiber) => fiber.tag === FiberTag.HostComponent && fiber.type === MODAL_HOST_TYPE,
  );
  return index < 0 ? null : { kind: 'modal', index };
}

/**
 * Whether the commit running now created the carrier, as a push or a Modal
 * opening does: a fiber gets its alternate the first time it is rendered
 * again, and every ancestor of a view that mounts is either created or
 * rendered again by that commit. Only meaningful while that commit's layout
 * effects run.
 */
export function carrierEntering(ancestry: Ancestry, carrier: Carrier): boolean {
  return ancestry.path[carrier.index]?.alternate == null;
}

function deletes(parent: FiberLike | null | undefined, child: FiberLike): boolean {
  const deletions = (parent as { deletions?: unknown } | null | undefined)?.deletions;
  return Array.isArray(deletions) && (deletions.includes(child) || deletions.includes(child.alternate));
}

/**
 * Where in `Ancestry.path` the root of what the running commit deletes is
 * (-1: the view's own host), or `undefined` when no fiber on the way up is
 * being deleted. Only meaningful while that commit unmounts the view.
 */
export function deletionRoot(ancestry: Ancestry): number | undefined {
  const { self, path } = ancestry;
  if (self === null) {
    return undefined;
  }
  let child = self;
  for (let index = -1; index < path.length - 1; index += 1) {
    const parent = path[index + 1] as FiberLike;
    // Either fiber of the parent's pair may be the one this commit finished.
    if (deletes(parent, child) || deletes(parent.alternate, child)) {
      return index;
    }
    child = parent;
  }
  return undefined;
}

/** Whether the running commit deletes the carrier itself, or something above it. */
export function carrierLeaving(ancestry: Ancestry, carrier: Carrier): boolean {
  const deleted = deletionRoot(ancestry);
  return deleted !== undefined && deleted >= carrier.index;
}

/**
 * Where `carrier` can draw a view that rests at `self` while it is carried in
 * or out, or `null` when it does not move it.
 */
export function carriedCover(
  ancestry: Ancestry,
  carrier: Carrier,
  self: WindowRect | null,
  leaving: boolean,
): WindowRect | null {
  const fiber = ancestry.path[carrier.index] as FiberLike;
  if (carrier.kind === 'screen') {
    let screen: WindowRect | null | undefined;
    try {
      screen = measureFiber(fiber);
    } catch {
      screen = undefined;
    }
    return screen ?? WHOLE_SURFACE;
  }
  const animationType = (fiber.memoizedProps as { animationType?: unknown } | null | undefined)?.animationType;
  // Never measured (no answer yet): it is drawn nowhere it was measured either.
  if (self === null) {
    return null;
  }
  if (animationType === 'slide') {
    return { x: self.x, y: self.y, width: self.width, height: WHOLE_SURFACE.height - self.y };
  }
  return animationType === 'fade' && leaving ? self : null;
}
