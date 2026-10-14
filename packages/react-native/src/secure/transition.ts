import { MODAL_SCREEN_HOST_TYPE, SCREEN_HOST_TYPE, measureFiber, passMemo } from './ancestry';
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
 *  - a screen pushed onto, or popped off, a stack, and the screen it uncovers
 *    or covers on that stack (which moves too): by the screen's
 *    `stackAnimation`, the band of the view across the screen for a
 *    sideways slide, the column from the view down for a slide from the
 *    bottom, the view itself for a fade or none; for the platform default and
 *    anything else, the screen's whole rectangle. The stack clips what its
 *    screens draw to its bounds, so each of these holds for its animation in
 *    either direction and RTL, and the whole screen holds for any;
 *  - a `<Modal animationType="slide">` opening or closing: the band from the
 *    view's top down to the bottom of the surface, the path it slides along.
 *    A fading Modal does not move the view, and the hold every unmount gets
 *    keeps it covered where it rests while the dialog fades.
 *
 * A transition is told apart from a view coming and going inside a screen
 * that stays by the fiber tree alone: in the commit that mounts a view, an
 * ancestor created by that same commit has no alternate yet (and the time is
 * kept, so a view mounted, or shown, later in the same transition is covered
 * too); in the commit that unmounts it, the root of what is deleted is listed
 * in its parent's `deletions`.
 *
 * 800 ms from the commit: on an API 30 emulator (Debug) the native animation
 * started ~200 ms after the commit and react-native-screens' default Android
 * animations run 450 ms (200 ms before Android 13), 650 ms in all; iOS pushes
 * run ~350-500 ms. React Native screens report the end of a transition only
 * to the navigator's own handlers, so the cover ends on time.
 */
export const SECURE_TRANSITION_HOLD_MS = 800;

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
  /** A screen's stack, in `Ancestry.path`. */
  readonly stack?: number;
}

/**
 * What can carry the view through a native transition: every screen in a
 * stack above it (nearest first), and the `<Modal>` it is in, each
 * independently (a stack inside a Modal slides in with the Modal, and pushes
 * within it on its own; in nested stacks, the screen that moves is the one
 * pushed or popped).
 */
export function carriersOf(ancestry: Ancestry): Carrier[] {
  // `hosts` stop at a Modal (a root of its own): the screens it was opened over move without it.
  const carriers: Carrier[] = ancestry.hosts
    .filter((host) => host.screen && STACK_HOST_TYPES.has(ancestry.path[host.above]?.type))
    .map((host) => ({ kind: 'screen' as const, index: host.index, stack: host.above }));
  const modal = modalOf(ancestry);
  if (modal !== null) {
    carriers.push(modal);
  }
  return carriers;
}

/**
 * Where the `carriers` can draw a view seen at `view`, joined, or
 * `null` when none of them moves it.
 */
export function carriedCovers(
  ancestry: Ancestry,
  carriers: readonly Carrier[],
  view: WindowRect | null | undefined,
): WindowRect | null {
  let joined: WindowRect | null = null;
  for (const carrier of carriers) {
    const cover = carriedCover(ancestry, carrier, view);
    if (cover !== null) {
      joined = bounding(cover, joined);
    }
  }
  return joined;
}

