/**
 * A builder for fake fiber trees, so `walk.test.ts` can exercise `walk.ts`
 * without React or `react-test-renderer` anywhere in the picture. Shapes
 * mirror what React's own reconciler actually puts on a fiber for each tag
 * (see the comments on `offscreen`, `memoFiber` and `simpleMemoFiber`), not
 * just what happens to make the tests pass — `realFiberNaming.test.ts` cross
 * -checks the naming-sensitive ones against a real fiber tree.
 */
import { FiberTag } from '../fiber';
import type { FiberLike, WindowRect } from '../fiber';

export interface FiberSpec {
  tag: number;
  type?: unknown;
  /** Defaults to `type` when omitted, matching a plain fiber where React never gives the two different values. */
  elementType?: unknown;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  stateNode?: unknown;
  children?: FiberSpec[];
}

interface BuildTask {
  spec: FiberSpec;
  setInto: (fiber: FiberLike) => void;
}

/**
 * Iterative on purpose (an explicit stack, not recursion): a test that wants
 * a fiber chain thousands of levels deep to exercise `walk.ts`'s own
 * iterative traversal must not blow the stack building the *fixture* first.
 */
export function buildFiberTree(rootSpec: FiberSpec): FiberLike {
  let root: FiberLike | undefined;
  const stack: BuildTask[] = [{ spec: rootSpec, setInto: (fiber) => { root = fiber; } }];

  while (stack.length > 0) {
    const task = stack.pop() as BuildTask;
    const { spec, setInto } = task;

    const fiber: FiberLike = {
      tag: spec.tag,
      type: spec.type,
      elementType: 'elementType' in spec ? spec.elementType : spec.type,
      child: null,
      sibling: null,
      return: null,
      memoizedProps: spec.memoizedProps ?? {},
      memoizedState: spec.memoizedState ?? null,
      stateNode: spec.stateNode ?? null,
    };
    setInto(fiber);

    const children = spec.children ?? [];
    let previous: FiberLike | null = null;
    const childTasks: BuildTask[] = children.map((childSpec) => ({
      spec: childSpec,
      setInto: (childFiber) => {
        childFiber.return = fiber;
        if (previous === null) {
          fiber.child = childFiber;
        } else {
          previous.sibling = childFiber;
        }
        previous = childFiber;
      },
    }));
    // Pushed in reverse so the LIFO stack still pops (and thus builds and
    // links) children in their original left-to-right order.
    for (let i = childTasks.length - 1; i >= 0; i -= 1) {
      stack.push(childTasks[i] as BuildTask);
    }
  }

  return root as FiberLike;
}

/** Wraps a spec into the `{ current }` shape `buildViewTree` takes a list of. */
export function fiberRoot(spec: FiberSpec): { current: FiberLike } {
  return { current: buildFiberTree(spec) };
}

export const host = (
  type: string,
  rect: WindowRect | null,
  children: FiberSpec[] = [],
  props: Record<string, unknown> = {},
): FiberSpec => ({ tag: FiberTag.HostComponent, type, memoizedProps: props, stateNode: { rect }, children });

export const text = (): FiberSpec => ({ tag: FiberTag.HostText, type: undefined });

export const fn = (type: unknown, children: FiberSpec[] = [], props: Record<string, unknown> = {}): FiberSpec => ({
  tag: FiberTag.FunctionComponent,
  type,
  memoizedProps: props,
  children,
});

export const classComponent = (type: unknown, children: FiberSpec[] = []): FiberSpec => ({
  tag: FiberTag.ClassComponent,
  type,
  children,
});

/** `fiber.type` is the wrapper `{ $$typeof, render }` React's `forwardRef(fn)` produces; the fiber never gets a separate `elementType`. */
export const forwardRefFiber = (render: unknown, children: FiberSpec[] = []): FiberSpec => ({
  tag: FiberTag.ForwardRef,
  type: { render },
  children,
});

/**
 * Tag 14 (Memo) — the shape React's `updateMemoComponent` leaves a memo
 * fiber in when it does NOT downgrade to SimpleMemo (a class component, a
 * custom `compare`, or `defaultProps` on the wrapped function): `fiber.type`
 * stays the memo wrapper `{ $$typeof, type: inner, compare }` itself.
 */
