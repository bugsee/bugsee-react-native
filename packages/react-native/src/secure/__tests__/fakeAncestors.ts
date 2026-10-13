/**
 * Fake fiber trees for the secure view's ancestry (`ancestry.ts`), built
 * with the view tree's `buildFiberTree`. A host's committed props live on
 * `stateNode.canonical.currentProps`, which a Fabric host shares with its
 * alternate; `memoizedProps` is what the stored fiber itself holds, and may
 * be stale. `stateNode.rect` is what the host measures to in the window
 * (`null`: it never answers).
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

export const composite = (children: FiberSpec[]): FiberSpec => ({
  tag: FiberTag.FunctionComponent,
  type: () => null,
  children,
});

export const self = (): FiberSpec => ({ tag: FiberTag.HostComponent, type: SELF, stateNode: { canonical: {} } });

export const root = (children: FiberSpec[]): FiberSpec => ({ tag: FiberTag.HostRoot, type: null, children });

/** The `SELF` host in the tree `spec` builds. */
export function selfIn(spec: FiberSpec): FiberLike {
  const pending: FiberLike[] = [buildFiberTree(spec)];
  while (pending.length > 0) {
    const fiber = pending.pop() as FiberLike;
    if (fiber.type === SELF) {
      return fiber;
    }
    for (let child = fiber.child; child !== null; child = child.sibling) {
      pending.push(child);
    }
  }
  throw new Error('no SELF host in the tree');
}

/** The nearest ancestor of `fiber` of host type `type`. */
export function ancestorOfType(fiber: FiberLike, type: string): FiberLike {
  for (let current = fiber.return; current !== null; current = current.return) {
    if (current.type === type) {
      return current;
    }
  }
  throw new Error(`no ${type} above the fiber`);
}

/** Replaces a host's committed props, as a commit that changed them would. */
export function commitProps(fiber: FiberLike, props: Record<string, unknown>): void {
  (fiber.stateNode as { canonical: { currentProps: unknown } }).canonical.currentProps = props;
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
  const renderer: FakeRenderer = {
    lookups: [],
    measures: [],
    getPublicInstanceFromInternalInstanceHandle: (fiber) => {
      renderer.lookups.push(fiber);
      return {
        __nativeTag: (fiber.stateNode as { tag?: unknown } | null)?.tag,
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
          renderer.measures.push(fiber);
          const measured = (fiber.stateNode as { rect: WindowRect | null }).rect;
          if (measured !== null) {
            callback(measured.x, measured.y, measured.width, measured.height);
          }
        },
      };
    },
  };
  return renderer;
}
