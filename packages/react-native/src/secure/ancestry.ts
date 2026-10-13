import { FiberTag } from '../viewtree/fiber';
import type { FiberLike, WindowRect } from '../viewtree/fiber';
import { MODAL_HOST_TYPE } from './surface';

/**
 * What lies between a `<BugseeSecure>` and its surface's root, read off the
 * fiber tree once per mount, and what that says each tick about how much of
 * the view is really on screen.
 *
 * Fabric `measureInWindow` is shadow-tree layout: it ignores every ancestor's
 * clipping and visibility. So a region scrolled out of its ScrollView, or on
 * an inactive tab that stays mounted, would still be published. This module
 * finds the ancestors that can clip or hide the view, so the component can
 * intersect its rectangle with what clips it and withdraw it while it is
 * hidden.
 *
 * Every rule here leans towards masking: an ancestor hides the view only on
 * positive evidence, and an ancestor that cannot be read or measured is
 * treated as clipping nothing.
 *
 * Committed props, not a fiber's own: a host fiber and its alternate swap
 * roles on every update, and an ancestor that stopped re-rendering can be
 * left holding props that were never, or are no longer, committed (the same
 * stale `.return` chains `findCurrentFiberUsingSlowPath` exists for). Both
 * fibers of a Fabric host share one `stateNode.canonical`, and the renderer
 * keeps that object's `currentProps` up to date for the host: it is what
 * React Native's own `getCurrentProps` (`NodeInternals.js`) dispatches
 * events with. So which of the two fibers was stored does not matter. A host
 * with no `canonical` (not Fabric) has no readable committed props and
 * counts as neither hiding nor clipping.
 *
 * An Offscreen fiber (a hidden `<Activity>` or Suspense content) shares its
 * `stateNode` with its alternate too, and React's commit phase clears that
 * instance's `OffscreenVisible` bit while it is hidden, so that bit is read,
 * never either fiber's `memoizedState`.
 */

/**
 * Host types whose own bounds clip their content: a ScrollView's viewport
 * (`ScrollViewNativeComponent`, vertical on both platforms and horizontal on
 * iOS, and `AndroidHorizontalScrollViewNativeComponent`). Their content
 * containers (`RCTScrollContentView`, `AndroidHorizontalScrollContentView`)
 * scroll with the content and clip nothing.
 */
export const SCROLL_HOST_TYPES: ReadonlySet<unknown> = new Set(['RCTScrollView', 'AndroidHorizontalScrollView']);

/** react-native-screens' screen host (`ScreenNativeComponent`). */
export const SCREEN_HOST_TYPE = 'RNSScreen';

/** `activityState` of an inactive react-native-screens screen. */
const INACTIVE_SCREEN = 0;

/** React's `OffscreenVisible` bit on an Offscreen fiber's `stateNode._visibility`. */
const OFFSCREEN_VISIBLE = 1;

/** What a host's `props` holds before its first read: equal to no props object. */
const UNREAD: unique symbol = Symbol('unread');

/** A cycle in a malformed tree must not spin forever. */
const MAX_ANCESTORS = 10_000;

type MeasureInWindow = (callback: (x: number, y: number, width: number, height: number) => void) => void;

interface HostAncestor {
  readonly fiber: FiberLike;
  /** A ScrollView host: clips whatever its props say. */
  readonly scrolls: boolean;
  /** The props object `hides` and `clips` were last read from. */
  props: unknown;
  hides: boolean;
  clips: boolean;
  /** The host's public instance, looked up the first time it clips. */
  instance: { measureInWindow: MeasureInWindow } | undefined;
}

export interface Ancestry {
  /** Every host between the view and its surface's root, nearest first. */
  readonly hosts: readonly HostAncestor[];
  /** Every Offscreen fiber in the same stretch. */
  readonly offscreens: readonly FiberLike[];
}

/** Nothing above the view can clip or hide it. */
export const NO_ANCESTRY: Ancestry = { hosts: [], offscreens: [] };

/**
 * The ancestors of the host `fiber` up to its surface's root: the nearest
 * `<Modal>` host (in another surface, so not included) or the tree's root.
 * `fiber` itself is not included.
 */
export function ancestryOfFiber(fiber: FiberLike): Ancestry {
  const hosts: HostAncestor[] = [];
  const offscreens: FiberLike[] = [];
  let current = fiber.return;
  for (let steps = 0; current != null && steps < MAX_ANCESTORS; steps += 1) {
    if (current.tag === FiberTag.HostComponent) {
      if (current.type === MODAL_HOST_TYPE) {
        break;
      }
      hosts.push({
        fiber: current,
        scrolls: SCROLL_HOST_TYPES.has(current.type),
        props: UNREAD,
        hides: false,
        clips: false,
        instance: undefined,
      });
    } else if (current.tag === FiberTag.Offscreen) {
      offscreens.push(current);
    }
    current = current.return;
  }
  return { hosts, offscreens };
}

/**
 * The ancestry of a mounted host's public instance (Fabric's carries its
 * fiber as `__internalInstanceHandle`). {@link NO_ANCESTRY} when there is no
 * fiber or the tree cannot be read: nothing is clipped or hidden then.
 */
