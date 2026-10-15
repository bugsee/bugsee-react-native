import { FiberTag } from '../viewtree/fiber';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

/**
 * What lies between a `<BugseeSecure>` and its surface's root, read off the
 * fiber tree once per mount, and what that says each tick about how much of
 * the view is really on screen.
 *
 * Fabric `measureInWindow` is shadow-tree layout: it ignores every ancestor's
 * clipping. So a region scrolled out of its ScrollView would still be
 * published. This module finds the ancestors that clip the view, so the
 * component can intersect its rectangle with them, and the one kind of
 * ancestor that hides a view without touching its layout: an inactive
 * react-native-screens screen, which stays mounted with its layout intact.
 *
 * Everything else that hides a view already shows in its layout, so it is
 * left to the shadow tree: a `display: 'none'` subtree, and the content of a
 * hidden Offscreen (`<Activity>`, Suspense), which Fabric hides by cloning
 * its hosts with `display: 'none'` (`cloneHiddenInstance`), both measure
 * 0x0, which publishes nothing. A frozen react-native-screens screen is
 * hidden Offscreen content that stays drawn (`RNSScreen` nulls `display` in
 * its view config for exactly that), and it keeps its layout, so it stays
 * masked.
 *
 * Every rule leans towards masking: a view is hidden only on positive
 * committed evidence, and an ancestor that cannot be read or measured clips
 * nothing.
 *
 * Committed props come from the CURRENT fiber of each ancestor. A fiber and
 * its alternate swap roles on every update, a stored `.return` chain can run
 * through either, and both a work-in-progress fiber's `memoizedProps` and a
 * Fabric host's `canonical.currentProps` are written during render, before
 * (and whether or not) that render commits. The fiber root's `current` is
 * the committed tree, and its `.child`/`.sibling` links are the committed
 * links, so each tick resolves the stored path top-down from it, taking at
 * every level whichever of the stored fiber and its alternate is a child of
 * the current parent. A path that does not resolve is unknown: nothing is
 * hidden and nothing clipped.
 */

/**
 * Host types whose own bounds clip their content, unless styled
 * `overflow: 'visible'` (iOS: `clipsToBounds = getClipsContentToBounds()`): a
 * ScrollView's viewport (`ScrollViewNativeComponent`, vertical on both
 * platforms and horizontal on iOS, and
 * `AndroidHorizontalScrollViewNativeComponent`). Their content containers
 * scroll with the content and clip nothing.
 */
export const SCROLL_HOST_TYPES: ReadonlySet<unknown> = new Set(['RCTScrollView', 'AndroidHorizontalScrollView']);

/**
 * Host types whose shadow node is `RootNodeKind`: `measureInWindow` stops
 * there (`LayoutableShadowNode::computeRelativeLayoutMetrics`) and natively
 * their content is drawn outside the hosts above, so nothing above one
 * clips or hides what is inside, and the host itself clips nothing (only
 * {@link MODAL_SCREEN_HOST_TYPE} can hide it). React Native's `<Modal>` and
 * `<InputAccessoryView>` (the JS names are their `paperComponentName`s),
 * and react-native-screens' `FullWindowOverlay`, modal screen and split
 * screen, plus its gamma form sheet host. A `HostPortal` fiber ends the walk
 * the same way: its children are drawn in another container.
 */
export const ROOT_KIND_HOST_TYPES: ReadonlySet<unknown> = new Set([
  'RCTModalHostView',
  'RCTInputAccessoryView',
  'RNSFullWindowOverlay',
  'RNSModalScreen',
  'RNSSplitScreen',
  // Not RootNodeKind, but its content is presented in a sheet of its own.
  'RNSFormSheetHost',
]);

/** react-native-screens' screen host (`ScreenNativeComponent`). */
export const SCREEN_HOST_TYPE = 'RNSScreen';

/**
 * react-native-screens' iOS modal screen host (`ModalScreenNativeComponent`),
 * which takes `activityState` like a screen. It is also root-kind, so it ends
 * the walk: it can hide what is inside it, but never clips it.
 */
export const MODAL_SCREEN_HOST_TYPE = 'RNSModalScreen';

/**
 * The react-native-screens containers whose screens `activityState` 0 really
 * hides (detaches): a screen hides the view only when the nearest host above
 * it is one of these. Anywhere else the prop proves nothing.
 */
export const SCREEN_CONTAINER_HOST_TYPES: ReadonlySet<unknown> = new Set([
  'RNSScreenContainer',
  'RNSScreenNavigationContainer',
  'RNSScreenStack',
]);