export const memoFiber = (inner: unknown, children: FiberSpec[] = [], wrapperDisplayName?: string): FiberSpec => {
  const wrapper: { type: unknown; compare: null; displayName?: string } = { type: inner, compare: null };
  if (wrapperDisplayName !== undefined) {
    wrapper.displayName = wrapperDisplayName;
  }
  return { tag: FiberTag.Memo, type: wrapper, elementType: wrapper, children };
};

/**
 * Tag 15 (SimpleMemo) — the shape React's `updateMemoComponent` actually
 * builds the first time a *plain-function, comparator-less* `memo(fn)`
 * renders: `fiber.type` is reassigned to the inner function directly, and
 * the original memo wrapper survives only on `fiber.elementType`. Verified
 * against a real fiber tree in `realFiberNaming.test.ts` — this is NOT the
 * same shape as `memoFiber` above (an earlier version of this file wrongly
 * gave SimpleMemo the Memo shape).
 */
export const simpleMemoFiber = (inner: unknown, children: FiberSpec[] = [], wrapperDisplayName?: string): FiberSpec => {
  const wrapper: { type: unknown; compare: null; displayName?: string } = { type: inner, compare: null };
  if (wrapperDisplayName !== undefined) {
    wrapper.displayName = wrapperDisplayName;
  }
  return { tag: FiberTag.SimpleMemo, type: inner, elementType: wrapper, children };
};

export const fragment = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.Fragment, children });
export const provider = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.ContextProvider, children });
export const consumer = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.ContextConsumer, children });
export const mode = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.Mode, children });
export const portal = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.HostPortal, children });

/**
 * `memoizedState` is the real field React's `updateOffscreenComponent` sets:
 * a `{ baseLanes, cachePool }` object while `mode === "hidden"`, `null`
 * otherwise (verified against the bundled ReactFabric renderer for both
 * supported RN versions — see `walk.ts`'s `isHidden`). Not the `_visibility`
 * bit some renderer versions also keep on `stateNode` — a fake keyed on that
 * field would not exercise what `walk.ts` actually reads.
 */
export const offscreen = (visible: boolean, children: FiberSpec[] = []): FiberSpec => ({
  tag: FiberTag.Offscreen,
  memoizedState: visible ? null : { baseLanes: 0, cachePool: null },
  children,
});

/** An Offscreen fiber whose `memoizedState` is some unrecognised shape — must fail closed (dropped), not fall back to "visible". */
export const offscreenWithUnknownState = (memoizedState: unknown, children: FiberSpec[] = []): FiberSpec => ({
  tag: FiberTag.Offscreen,
  memoizedState,
  children,
});

/** `LegacyHidden` has no verified shape in any supported renderer (OSS React never exposes `unstable_LegacyHidden`) — always dropped, so this fixture takes no visibility parameter. */
export const legacyHidden = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.LegacyHidden, children });

/** Wraps `props` in a Proxy that records every key ever read, checked-for or enumerated off it into `reads` — `get`, `has` (`in`/destructuring), `ownKeys` (`Object.keys`/spread) and `getOwnPropertyDescriptor`. */
export function trackedProps<T extends object>(props: T, reads: Set<string>): T {
  const note = (prop: PropertyKey): void => {
    if (typeof prop === 'string') {
      reads.add(prop);
    }
  };
  return new Proxy(props, {
    get(target, prop, receiver) {
      note(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      note(prop);
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      for (const key of keys) {
        note(key);
      }
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      note(prop);
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/** Same tracking as `trackedProps`, for a host fiber's `stateNode` — nothing in `walk.ts` should ever read from it except the internal `{ rect }` shape `env.measure` (a stand-in for the real fiber-to-instance lookup) uses, and `_visibility`/`memoizedState` are read off the fiber itself, never `stateNode`, for Offscreen. */
export function trackedStateNode<T extends object>(stateNode: T, reads: Set<string>): T {
  return trackedProps(stateNode, reads);
}