export function ancestryOfInstance(instance: object): Ancestry {
  try {
    const fiber = (instance as { __internalInstanceHandle?: unknown }).__internalInstanceHandle;
    // A null fiber gets past this and throws on its first read, below.
    if (typeof fiber !== 'object') {
      return NO_ANCESTRY;
    }
    return ancestryOfFiber(fiber as FiberLike);
  } catch {
    return NO_ANCESTRY;
  }
}

/** The committed props of a Fabric host, or `undefined` when it has none to read. */
function committedProps(fiber: FiberLike): unknown {
  const canonical = (fiber.stateNode as { canonical?: { currentProps?: unknown } } | null)?.canonical;
  return canonical?.currentProps;
}

/**
 * `key` of a style as React Native flattens it: the last value set wins,
 * through nested arrays; falsy entries are skipped.
 */
export function styleValue(style: unknown, key: string): unknown {
  if (Array.isArray(style)) {
    return style.reduceRight<unknown>(
      (found, entry) => (found !== undefined ? found : styleValue(entry, key)),
      undefined,
    );
  }
  if (style !== null && typeof style === 'object') {
    return (style as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Re-reads `host`'s flags if its committed props changed since the last read. */
function refresh(host: HostAncestor): void {
  const props = committedProps(host.fiber);
  if (props === host.props) {
    return;
  }
  host.props = props;
  const { style, activityState } = (props ?? {}) as { style?: unknown; activityState?: unknown };
  host.hides =
    styleValue(style, 'display') === 'none' ||
    (host.fiber.type === SCREEN_HOST_TYPE && activityState === INACTIVE_SCREEN);
  host.clips = host.scrolls || styleValue(style, 'overflow') === 'hidden';
}

function offscreenHidden(fiber: FiberLike): boolean {
  const visibility = (fiber.stateNode as { _visibility?: unknown } | null)?._visibility;
  return typeof visibility === 'number' && (visibility & OFFSCREEN_VISIBLE) === 0;
}

/**
 * Whether some ancestor is known to hide the view now: a host styled
 * `display: 'none'`, an inactive react-native-screens screen, or a hidden
 * Offscreen. Anything unknown, including an ancestor that throws while it is
 * read, counts as visible. Also refreshes which hosts clip, for
 * {@link clipToAncestors}: when it answers `false`, every host was read.
 */
export function isHidden(ancestry: Ancestry): boolean {
  try {
    for (const host of ancestry.hosts) {
      refresh(host);
      if (host.hides) {
        return true;
      }
    }
    return ancestry.offscreens.some(offscreenHidden);
  } catch {
    return false;
  }
}

function publicInstanceOf(fiber: FiberLike): { measureInWindow: MeasureInWindow } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, like surface.ts: only a renderer has it.
  const rendererProxy = require('react-native/Libraries/ReactNative/RendererProxy') as {
    getPublicInstanceFromInternalInstanceHandle: (fiber: unknown) => { measureInWindow: MeasureInWindow };
  };
  return rendererProxy.getPublicInstanceFromInternalInstanceHandle(fiber);
}

/**
 * The clipping ancestors measured in the running {@link measurePass}, by
 * public instance: views under one ScrollView all clip to it, and measure it
 * once a pass. `undefined` outside a pass, which measures every time.
 */
let passMeasurements: Map<object, WindowRect | undefined> | undefined;

/**
 * Runs `pass` with each clipping ancestor measured at most once. Only for a
 * synchronous stretch of JS (the re-measure loop's tick): no commit can move
 * anything while it runs, so a rectangle measured once holds for all of it.
 */
export function measurePass(pass: () => void): void {
  passMeasurements = new Map();
  try {
    pass();
  } finally {
    passMeasurements = undefined;
  }
}

/** `host`'s window rectangle, or `undefined` unless it answers at once with finite numbers. */
function measureHost(host: HostAncestor): WindowRect | undefined {
  const instance = (host.instance ??= publicInstanceOf(host.fiber));
  if (passMeasurements?.has(instance)) {
    return passMeasurements.get(instance);
  }
  let measured: WindowRect | undefined;
  instance.measureInWindow((x, y, width, height) => {
    const answer = { x, y, width, height };
    if (finite(answer)) {
      measured = answer;
    }
  });
  passMeasurements?.set(instance, measured);
  return measured;
}

function finite({ x, y, width, height }: WindowRect): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height);
}

/**
 * The part of `rect` inside every ancestor that clips now (as the last
 * {@link isHidden} read them), or `null` when none of it is.
 *
 * Fails closed: `rect` itself, unclipped, when it is not finite or any
 * clipping ancestor throws, answers late or answers with a non-finite
 * rectangle. Measures nothing, and returns `rect` as it is, when nothing
 * clips.
 */
export function clipToAncestors(rect: WindowRect, ancestry: Ancestry): WindowRect | null {
  if (!finite(rect)) {
    return rect;
  }
  const clips: Array<WindowRect | undefined> = [];
  try {
    for (const host of ancestry.hosts) {
      if (host.clips) {
        clips.push(measureHost(host));
      }
    }
  } catch {
    return rect;
  }
  if (clips.length === 0 || clips.includes(undefined)) {
    return rect;
  }
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  for (const clip of clips as WindowRect[]) {
    left = Math.max(left, clip.x);
    top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width);
    bottom = Math.min(bottom, clip.y + clip.height);
  }
  if (right <= left || bottom <= top) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
