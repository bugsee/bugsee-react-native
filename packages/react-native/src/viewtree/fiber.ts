/**
 * The ONLY module in this package that reads React or React Native
 * internals. Everything else in `viewtree/` (starting with `walk.ts`) works
 * against the `FiberLike` shape declared here and never imports `react` or
 * `react-native` itself, so the privacy-sensitive tree walk stays testable
 * with plain fake objects and stays reviewable without React's own source.
 *
 * `scripts/check-rn-compat.sh` greps React Native's sources for the exact
 * internals this file depends on, on every supported minor version, so a
 * renderer change that would silently break this file fails CI instead.
 */

// React's own fiber tags (react-reconciler/src/ReactWorkTags.js). Only the
// tags this package's walk needs to recognise are listed; the numeric values
// are the ones React itself assigns and have been stable across the
// supported versions for years. The compat script's internals guard pins two
// of them at a distinctive, version-independent call site each — `SimpleMemo`
// (15, where a plain-function `memo()` downgrades to it) and `Offscreen` (22,
// compared directly against a fiber's `.tag`) — not all seventeen; the rest
// rely on React's own tag numbering never being renumbered wholesale, the
// same assumption every consumer of these internals makes.
export const FiberTag = {
  FunctionComponent: 0,
  ClassComponent: 1,
  HostRoot: 3,
  HostPortal: 4,
  HostComponent: 5,
  HostText: 6,
  Fragment: 7,
  Mode: 8,
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12,
  Suspense: 13,
  Memo: 14,
  SimpleMemo: 15,
  Offscreen: 22,
  LegacyHidden: 23,
} as const;

/**
 * The subset of a real React Fiber's fields this package reads. Deliberately
 * narrower than React's own (unexported) `Fiber` type: everything the walk
 * needs and nothing it doesn't, so a fake fiber tree in a test is exactly as
 * capable as a real one for this package's purposes.
 *
 * `child`/`sibling`/`return` are typed as `FiberLike | null`, but nothing in
 * `walk.ts` trusts that a real or malformed fiber actually honours it —
 * `undefined`, or a non-object value entirely, is tolerated the same as
 * `null` throughout, since only React's own reconciler is obliged to keep
 * that promise and this package reads fibers it did not build.
 */