/** `activityState` of an inactive react-native-screens screen. */
const INACTIVE_SCREEN = 0;

/** What a host's `props` holds before its first read: equal to no props object. */
const UNREAD: unique symbol = Symbol('unread');

/** A cycle in a malformed tree must not spin forever. */
const MAX_ANCESTORS = 10_000;

type MeasureInWindow = (callback: (x: number, y: number, width: number, height: number) => void) => void;

interface HostAncestor {
  /** Where the host is in `Ancestry.path`. */
  readonly index: number;
  /** Where the next host above it is in `Ancestry.path` (its length when there is none). */
  above: number;
  readonly scrolls: boolean;
  readonly screen: boolean;
  /** A root-kind host: it ends the walk and clips nothing. */
  readonly boundary: boolean;
  /** The committed props object `clips` was last read from. */
  props: unknown;
  clips: boolean;
  /** The host's public instance, looked up the first time it clips. */
  instance: { measureInWindow: MeasureInWindow } | undefined;
}

export interface Ancestry {
  /** Every fiber above the view, nearest first, up to and including the tree's root. */
  readonly path: readonly FiberLike[];
  /** The fiber root (`HostRoot.stateNode`), or `null` when the path has none. */
  readonly root: { current?: unknown } | null;
  /** The hosts below the nearest root-kind host, nearest first. */
  readonly hosts: readonly HostAncestor[];
  /** The screens among `hosts`. */
  readonly screens: readonly HostAncestor[];
  /** Whether the last {@link isHidden} read everything; `false` clips nothing. */
  readable: boolean;
}

/** Nothing above the view can be read: it is never hidden and never clipped. */
export function noAncestry(): Ancestry {
  return { path: [], root: null, hosts: [], screens: [], readable: false };
}

/**
 * The ancestors of the host `fiber`, up to the tree's root. Only the hosts
 * below the nearest root-kind host can clip or hide it. `fiber` itself is
 * not included.
 */
export function ancestryOfFiber(fiber: FiberLike): Ancestry {
  const path: FiberLike[] = [];
  const hosts: HostAncestor[] = [];
  let bounded = false;
  let current = fiber.return;
  for (let steps = 0; current != null && steps < MAX_ANCESTORS; steps += 1) {
    bounded ||= current.tag === FiberTag.HostPortal;
    if (current.tag === FiberTag.HostComponent) {
      const below = hosts[hosts.length - 1];
      if (below !== undefined && below.above === MAX_ANCESTORS) {
        below.above = path.length;
      }
      const boundary = ROOT_KIND_HOST_TYPES.has(current.type);
      if (!bounded && (!boundary || current.type === MODAL_SCREEN_HOST_TYPE)) {
        hosts.push({
          index: path.length,
          above: MAX_ANCESTORS,
          scrolls: SCROLL_HOST_TYPES.has(current.type),
          screen: current.type === SCREEN_HOST_TYPE || current.type === MODAL_SCREEN_HOST_TYPE,
          boundary,
          props: UNREAD,
          clips: false,
          instance: undefined,
        });
      }
      bounded ||= boundary;
    }
    path.push(current);
    current = current.return;
  }
  const last = hosts[hosts.length - 1];
  if (last !== undefined && last.above === MAX_ANCESTORS) {
    last.above = path.length;
  }
  const top = path[path.length - 1];
  const root = top?.tag === FiberTag.HostRoot ? (top.stateNode as { current?: unknown } | null) : null;
  return { path, root, hosts, screens: hosts.filter((host) => host.screen), readable: false };
}

/**
 * The ancestry of a mounted host's public instance (Fabric's carries its
 * fiber as `__internalInstanceHandle`). {@link noAncestry} when there is no
 * fiber or the tree cannot be read.
 */
export function ancestryOfInstance(instance: object): Ancestry {
  try {
    // No fiber (or not an object) has no `.return`, or throws on reading it.
    const fiber = (instance as { __internalInstanceHandle?: unknown }).__internalInstanceHandle;
    return ancestryOfFiber(fiber as FiberLike);
  } catch {
    return noAncestry();
  }
}

/**
 * Each current parent's children, collected in the running pass the first
 * time any view looks among them, so views that are siblings in a long list
 * scan that list once a pass rather than once each.
 */
let passChildren: Map<FiberLike, Set<FiberLike>> | undefined;

