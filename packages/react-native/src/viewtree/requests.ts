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
import { RootErrorReporter } from '../exceptions/RootErrorReporter';
import { BugseeSecure } from '../secure/BugseeSecure';
import { secureRectangleScale } from '../secure/unit';
import { VH_ANCHOR_NATIVE_ID } from './constants';
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

/**
 * Marks `component` as one `wrap()` produced. See `wrapComponents`.
 * @internal Only `anchor.tsx`'s `wrap` calls this; it is exported (rather
 * than made a closure `wrap` and `isWrapper` both capture) only because they
 * live in different modules, and is not part of the package's public API.
 */
export function markWrapComponent(component: object): void {
  wrapComponents.add(component);
}

/**
 * True for the fiber `wrap()` itself renders as, the `RootErrorReporter`
 * it mounts around the app root, or for the anchor view it renders alongside
 * -- none of those are real app content, and `walk.ts` flattens them away
 * (their children, if any, are promoted to whatever ancestor node IS
 * emitted) rather than showing a synthetic "BugseeRoot" / reporter node or
 * the invisible anchor in the captured tree.
 *
 * The anchor is recognised by its `nativeID`, not by fiber identity: the
 * fiber `wrap()`'s `<View>` element resolves to is rebuilt on every render,
 * while the prop survives unchanged for as long as the anchor is mounted.
 * Reading `nativeID` off a host fiber is exactly what `walk.ts`'s own privacy
 * rule already allows (`tagOptions`), so this reads nothing the walk itself
 * could not have read anyway.
 *
 * Exported only so `walk.test.ts` can assert the RootErrorReporter identity
 * check against the same predicate production uses (manual mutate 3); not
 * part of this module's public contract with the rest of the package.
 */
export function isWrapper(fiber: FiberLike): boolean {
  const type = fiber.type;
  if (type === RootErrorReporter) {
    return true;
  }
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
 *
 * `BugseeSecure` is a plain function component (its own doc comment: "no
 * `memo`, no `forwardRef`: the view tree walk recognises it by identity"),
 * so today a real fiber only ever matches on `.type`: a plain
 * `FunctionComponent` fiber's `.type` IS the function. Checking `.elementType`
 * too is not, despite an earlier version of this comment, coverage for
 * `memo`/`forwardRef` -- `memo(BugseeSecure)` still matches on `.type` (a
 * `SimpleMemo` fiber's `.type` is the inner function; a `Memo` fiber with a
 * custom `compare` has its own `FunctionComponent` child fiber, unaffected
 * either way), and wrapping `BugseeSecure` in `forwardRef` would match
 * neither `.type` nor `.elementType`. `.elementType` differs from `.type`
 * only when a component's type is *resolved at render time* -- a Fast
 * Refresh family (dev only) or `React.lazy` -- so this check costs nothing
 * and is free insurance against exactly that, not against a wrapper change.
 * If `BugseeSecure` is ever wrapped (`forwardRef`, `memo` with a custom
 * `compare` that still fails to match for some other reason, etc.), THIS
 * function must change too -- `wrap.integration.test.tsx`'s real-render test
 * would catch a regression here, since it renders the actual component.
 *
 * Fails closed on `<BugseeSecure enabled={false}>` too: this reads only the
 * fiber's type, never its `enabled` prop, so a disabled boundary is still
 * secure from the WALK's point of view. That is deliberate (privacy over
 * completeness, matching `walk.ts`'s own `safeIsSecureBoundary` stance) and
 * costs nothing extra to document: reading `enabled` here would mean one more
 * prop this module touches, for a case `BugseeSecure` itself already handles
 * by not being mounted at all when disabled long enough to matter.
 */
function isSecureBoundary(fiber: FiberLike): boolean {
  return fiber.type === BugseeSecure || fiber.elementType === BugseeSecure;
}

/**
 * `performance.now()` when it exists AND returns a finite number (every real
 * React Native and browser-like JS engine), `Date.now()` otherwise -- a plain
 * JVM/Node test environment with no `performance` global, or a hostile/buggy
 * one whose `.now()` returns `NaN`/`undefined`/a string, say. Only ever used
 * as a duration's two endpoints, so the epoch it counts from does not matter.
 *
 * The finite check matters on its own, not just the existence check:
 * `walk.ts`'s `safeNow` coerces a non-finite `now()` result to `0`
 * (`Number.isFinite`), and if BOTH the walk's start time and every later
 * check coerced to the same `0`, the 250 ms walk budget (`VH_WALK_BUDGET_MS`)
 * would never trip -- silently disabling the one bound that keeps a
 * pathological tree's walk inside the SDK's own capture deadline. Falling
 * back to `Date.now()` here, instead of letting a bad `performance.now()`
 * reach `safeNow` at all, keeps that budget live regardless.
 *
 * Exported only for `__tests__/requests.test.ts`'s own direct tests of this
 * fallback; not part of this module's public contract with the rest of the
 * package (see `markWrapComponent`'s doc comment for the same caveat).
 */
export function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') {
    const value = perf.now();
    if (Number.isFinite(value)) {
      return value;
    }
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
    // Only Android and iOS are meaningfully distinguished anywhere in this
    // package (see `secure/unit.ts`'s identical choice for the same reason):
    // every other `Platform.OS` (windows/macos/web) maps to iOS's 1:1, no-
    // scaling convention rather than to a third `WalkEnv.platform` value the
    // type does not even have room for.
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    scale: secureRectangleScale(),
    originX: event.originX,
    originY: event.originY,
    now: monotonicNow,
  };
}