export interface FiberLike {
  tag: number;
  type: unknown;
  elementType?: unknown;
  child: FiberLike | null;
  sibling: FiberLike | null;
  return: FiberLike | null;
  memoizedProps: unknown;
  /**
   * Only ever inspected on an `Offscreen`/`LegacyHidden` fiber, to tell a
   * hidden subtree from a visible one: React's `updateOffscreenComponent`
   * sets this to a `{ baseLanes, cachePool }` object while `mode === "hidden"`
   * and to `null` otherwise (both current and stale-then-cleared cases) —
   * the same field React's own commit phase relies on, not a prop and not
   * the `_visibility` bit some renderer versions also keep on `stateNode`.
   * See `walk.ts`'s `isHidden`.
   */
  memoizedState: unknown;
  stateNode: unknown;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A host public instance (what a `ref` to a host component resolves to, e.g.
 * a `View`) carries the fiber it was created for on `__internalInstanceHandle`
 * — assigned in `ReactNativeElement.js` on every supported version, and also
 * in `ReactFabricHostComponent.js` on React Native 0.81 (removed outright,
 * not folded elsewhere, by 0.87 — `ReactFabricPublicInstance.js` only ever
 * *reads* the field). Both assignment sites are covered by the compat
 * script's internals guard, which checks for an actual assignment, not a
 * read or a type declaration. Walking `.return` from there to the nearest
 * `HostRoot` fiber and reading that fiber's `stateNode` recovers the
 * `FiberRoot`, whose `.current` is the tree's current root fiber — the
 * argument `buildViewTree` (`walk.ts`) walks from.
 *
 * Never throws and never loops forever: a missing, non-object or cyclic
 * `.return` chain (all of which would be a bug elsewhere, never legitimate)
 * ends the walk with `null` rather than a `TypeError` or a hang. Nor does a
 * *hostile* `publicInstance` — one whose fields are throwing getters, or a
 * revoked `Proxy` — because `Task 6.4`'s exported `registerAnchor(instance:
 * unknown)` calls this on whatever gets registered, and its own spec turns
 * any throw here into a `null` reply for every root, for as long as that one
 * bad object stays registered. See the `try`/`catch` in `fiberRootOf` itself.
 */
const FIBER_ROOT_RETURN_CHAIN_CAP = 10_000;

/**
 * True for a real object, `false` for `null`, `undefined` and every
 * primitive — a single, once-tested answer to "is this safe to treat as a
 * fiber/handle/state node", instead of a `=== null || typeof !== 'object'`
 * (or `== null || …`) repeated at each of `fiberRootOf`'s four checks, which
 * would leave each repetition's own redundancy to prove on its own.
 */
function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

export function fiberRootOf(publicInstance: unknown): { current: FiberLike } | null {
  // Both defences stay, deliberately: the explicit `isObject` checks below
  // make every *plain*, well-formed-but-wrong-shaped input safe on their
  // own (a missing/non-object handle, a `.return` chain that never reaches
  // a HostRoot, a HostRoot with no usable `stateNode`), and each is tested
  // in isolation. The outer `try`/`catch` is for the input those checks
  // cannot see coming: a throwing getter on any of `__internalInstanceHandle`
  // / `.tag` / `.return` / `.stateNode`, a `Proxy` whose `get` trap throws,
  // or a revoked `Proxy` used as `publicInstance` or as the handle itself —
  // none of which are "a fiber", but all of which this function's public
  // contract ("never throws") must still survive, since `Task 6.4`'s
  // `registerAnchor(instance: unknown)` calls this on whatever a consumer
  // registers. A round of review found this function still threw on exactly
  // those inputs when the `try` was left off in favour of the explicit
  // checks alone (see the equivalent-mutant note below) — a public-surface
  // "never throws" contract is worth more than a few fully-equivalent
  // mutants inside the checks the `try` now also backstops.
  try {
    if (!isObject(publicInstance)) {
      return null;
    }

    const handle = (publicInstance as { __internalInstanceHandle?: unknown }).__internalInstanceHandle;
    if (!isObject(handle)) {
      return null;
    }

    let fiber = handle as FiberLike;
    for (let steps = 0; fiber.tag !== FiberTag.HostRoot; steps += 1) {
      if (steps >= FIBER_ROOT_RETURN_CHAIN_CAP) {
        // A `.return` chain this long is a cycle (or some other corruption),
        // never a real tree: React's own depth cap is nowhere near this.
        return null;
      }
      // `isObject`, not just `!== null`: a malformed fiber's `.return` being
      // `undefined` (rather than the `null` React itself would leave at the
      // top), or any other non-object value, ends the walk the same way, not
      // with a `TypeError` on the next iteration.
      const parent = fiber.return;
      if (!isObject(parent)) {
        return null;
      }
      fiber = parent;
    }

    const stateNode = fiber.stateNode;
    if (!isObject(stateNode)) {
      return null;
    }
    const current = (stateNode as { current?: unknown }).current;
    if (!isObject(current)) {
      return null;
    }
    return stateNode as { current: FiberLike };
  } catch {
    return null;
  }
}

type MeasureInWindowCallback = (x: number, y: number, width: number, height: number) => void;

interface RendererProxyLike {
  // Declared as callable, not optional: if the real module ever disagrees
  // (missing, or some other shape), calling it throws, and the `try` below
  // is what turns that into a clean `null` — a type check ahead of the call
  // would only ever be re-deciding the same thing the `try` already decides.
  getPublicInstanceFromInternalInstanceHandle: (fiber: unknown) => unknown;
}

/**
 * Measures a host fiber's on-screen rectangle the same way a `ref.current`
 * would (`measureInWindow`), but from the fiber alone — the wrapper never
 * holds a `ref` to the app's own views. `RendererProxy` (re-exporting
 * `RendererImplementation`, per the compat script's guard) is the supported
 * way to go from an internal instance handle to the public instance that
 * carries `measureInWindow`. The rectangle is the main React root's window,
 * the same space `<BugseeSecure>` publishes. A host inside a React Native
 * `<Modal>` (its own window; an Android `Dialog`) does not line up with the
 * native tree.
 *
 * Required lazily, not imported at module load: React Native ships this
 * module as untranspiled Flow/ESM source, meant to be read by Metro, and
 * loading it under plain Jest throws a SyntaxError. Every caller of this
 * function mocks the module; nothing that merely imports `FiberTag` or
 * `FiberLike` from this file should have to.
 */
export function measureHostFiber(fiber: FiberLike): WindowRect | null {
  // Two `try` blocks, each around exactly one call into code this module
  // does not control: loading the module and asking it for the public
  // instance, then asking that instance to measure itself. Nothing here
  // pre-checks the shape of what comes back first — a bad shape throws when
  // used a line later, inside the very next `try`, which is indistinguishable
  // from the renderer itself throwing and must be handled the same way
  // regardless.
  let publicInstance: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see the doc comment above: this must stay a lazy require.
    const rendererProxy: RendererProxyLike = require('react-native/Libraries/ReactNative/RendererProxy');
    publicInstance = rendererProxy.getPublicInstanceFromInternalInstanceHandle(fiber);
  } catch {
    return null;
  }

  const measurable = publicInstance as { measureInWindow: (callback: MeasureInWindowCallback) => void };

  // Pinned behaviour, tested explicitly (not merely an untested consequence
  // of the `catch`): if the callback fires synchronously with a good rect
  // and `measureInWindow` *itself* then throws — some cleanup step inside
  // the renderer failing after already reporting a measurement — this still
  // returns `null`, not the rect the callback captured. A mid-call throw
  // means the renderer's own state around this measurement is not something
  // this module trusts, and there is exactly one "unmeasurable" outcome for
  // every way that call can go wrong, not a special case for "wrong, but
  // only after telling us something first".
  let delivered = false;
  let result: WindowRect | null = null;
  try {
    measurable.measureInWindow((x, y, width, height) => {
      delivered = true;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) {
        result = { x, y, width, height };
      }
    });
  } catch {
    return null;
  }

  return delivered ? result : null;
}