/** The bounding box of `a` and `b` (when there is one). */
export function bounding(a: WindowRect, b: WindowRect | null | undefined): WindowRect {
  if (b == null) {
    return a;
  }
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The `<Modal>` the view is in, or `null`. */
export function modalOf(ancestry: Ancestry): Carrier | null {
  const index = ancestry.path.findIndex(
    // Only a host has a string type.
    (fiber) => fiber.type === MODAL_HOST_TYPE,
  );
  return index < 0 ? null : { kind: 'modal', index };
}

/**
 * Until when the carrier is being carried in (`undefined`: it is not): it
 * was pushed, or opened, no longer ago than {@link SECURE_TRANSITION_HOLD_MS}.
 * Its birth is kept for every view that comes later, by the carrier:
 *  - a carrier with no alternate was created by the commit running now (a
 *    fiber gets its alternate the first time it is rendered again, and every
 *    ancestor of a view that mounts is created or rendered again by that
 *    commit), as a push or a Modal opening does. A tree mounted whole, as an
 *    app starts, is drawn where it is laid out, with no transition: something
 *    above the carrier must have been there before (the stack, the screen
 *    that opened the Modal);
 *  - a screen another view saw pushed onto its stack ({@link noteBirth});
 *  - otherwise it was there before, first seen now: when it came is not
 *    known (a screen pushed with a spinner, its secure content mounting a
 *    commit later), so it is taken as coming now. Once per carrier.
 */
export function carrierEntering(ancestry: Ancestry, carrier: Carrier, now: number): number | undefined {
  const { path } = ancestry;
  const fiber = path[carrier.index] as FiberLike;
  const key = keyOf(fiber);
  if (!births.has(key)) {
    // Nothing below a created carrier can have been there before it.
    // Stryker disable next-line MethodExpression -- so looking from the bottom finds the same
    const mountedWhole =
      fiber.alternate == null && !path.slice(carrier.index + 1).some((above) => above.alternate != null);
    births.set(key, mountedWhole ? -Infinity : now);
  }
  const born = births.get(key) as number;
  return now - born < SECURE_TRANSITION_HOLD_MS ? born + SECURE_TRANSITION_HOLD_MS : undefined;
}

/**
 * When each carrier came, by {@link keyOf}: a view that mounts, or is shown,
 * while it is still being pushed or opened is carried in with it.
 * `-Infinity`: mounted with the tree it is in, as an app starts.
 */
const births = new WeakMap<object, number>();

/** A screen (by {@link keyOf}) seen pushed onto a stack at `now`, unless its birth is known already. */
export function noteBirth(key: object, now: number): void {
  if (!births.has(key)) {
    births.set(key, now);
  }
}

/**
 * What stays the same for a host across both fibers of its pair and every
 * commit: Fabric's shared `canonical` (a host's `stateNode` is cloned on
 * every update); on Paper the `stateNode` itself, which both fibers share;
 * the fiber when there is neither.
 */
export function keyOf(fiber: FiberLike): object {
  const node = fiber.stateNode as { canonical?: unknown } | null | undefined;
  const canonical = node?.canonical;
  if (canonical !== null && typeof canonical === 'object') {
    return canonical;
  }
  return node !== null && typeof node === 'object' ? node : fiber;
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
  // Only an ancestry with no fiber has no self, and it has no path either.
  let child = self as FiberLike;
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
  // Nothing deleted (`undefined`) is never at or above anything.
  return Number(deletionRoot(ancestry)) >= carrier.index;
}

/** How a stack animation moves its screens, as far as covering goes. */
export type StackMotion = 'sideways' | 'upwards' | 'still' | 'any';

const SIDEWAYS: ReadonlySet<unknown> = new Set([
  'slide_from_right',
  'slide_from_left',
  'ios_from_right',
  'ios_from_left',
  'simple_push',
]);
const UPWARDS: ReadonlySet<unknown> = new Set(['slide_from_bottom', 'fade_from_bottom']);
const STILL: ReadonlySet<unknown> = new Set(['fade', 'none']);
/** iOS presentations that slide a screen up over the one below by default. */
const MODAL_PRESENTATIONS: ReadonlySet<unknown> = new Set([
  'modal',
  'fullScreenModal',
  'formSheet',
  'pageSheet',
  'transparentModal',
  'containedModal',
  'containedTransparentModal',
]);

// A missing Platform throws, and is caught; an empty catch returns undefined all the same.
// Stryker disable all
function platformOS(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: only an app has it
    return (require('react-native') as { Platform?: { OS?: unknown } }).Platform?.OS;
  } catch {
    return undefined;
  }
}
// Stryker restore all

/**
 * How the screen whose host props are `props` is animated in and out: from
 * its `stackAnimation`, and on iOS its presentation. The platform default
 * (sideways on Android 13+, a scale before, sideways on iOS) and anything
 * unknown is `any`.
 */
export function stackMotionOf(props: unknown, moving = true): StackMotion {
  const { stackAnimation: animation, stackPresentation: presentation } = (props ?? {}) as Record<string, unknown>;
  if (SIDEWAYS.has(animation)) {
    return 'sideways';
  }
  if (UPWARDS.has(animation)) {
    return 'upwards';
  }
  if (STILL.has(animation)) {
    return 'still';
  }
  const defaulted = animation === undefined || animation === 'default';
  if (defaulted && MODAL_PRESENTATIONS.has(presentation) && platformOS() === 'ios') {
    // The card slides up; iOS 13+ also scales the screen below it about its centre.
    return moving ? 'upwards' : 'any';
  }
  return 'any';
}

/** react-native-screens' screen hosts, as a stack's children. */
const SCREEN_TYPES: ReadonlySet<unknown> = new Set([SCREEN_HOST_TYPE, MODAL_SCREEN_HOST_TYPE]);

