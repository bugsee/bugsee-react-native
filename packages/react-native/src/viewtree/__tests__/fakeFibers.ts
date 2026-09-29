/**
 * A builder for fake fiber trees, so `walk.test.ts` can exercise `walk.ts`
 * without React or `react-test-renderer` anywhere in the picture. Shapes
 * mirror what React's own reconciler actually puts on a fiber for each tag
 * (see the comments on `offscreen`), not just what happens to make the tests
 * pass.
 */
import { FiberTag } from '../fiber';
import type { FiberLike, WindowRect } from '../fiber';

export interface FiberSpec {
  tag: number;
  type?: unknown;
  memoizedProps?: unknown;
  stateNode?: unknown;
  children?: FiberSpec[];
}

export function buildFiberTree(spec: FiberSpec): FiberLike {
  const fiber: FiberLike = {
    tag: spec.tag,
    type: spec.type,
    elementType: spec.type,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: spec.memoizedProps ?? {},
    stateNode: spec.stateNode ?? null,
  };

  let previous: FiberLike | null = null;
  for (const childSpec of spec.children ?? []) {
    const child = buildFiberTree(childSpec);
    child.return = fiber;
    if (previous === null) {
      fiber.child = child;
    } else {
      previous.sibling = child;
    }
    previous = child;
  }

  return fiber;
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

export const forwardRefFiber = (render: unknown, children: FiberSpec[] = []): FiberSpec => ({
  tag: FiberTag.ForwardRef,
  type: { render },
  children,
});

export const memoFiber = (inner: unknown, children: FiberSpec[] = []): FiberSpec => ({
  tag: FiberTag.Memo,
  type: { type: inner },
  children,
});

export const fragment = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.Fragment, children });
export const provider = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.ContextProvider, children });
export const consumer = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.ContextConsumer, children });
export const mode = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.Mode, children });
export const portal = (children: FiberSpec[] = []): FiberSpec => ({ tag: FiberTag.HostPortal, children });

/**
 * `_visibility` is the real field React's reconciler puts on an
 * OffscreenComponent fiber's `stateNode` (an `OffscreenInstance`); bit 0
 * (`OffscreenVisible`) is set when the subtree is visible. `walk.ts` reads
 * this instead of any prop, so the fake matches the field it actually reads.
 */
export const offscreen = (visible: boolean, children: FiberSpec[] = []): FiberSpec => ({
  tag: FiberTag.Offscreen,
  stateNode: { _visibility: visible ? 1 : 0 },
  children,
});

/** Wraps `props` in a Proxy that records every key ever read off it into `reads`. */
export function trackedProps<T extends object>(props: T, reads: Set<string>): T {
  return new Proxy(props, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        reads.add(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