/** The child of `parent` (a current fiber) that is `fiber` or its alternate, if any. */
function currentChild(parent: FiberLike, fiber: FiberLike): FiberLike | undefined {
  let children = passChildren?.get(parent);
  if (children === undefined) {
    children = new Set();
    for (let child = parent.child; child != null; child = child.sibling) {
      children.add(child);
    }
    passChildren?.set(parent, children);
  }
  // No child is null or undefined, so a missing alternate is never found.
  const alternate = fiber.alternate as FiberLike;
  return children.has(fiber) ? fiber : children.has(alternate) ? alternate : undefined;
}

/**
 * The current fiber of every fiber in `ancestry.path` from `downTo` up, in
 * the same order (entries below `downTo` are left as the root), or
 * `undefined` when the path does not resolve against the committed tree.
 * Reads fibers only, which React never makes throw.
 *
 * Nothing is kept from one pass to the next: React keeps no commit count, and
 * the root's `current` alternates between the same two fibers, so a cached
 * level cannot be told apart from one two commits stale.
 */
function resolve(ancestry: Ancestry, downTo = 0): FiberLike[] | undefined {
  const { path, root } = ancestry;
  // A root exists only on a path that ends at one.
  const top = path[path.length - 1] as FiberLike;
  const rootCurrent = root?.current as FiberLike | null | undefined;
  if (rootCurrent == null || (rootCurrent !== top && rootCurrent !== top.alternate)) {
    return undefined;
  }
  // The root's entry stays; every other is replaced below, or the path does
  // not resolve.
  const resolved = path.map(() => rootCurrent);
  for (let index = path.length - 2; index >= downTo; index -= 1) {
    const current = currentChild(resolved[index + 1] as FiberLike, path[index] as FiberLike);
    if (current === undefined) {
      return undefined;
    }
    resolved[index] = current;
  }
  return resolved;
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

/**
 * An `activityState` set on a fiber between a screen host and the host
 * above it (the `Animated.createAnimatedComponent` wrapper react-native-screens
 * renders the host through) that is not a plain number: an Animated node,
 * whose value native drives without React committing it.
 */
function animatedActivity(resolved: readonly FiberLike[], from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    const value = ((resolved[index] as FiberLike).memoizedProps as { activityState?: unknown } | null)
      ?.activityState;
    if (value !== null && typeof value === 'object') {
      return true;
    }
  }
  return false;
}

/** Re-reads `host`'s clip from its current fiber, if its committed props changed. */
function refresh(host: HostAncestor, resolved: readonly FiberLike[]): void {
  const props = (resolved[host.index] as FiberLike).memoizedProps;
  if (props !== host.props) {
    const overflow = styleValue((props as { style?: unknown } | null)?.style, 'overflow');
    host.clips = !host.boundary && (host.scrolls ? overflow !== 'visible' : overflow === 'hidden');
    // Only once read: a read that threw is tried again next time.
    host.props = props;
  }
}

/**
 * Whether `screen` hides the view in the committed tree: `activityState` 0
 * on its current fiber, not driven by an Animated node on the wrapper above
 * it, under a react-native-screens container that detaches inactive screens.
 */
function screenHides(screen: HostAncestor, ancestry: Ancestry, resolved: readonly FiberLike[]): boolean {
  const activityState = ((resolved[screen.index] as FiberLike).memoizedProps as { activityState?: unknown } | null)
    ?.activityState;
  return (
    activityState === INACTIVE_SCREEN &&
    SCREEN_CONTAINER_HOST_TYPES.has(ancestry.path[screen.above]?.type) &&
    !animatedActivity(resolved, screen.index + 1, screen.above)
  );
}

/**
 * Whether a react-native-screens screen above the view is inactive in the
 * committed tree (see `screenHides`). Also reads which hosts clip, for
 * {@link clipToAncestors}. When anything cannot be read (the path does not
 * resolve, or a props read throws) the answer is `false` and nothing is
 * clipped either.
 */
export function isHidden(ancestry: Ancestry): boolean {
  ancestry.readable = false;
  const resolved = resolve(ancestry);
  if (resolved === undefined) {
    return false;
  }
  // Props are the app's: a getter on one can throw.
  try {
    for (const host of ancestry.hosts) {
      refresh(host, resolved);
    }
    const hidden = ancestry.screens.some((screen) => screenHides(screen, ancestry, resolved));
    ancestry.readable = true;
    return hidden;
  } catch {
    return false;
  }
}

/**
 * The screens alone of {@link isHidden}, for a view withdrawn as hidden to
 * check every frame: it resolves the path only down to the nearest screen,
 * and only once a pass for every view under the same screen.
 */
