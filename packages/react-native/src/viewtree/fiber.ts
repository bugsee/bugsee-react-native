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
// are the ones React itself assigns and are stable across the supported
// versions (checked by the compat script's internals guard).
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
 */
export interface FiberLike {
  tag: number;
  type: unknown;
  elementType?: unknown;
  child: FiberLike | null;
  sibling: FiberLike | null;
  return: FiberLike | null;
  memoizedProps: unknown;
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
 * — assigned in `ReactFabricHostComponent.js` on React Native <= 0.8x and in
 * `ReactNativeElement.js` (its DOM-shaped replacement) on newer versions; both
 * are covered by the compat script. Walking `.return` from there to the
 * nearest `HostRoot` fiber and reading that fiber's `stateNode` recovers the
 * `FiberRoot`, whose `.current` is the tree's current root fiber — the
 * argument `buildViewTree` (`walk.ts`) walks from.
 */
export function fiberRootOf(publicInstance: unknown): { current: FiberLike } | null {
  if (publicInstance === null || typeof publicInstance !== 'object') {
    return null;
  }

  const handle = (publicInstance as { __internalInstanceHandle?: unknown }).__internalInstanceHandle;
  // `typeof handle !== 'object'` already covers both `null` (a JS quirk:
  // `typeof null === 'object'`, so it needs its own check) and `undefined`
  // (whose typeof is the distinct string `'undefined'`, already excluded).
  if (handle === null || typeof handle !== 'object') {
    return null;
  }

  let fiber = handle as FiberLike;
  while (fiber.tag !== FiberTag.HostRoot) {
    const parent = fiber.return;
    if (parent === null) {
      return null;
    }
    fiber = parent;
  }

  const stateNode = fiber.stateNode;
  if (stateNode === null || typeof stateNode !== 'object' || !('current' in stateNode)) {
    return null;
  }
  return stateNode as { current: FiberLike };
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
 * carries `measureInWindow`.
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
