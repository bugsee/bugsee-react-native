/**
 * The JS side of the native SDK's `'vh'` (view hierarchy) data request:
 * tracks which anchors (`anchor.tsx`'s `wrap`) are mounted, turns
 * `onDataRequest` on and off with them, and answers every delivery by walking
 * the fiber trees those anchors sit in (`./walk`'s `buildViewTree`) and
 * replying with the result.
 *
 * The only module besides `anchor.tsx` and `./fiber`/`./walk` that knows
 * about the view tree at all; everything platform- or React-specific that
 * `WalkEnv` needs (the renderer's measurement, the secure boundary and
 * wrapper identities, the platform's unit and scale, a clock) is assembled
 * here, once per request, from real `react-native` and this package's own
 * modules -- `walk.ts` itself stays free of both.
 */
import { Platform } from 'react-native';
import NativeBugsee from '../NativeBugsee';
import { BugseeSecure } from '../secure/BugseeSecure';
import { secureRectangleScale } from '../secure/unit';
import { VH_ANCHOR_NATIVE_ID } from './anchor';
import { FiberTag, fiberRootOf, measureHostFiber } from './fiber';
import type { FiberLike } from './fiber';
import { buildViewTree } from './walk';
import type { WalkEnv } from './walk';

/** The only data-request type this version answers; native answers every other type itself. */
export const VH_DATA_TYPE = 'vh';

interface DataRequestEvent {
  requestId: string;
  type: string;
  originX: number;
  originY: number;
}

/**
 * Every public instance `registerAnchor` currently holds, in registration
 * order. A `Set`, not a count: `unregisterAnchor` must remove the exact
 * instance it was given, and two anchors in the same surface must still walk
 * that surface's root only once (`currentRoots` dedupes by `FiberRoot`
 * identity, not by anchor count).
 */
const anchors = new Set<unknown>();

/** Set exactly once, the first time any anchor ever registers, and never unset -- the subscription outlives every individual anchor mounting and unmounting. */
let subscribedToDataRequests = false;

/**
 * Every function `wrap` has ever returned, so `isWrapper` can recognise ANY
 * of them by identity even though `wrap` may be called more than once (and
 * therefore produce more than one distinct function). A `WeakSet` rather than
 * comparing against one remembered reference, the way `isSecureBoundary`
 * compares against the single `BugseeSecure` function -- there is only ever
 * one `BugseeSecure`, but a fresh component is minted on every `wrap` call.
 *
 * Internal: only `anchor.tsx`'s `wrap` calls `markWrapComponent`. Not part of
 * this module's public contract with the rest of the package.
 */
const wrapComponents = new WeakSet<object>();

/** Marks `component` as one `wrap()` produced. See `wrapComponents`. */
export function markWrapComponent(component: object): void {
  wrapComponents.add(component);
}

/**
 * True for the fiber `wrap()` itself renders as, or for the anchor view it
 * renders alongside the wrapped root -- neither is real app content, and
 * `walk.ts` flattens both away (their children, if any, are promoted to
 * whatever ancestor node IS emitted) rather than showing a synthetic
 * "BugseeRoot" node or the invisible anchor in the captured tree.
 *
 * The anchor is recognised by its `nativeID`, not by fiber identity: the
 * fiber `wrap()`'s `<View>` element resolves to is rebuilt on every render,
 * while the prop survives unchanged for as long as the anchor is mounted.
 * Reading `nativeID` off a host fiber is exactly what `walk.ts`'s own privacy
 * rule already allows (`tagOptions`), so this reads nothing the walk itself
 * could not have read anyway.
 */
function isWrapper(fiber: FiberLike): boolean {
  const type = fiber.type;
  if (typeof type === 'function' && wrapComponents.has(type)) {
    return true;
  }
  if (fiber.tag !== FiberTag.HostComponent) {
    return false;
  }
  const props = fiber.memoizedProps as { nativeID?: unknown } | null | undefined;
  return props?.nativeID === VH_ANCHOR_NATIVE_ID;
}

/**
 * True for the fiber that is the `<BugseeSecure>` boundary itself.
 * `BugseeSecure` is a plain function component (its own doc comment: "no
 * `memo`, no `forwardRef`: the view tree walk recognises it by identity"),
 * so a `FunctionComponent` fiber's `.type` is the function -- `.elementType`
 * is checked too only because it is free and costs nothing should that ever
 * change.
 */