/**
 * The JSON text to reply with for a `'vh'` request that has at least one root
 * to walk, or `null` for every outcome that isn't a real tree.
 *
 * `buildViewTree` returning `null` (nothing measurable yet, everything under
 * a hidden `Offscreen`, or every root's `.current` empty) must reply actual
 * `null` -- `JSON.stringify(null)` is the four-character STRING `"null"`, a
 * non-empty string the SDK would store as a real (if odd) `managed` payload
 * instead of recognising "nothing to report". `undefined` (not a contract
 * `buildViewTree` documents, but `payload` must survive it regardless) and a
 * throwing `JSON.stringify` (a cyclic structure, or a `BigInt` somehow
 * reaching a node) both collapse to `null` the same way.
 */
function replyPayloadFor(tree: ReturnType<typeof buildViewTree>): string | null {
  if (tree == null) {
    return null;
  }
  try {
    const json = JSON.stringify(tree);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

/**
 * Answers one `onDataRequest` delivery. Always calls `replyDataRequest`
 * exactly once, synchronously -- the SDK waits on it mid-capture -- no matter
 * which of `type`, "nothing mounted", "the walk itself threw" or "the reply
 * itself threw" applies.
 *
 * The payload is computed entirely inside the `try`; `replyDataRequest` is
 * then called exactly once, outside it, in its own `try` that only warns.
 * Computing the payload first (rather than calling `replyDataRequest` from
 * inside each branch, as an earlier version of this function did) means a
 * throwing `replyDataRequest` cannot be retried into throwing a second time:
 * there is exactly one call site for it, not one per branch plus one in the
 * `catch`.
 *
 * A `type` other than `'vh'` is native's own to answer; this replies `null`
 * without walking anything. `roots.length === 0` (nothing registered, or
 * every registered anchor's fiber root is gone) also replies `null` directly,
 * rather than asking `buildViewTree` to walk zero roots only to have it
 * return `null` itself -- the two are observably the same to native, but the
 * former skips work `buildViewTree` cannot do anything useful with anyway.
 *
 * "Warns once" means once per FAILING request, not once ever for the whole
 * process: a walk that fails deterministically (a persistently broken
 * `isSecureBoundary`, say) should keep saying so on every capture pass, not
 * go quiet after the first one the way `BugseeSecure`'s own one-time
 * `console.warn` does for an unrelated, expected-to-be-rare failure.
 */
function onDataRequest(event: DataRequestEvent): void {
  let payload: string | null = null;
  try {
    if (event.type === VH_DATA_TYPE) {
      const roots = currentRoots();
      if (roots.length > 0) {
        payload = replyPayloadFor(buildViewTree(roots, buildEnv(event)));
      }
    }
  } catch (error) {
    console.warn('[Bugsee] could not answer a view-hierarchy data request', error);
    payload = null;
  }
  try {
    NativeBugsee.replyDataRequest(event.requestId, payload);
  } catch (error) {
    console.warn('[Bugsee] could not deliver a view-hierarchy reply', error);
  }
}

/**
 * Registers a mounted anchor's public instance (`anchor.tsx`'s `wrap`, on
 * mount). The first anchor ever registered subscribes to `onDataRequest` --
 * once, for the life of the process, never torn down -- and every transition
 * from zero registered anchors to one turns view-tree capture on
 * (`setViewTreeEnabled(true)`), so the SDK only asks for `'vh'` while there is
 * somewhere to answer it from.
 *
 * Idempotent per instance: registering the SAME instance twice in a row (an
 * anchor's own effect re-running under `<StrictMode>`'s double-invoke, say)
 * is a no-op the second time -- `isNew` is checked BEFORE adding, rather than
 * inferred from a size comparison after, so this holds regardless of how many
 * OTHER anchors are registered at the same time.
 */
export function registerAnchor(instance: unknown): void {
  const isNew = !anchors.has(instance);
  anchors.add(instance);
  if (!subscribedToDataRequests) {
    subscribedToDataRequests = true;
    NativeBugsee.onDataRequest(onDataRequest);
  }
  if (isNew && anchors.size === 1) {
    NativeBugsee.setViewTreeEnabled(true);
  }
}

/**
 * Unregisters a mounted anchor's public instance (`anchor.tsx`'s `wrap`, on
 * unmount). The transition from one registered anchor to zero turns view-tree
 * capture off (`setViewTreeEnabled(false)`); the subscription itself is never
 * removed, so a later `registerAnchor` can turn capture back on without
 * resubscribing.
 *
 * Idempotent per instance: `Set.delete` returns whether `instance` was
 * actually present, so unregistering an instance that is already gone -- a
 * stale second call, from `<StrictMode>`'s double-invoke or any other
 * duplicate teardown -- never reaches `setViewTreeEnabled` at all, tied
 * directly to whether THIS call actually removed something, rather than to a
 * `sizeBefore`/`sizeAfter` comparison captured around the delete. An earlier
 * version of this function used exactly that `sizeBefore === 1 && size === 0`
 * comparison; it happened to still be correct for every sequence tested, but
 * was one step further from the property that actually matters ("did this
 * specific call remove the last anchor") than this version is, and a review
 * round flagged the gap: `register(a); register(b); unregister(a);
 * unregister(a)` -- the redundant second `unregister(a)` -- is exactly the
 * stale-double-unregister-while-another-anchor-is-mounted case this version
 * is tested against directly.
 */
export function unregisterAnchor(instance: unknown): void {
  if (anchors.delete(instance) && anchors.size === 0) {
    NativeBugsee.setViewTreeEnabled(false);
  }
}