export function screensHide(ancestry: Ancestry): boolean {
  const nearest = ancestry.screens[0];
  if (nearest === undefined) {
    return false;
  }
  const key = ancestry.path[nearest.index] as FiberLike;
  const known = passScreens?.get(key);
  if (known !== undefined) {
    return known;
  }
  const resolved = resolve(ancestry, nearest.index);
  let hidden: boolean;
  // An unresolved path (`undefined`) throws here as a props getter can.
  try {
    hidden = ancestry.screens.some((screen) => screenHides(screen, ancestry, resolved as FiberLike[]));
  } catch {
    hidden = false;
  }
  passScreens?.set(key, hidden).set(key.alternate, hidden);
  return hidden;
}

/** {@link screensHide}'s answers in the running pass, by both fibers of the nearest screen. */
let passScreens: Map<FiberLike | null | undefined, boolean> | undefined;

/**
 * The nodes whose movement can change how `ancestry`'s clipping ancestors
 * (as the last {@link isHidden} read them) cut the view: every clipping
 * host itself, whose bounds are the clip (a viewport that grows uncovers
 * more of the view), and a ScrollView's content container, which moves as
 * it scrolls.
 */
export function clipWatchNodes(ancestry: Ancestry): FiberLike[] {
  if (!ancestry.readable) {
    return [];
  }
  return ancestry.hosts
    .filter((host) => host.clips)
    .flatMap((host) => {
      const clipper = ancestry.path[host.index] as FiberLike;
      const below = ancestry.path[host.index - 1];
      return host.scrolls && below?.tag === FiberTag.HostComponent ? [below, clipper] : [clipper];
    });
}

/** Public instances of watched nodes, looked up once each. */
const nodeInstances = new WeakMap<FiberLike, { measureInWindow: MeasureInWindow }>();

/** `fiber`'s window rectangle, as {@link measureHost} answers, measured at most once a pass. */
export function measureFiber(fiber: FiberLike): WindowRect | null | undefined {
  let instance = nodeInstances.get(fiber);
  if (instance === undefined) {
    instance = publicInstanceOf(fiber);
    nodeInstances.set(fiber, instance);
  }
  return measureInstance(instance);
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
let passMeasurements: Map<object, WindowRect | null | undefined> | undefined;

/**
 * Runs `pass` with each clipping ancestor measured, and each ancestor's
 * current fiber resolved, at most once. Only for a synchronous stretch of JS
 * (the re-measure loop's tick): no commit can move anything while it runs.
 */
export function measurePass(pass: () => void): void {
  passMeasurements = new Map();
  passChildren = new Map();
  passScreens = new Map();
  try {
    pass();
  } finally {
    passMeasurements = undefined;
    passChildren = undefined;
    passScreens = undefined;
  }
}

/**
 * `host`'s window rectangle; `null` for an exact 0/0/0/0, which Fabric
 * answers for a node or layout it cannot find; `undefined` unless it answers
 * at once with finite numbers.
 */
function measureHost(host: HostAncestor, fiber: FiberLike): WindowRect | null | undefined {
  return measureInstance((host.instance ??= publicInstanceOf(fiber)));
}

function measureInstance(instance: { measureInWindow: MeasureInWindow }): WindowRect | null | undefined {
  if (passMeasurements?.has(instance)) {
    return passMeasurements.get(instance);
  }
  let measured: WindowRect | null | undefined;
  instance.measureInWindow((x, y, width, height) => {
    const answer = { x, y, width, height };
    if (finite(answer)) {
      measured = x === 0 && y === 0 && width === 0 && height === 0 ? null : answer;
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
 * Fails closed: `rect` itself, unclipped, when it is not finite, the last
 * read was not complete, or any clipping ancestor throws, answers late or
 * answers with a non-finite rectangle. An ancestor answering 0/0/0/0 clips
 * nothing. Measures nothing, and returns `rect` as it is, when nothing
 * clips.
 */
export function clipToAncestors(rect: WindowRect, ancestry: Ancestry): WindowRect | null {
  if (!finite(rect) || !ancestry.readable) {
    return rect;
  }
  const clips: Array<WindowRect | null | undefined> = [];
  try {
    for (const host of ancestry.hosts) {
      if (host.clips) {
        clips.push(measureHost(host, ancestry.path[host.index] as FiberLike));
      }
    }
  } catch {
    return rect;
  }
  if (clips.includes(undefined)) {
    return rect;
  }
  const known = clips.filter((clip): clip is WindowRect => clip !== null);
  if (known.length === 0) {
    return rect;
  }
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  for (const clip of known) {
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