function isSecureBoundary(fiber: FiberLike): boolean {
  return fiber.type === BugseeSecure || fiber.elementType === BugseeSecure;
}

/** `performance.now()` when it exists (every real React Native and browser-like JS engine), `Date.now()` otherwise -- a plain JVM/Node test environment, say. Only ever used as a duration's two endpoints, so the epoch it counts from does not matter. */
function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') {
    return perf.now();
  }
  return Date.now();
}

/**
 * Every currently-registered anchor's `FiberRoot`, deduped by `FiberRoot`
 * identity so two anchors mounted under the same root (two `wrap()`ped
 * surfaces sharing one React root, however unlikely) walk it once, not twice.
 * An anchor whose `fiberRootOf` is `null` -- unmounted, or never a real host
 * instance -- is skipped rather than represented as an empty root.
 */
function currentRoots(): { current: FiberLike }[] {
  const seen = new Set<{ current: FiberLike }>();
  const roots: { current: FiberLike }[] = [];
  for (const instance of anchors) {
    const root = fiberRootOf(instance);
    if (root === null || seen.has(root)) {
      continue;
    }
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

function buildEnv(event: DataRequestEvent): WalkEnv {
  return {
    measure: measureHostFiber,
    isSecureBoundary,
    isWrapper,
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    scale: secureRectangleScale(),
    originX: event.originX,
    originY: event.originY,
    now: monotonicNow,
  };
}

/**
 * Answers one `onDataRequest` delivery. Always calls `replyDataRequest`
 * exactly once, synchronously -- the SDK waits on it mid-capture -- no matter
 * which of `type`, "nothing mounted" or "the walk itself threw" applies.
 *
 * A `type` other than `'vh'` is native's own to answer; this replies `null`
 * without walking anything. `roots.length === 0` (nothing registered, or
 * every registered anchor's fiber root is gone) also replies `null` directly,
 * rather than asking `buildViewTree` to walk zero roots only to have it
 * return `null` itself -- the two are observably the same to native, but the
 * former skips work `buildViewTree` cannot do anything useful with anyway.
 */
function onDataRequest(event: DataRequestEvent): void {
  try {
    if (event.type !== VH_DATA_TYPE) {
      NativeBugsee.replyDataRequest(event.requestId, null);
      return;
    }
    const roots = currentRoots();
    if (roots.length === 0) {
      NativeBugsee.replyDataRequest(event.requestId, null);
      return;
    }
    const tree = buildViewTree(roots, buildEnv(event));
    NativeBugsee.replyDataRequest(event.requestId, JSON.stringify(tree));
  } catch (error) {
    console.warn('[Bugsee] could not answer a view-hierarchy data request', error);
    NativeBugsee.replyDataRequest(event.requestId, null);
  }
}

/**
 * Registers a mounted anchor's public instance (`anchor.tsx`'s `wrap`, on
 * mount). The first anchor ever registered subscribes to `onDataRequest` --
 * once, for the life of the process, never torn down -- and every transition
 * from zero registered anchors to one turns view-tree capture on
 * (`setViewTreeEnabled(true)`), so the SDK only asks for `'vh'` while there is
 * somewhere to answer it from.
 */
export function registerAnchor(instance: unknown): void {
  const sizeBefore = anchors.size;
  anchors.add(instance);
  if (!subscribedToDataRequests) {
    subscribedToDataRequests = true;
    NativeBugsee.onDataRequest(onDataRequest);
  }
  if (sizeBefore === 0 && anchors.size === 1) {
    NativeBugsee.setViewTreeEnabled(true);
  }
}

/**
 * Unregisters a mounted anchor's public instance (`anchor.tsx`'s `wrap`, on
 * unmount). The transition from one registered anchor to zero turns view-tree
 * capture off (`setViewTreeEnabled(false)`); the subscription itself is never
 * removed, so a later `registerAnchor` can turn capture back on without
 * resubscribing.
 */
export function unregisterAnchor(instance: unknown): void {
  const sizeBefore = anchors.size;
  anchors.delete(instance);
  if (sizeBefore === 1 && anchors.size === 0) {
    NativeBugsee.setViewTreeEnabled(false);
  }
}