/** How deep below a stack its screens can be (wrappers such as a stack item). */
const MAX_SCREEN_DEPTH = 16;

/**
 * The screens on `stack` (a committed stack host fiber), by {@link keyOf},
 * with their props: its descendants down to the first screen hosts.
 */
export function screensOn(stack: FiberLike): Map<object, unknown> {
  // Once a measure pass for every view on the stack.
  return passMemo(stack, () => findScreens(stack));
}

function findScreens(stack: FiberLike): Map<object, unknown> {
  const screens = new Map<object, unknown>();
  const visit = (fiber: FiberLike | null, depth: number): void => {
    for (let child = fiber; child != null; child = child.sibling) {
      // Only a host has a screen's (string) type: the tag only spares a lookup.
      // Stryker disable next-line ConditionalExpression
      if (child.tag === FiberTag.HostComponent && SCREEN_TYPES.has(child.type)) {
        screens.set(keyOf(child), child.memoizedProps);
      } else if (depth < MAX_SCREEN_DEPTH) {
        visit(child.child, depth + 1);
      }
    }
  };
  visit(stack.child, 0);
  return screens;
}

/**
 * Where a stack transition moving as `motion` can draw a view on a screen at
 * `screen`, seen at `view` (`null`: nothing of it is on screen, cut away by
 * a ScrollView, say, and so drawn nowhere as the screen moves either). `moving`:
 * the screen itself is the one pushed or popped; otherwise it is the one
 * uncovered or covered below, which a slide up leaves where it is.
 */
export function screenCover(
  motion: StackMotion,
  screen: WindowRect,
  view: WindowRect | null,
  moving: boolean,
): WindowRect | null {
  if (view === null) {
    return null;
  }
  if (motion === 'any') {
    return screen;
  }
  if (motion === 'sideways') {
    return { x: screen.x, y: view.y, width: screen.width, height: view.height };
  }
  if (motion === 'upwards' && moving) {
    const bottom = Math.max(screen.y + screen.height, view.y + view.height);
    return { x: view.x, y: view.y, width: view.width, height: bottom - view.y };
  }
  return view;
}

/** The window rectangle of a screen host, or the whole surface when it cannot be measured. */
export function screenRect(fiber: FiberLike): WindowRect {
  let screen: WindowRect | null | undefined;
  try {
    screen = measureFiber(fiber);
  } catch {
    // Unmeasurable: covered as the whole surface below.
  }
  return screen ?? WHOLE_SURFACE;
}

/**
 * Where `carrier` can draw a view seen at `view` while it is carried in or
 * out (`view`: what of it is on screen, `null` when nothing is, `undefined`
 * when it was never measured), or `null` when it does not move it.
 */
export function carriedCover(
  ancestry: Ancestry,
  carrier: Carrier,
  view: WindowRect | null | undefined,
): WindowRect | null {
  const fiber = (ancestry.resolved ?? ancestry.path)[carrier.index] as FiberLike;
  if (carrier.kind === 'screen') {
    const screen = screenRect(fiber);
    return view === undefined ? screen : screenCover(stackMotionOf(fiber.memoizedProps), screen, view, true);
  }
  const animationType = (fiber.memoizedProps as { animationType?: unknown } | null | undefined)?.animationType;
  // Never measured, or nothing of it on screen: it is drawn nowhere it was measured either.
  if (view == null) {
    return null;
  }
  if (animationType === 'slide') {
    return { x: view.x, y: view.y, width: view.width, height: WHOLE_SURFACE.height - view.y };
  }
  return null;
}

/** A view on a stack's screen, told when another screen on that stack is pushed or popped. */
export type StackNeighbour = (motion: StackMotion, until: number, moving: object) => void;

/** The views on each stack's screens, by the stack's {@link keyOf}. */
const stacks = new WeakMap<object, Set<StackNeighbour>>();

/** Adds `neighbour` to the views on `stack`'s screens, until the returned function is called. */
export function joinStack(stack: object, neighbour: StackNeighbour): () => void {
  let views = stacks.get(stack);
  if (views === undefined) {
    views = new Set();
    stacks.set(stack, views);
  }
  views.add(neighbour);
  const joined = views;
  return () => {
    joined.delete(neighbour);
  };
}

/**
 * Tells every view on `stack` that its screen `moving` is being pushed or
 * popped as `motion`, until `until`: the screens below move with it.
 */
export function stackMoving(stack: object, motion: StackMotion, until: number, moving: object): void {
  for (const neighbour of [...(stacks.get(stack) ?? [])]) {
    neighbour(motion, until, moving);
  }
}
