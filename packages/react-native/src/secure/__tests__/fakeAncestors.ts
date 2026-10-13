/**
 * Fake fiber trees for the secure view's ancestry (`ancestry.ts`), built
 * with the view tree's `buildFiberTree`. The tree built is the committed one:
 * its root's `stateNode.current` is itself and its fibers' `memoizedProps`
 * are committed props, also mirrored on `stateNode.canonical.currentProps`
 * as Fabric keeps them. {@link pairWith} adds the other fiber of a pair (a
 * stale or in-flight one) and routes the stored `.return` chain through it.
 * `stateNode.rect` is what the host measures to in the window (`null`: it
 * never answers).
 */
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import { buildFiberTree } from '../../viewtree/__tests__/fakeFibers';
import type { FiberSpec } from '../../viewtree/__tests__/fakeFibers';

/** The host type of the secure view itself. */
export const SELF = 'BugseeSecureView';

export const rect = (x: number, y: number, width: number, height: number): WindowRect => ({ x, y, width, height });

/** A Fabric host whose committed props are `props`, holding `memoizedProps` itself. */
export function fabricHost(
  type: string,
  measured: WindowRect | null,
  props: Record<string, unknown>,
  children: FiberSpec[],
  memoizedProps: unknown = props,
): FiberSpec {
  return {
    tag: FiberTag.HostComponent,
    type,
    memoizedProps,
    stateNode: { rect: measured, canonical: { currentProps: props } },
    children,
  };
}

export const view = (children: FiberSpec[], props: Record<string, unknown> = {}): FiberSpec =>
  fabricHost('RCTView', rect(0, 0, 400, 800), props, children);

export const scrollView = (measured: WindowRect | null, children: FiberSpec[], type = 'RCTScrollView'): FiberSpec =>
  fabricHost(type, measured, {}, [fabricHost('RCTScrollContentView', rect(0, -5000, 400, 9000), {}, children)]);

export const offscreen = (visibility: unknown, children: FiberSpec[]): FiberSpec => ({
  tag: FiberTag.Offscreen,
  type: undefined,
  memoizedState: null,
  stateNode: { _visibility: visibility },
  children,
});

export const composite = (children: FiberSpec[], props: Record<string, unknown> = {}): FiberSpec => ({
  tag: FiberTag.FunctionComponent,
  type: () => null,
  memoizedProps: props,
  children,
});

/** A react-native-screens container, which detaches its inactive screens. */
export const screenContainer = (children: FiberSpec[], type = 'RNSScreenContainer'): FiberSpec =>
  fabricHost(type, null, {}, children);

export const self = (): FiberSpec => ({ tag: FiberTag.HostComponent, type: SELF, stateNode: { canonical: {} } });

export const root = (children: FiberSpec[]): FiberSpec => ({ tag: FiberTag.HostRoot, type: null, children });

/** Every `SELF` host in the tree `spec` builds, in no particular order. */
export function selvesIn(spec: FiberSpec): FiberLike[] {
  const found: FiberLike[] = [];
  const top = buildFiberTree(spec);
  if (top.tag === FiberTag.HostRoot && top.stateNode === null) {
    top.stateNode = { current: top };
  }
  const pending: FiberLike[] = [top];
  while (pending.length > 0) {
    const fiber = pending.pop() as FiberLike;
    if (fiber.type === SELF) {
      found.push(fiber);
    }
    for (let child = fiber.child; child !== null; child = child.sibling) {
      pending.push(child);
    }
  }
  return found;
}

/** The `SELF` host in the tree `spec` builds. */
export function selfIn(spec: FiberSpec): FiberLike {
  const [fiber] = selvesIn(spec);
  if (fiber === undefined) {
    throw new Error('no SELF host in the tree');
  }
  return fiber;
}

/** The nearest ancestor of `fiber` of type `type`, along its stored `.return` chain. */
export function ancestorOfType(fiber: FiberLike, type: unknown): FiberLike {
  for (let current = fiber.return; current !== null; current = current.return) {
    if (current.type === type) {
      return current;
    }
  }
  throw new Error(`no ${String(type)} above the fiber`);
}

/** Replaces a committed host's props, as a commit that changed them would. */
export function commitProps(fiber: FiberLike, props: unknown): void {
  fiber.memoizedProps = props;
  (fiber.stateNode as { canonical: { currentProps: unknown } }).canonical.currentProps = props;
}

/**
 * Gives the committed `fiber` its other fiber, holding `props`, and points
 * `fiber`'s children's `.return` at that other fiber, so a chain stored from
 * below runs through it. `rendered`: it is a render in flight (or abandoned)
 * rather than a stale leftover, and has written its props to the shared
 * `canonical`, as `completeWork` does.
 */
export function pairWith(fiber: FiberLike, props: unknown, rendered = false): FiberLike {
  const other: FiberLike = { ...fiber, memoizedProps: props, alternate: fiber };
  fiber.alternate = other;
  for (let child = fiber.child; child !== null; child = child.sibling) {
    child.return = other;
  }
  if (rendered) {
    (fiber.stateNode as { canonical: { currentProps: unknown } }).canonical.currentProps = props;
  }
  return other;
}

/** Moves a host to `measured`, as a scroll or layout would. */
export function moveTo(fiber: FiberLike, measured: WindowRect | null): void {
  (fiber.stateNode as { rect: WindowRect | null }).rect = measured;
}

/** Counts what the fake renderer is asked, so a test can see measuring. */
export interface FakeRenderer {
  lookups: FiberLike[];
  measures: FiberLike[];
  getPublicInstanceFromInternalInstanceHandle: (fiber: FiberLike) => unknown;
}

/** A RendererProxy stand-in: a host's public instance measures to its `stateNode.rect`. */
export function fakeRenderer(): FakeRenderer {
  const instances = new Map<FiberLike, object>();
  const renderer: FakeRenderer = {
    lookups: [],
    measures: [],
    getPublicInstanceFromInternalInstanceHandle: (fiber) => {
      renderer.lookups.push(fiber);
      // One public instance per host, as the renderer keeps it on canonical.
      let instance = instances.get(fiber);
      if (instance === undefined) {
        instance = {
          __nativeTag: (fiber.stateNode as { tag?: unknown } | null)?.tag,
          measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
            renderer.measures.push(fiber);
            const measured = (fiber.stateNode as { rect: WindowRect | null }).rect;
            if (measured !== null) {
              callback(measured.x, measured.y, measured.width, measured.height);
            }
          },
        };
        instances.set(fiber, instance);
      }
      return instance;
    },
  };
  return renderer;
}
