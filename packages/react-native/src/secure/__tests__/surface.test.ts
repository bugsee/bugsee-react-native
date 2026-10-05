/**
 * Which React surface a view is measured in, read off the fiber tree. A
 * wrong answer puts a secure rectangle on the wrong origin, so every test
 * here is about the surface a real Modal tree must resolve to.
 */
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike } from '../../viewtree/fiber';
import type * as SurfaceModule from '../surface';
import {
  MAIN_SURFACE,
  MODAL_HOST_TYPE,
  UNKNOWN_MODAL_SURFACE,
  nativeTagOfFiber,
  surfaceOfFiber,
  surfaceOfInstance,
} from '../surface';

const RENDERER_PROXY = 'react-native/Libraries/ReactNative/RendererProxy';

function fiber(tag: number, type: unknown, parent: FiberLike | null = null, nativeTag?: number): FiberLike {
  return {
    tag,
    type,
    child: null,
    sibling: null,
    return: parent,
    memoizedProps: { nativeTag },
    memoizedState: null,
    stateNode: null,
  } as FiberLike;
}

/** Reads the test's tag off `memoizedProps`, in place of the renderer. */
const tagOf = (f: FiberLike): number | null =>
  (f.memoizedProps as { nativeTag?: number }).nativeTag ?? null;

const root = () => fiber(FiberTag.HostRoot, null);
const modal = (parent: FiberLike, nativeTag?: number) =>
  fiber(FiberTag.HostComponent, MODAL_HOST_TYPE, parent, nativeTag);
const view = (parent: FiberLike) => fiber(FiberTag.HostComponent, 'RCTView', parent);

describe('surfaceOfFiber', () => {
  it('is the main surface outside every Modal', () => {
    expect(surfaceOfFiber(view(view(root())), tagOf)).toBe(MAIN_SURFACE);
  });

  it("is the Modal host's tag inside a Modal, through composites and views", () => {
    const composite = fiber(FiberTag.FunctionComponent, () => null, modal(view(root()), 56));
    expect(surfaceOfFiber(view(view(composite)), tagOf)).toBe(56);
  });

  it('is the nearest Modal for a Modal inside a Modal', () => {
    const inner = modal(view(modal(root(), 56)), 78);
    expect(surfaceOfFiber(view(inner), tagOf)).toBe(78);
  });

  // The Modal host itself is laid out in its parent's surface.
  it('does not count the fiber itself', () => {
    expect(surfaceOfFiber(modal(view(root()), 56), tagOf)).toBe(MAIN_SURFACE);
  });

  it('ignores a non-host fiber whose type happens to be the Modal host name', () => {
    const lookalike = fiber(FiberTag.FunctionComponent, MODAL_HOST_TYPE, root(), 56);
    expect(surfaceOfFiber(view(lookalike), tagOf)).toBe(MAIN_SURFACE);
  });

  it('is the unknown-Modal surface when the Modal host has no tag, never the main one', () => {
    expect(surfaceOfFiber(view(modal(root())), tagOf)).toBe(UNKNOWN_MODAL_SURFACE);
    expect(UNKNOWN_MODAL_SURFACE).not.toBe(MAIN_SURFACE);
  });

  it('stops on a cycle instead of spinning', () => {
    const looped = view(root());
    looped.return = looped;
    expect(surfaceOfFiber(view(looped), tagOf)).toBe(MAIN_SURFACE);
  });

  it('reads the tag through the renderer by default', () => {
    jest.resetModules();
    jest.doMock(RENDERER_PROXY, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({ __nativeTag: 91 }),
    }));
    const fresh = require('../surface') as typeof SurfaceModule;
    expect(fresh.surfaceOfFiber(view(modal(root())))).toBe(91);
    jest.dontMock(RENDERER_PROXY);
  });
});

describe('nativeTagOfFiber', () => {
  afterEach(() => {
    jest.dontMock(RENDERER_PROXY);
  });

  function withInstance(instance: unknown | (() => never)): typeof SurfaceModule {
    jest.resetModules();
    jest.doMock(RENDERER_PROXY, () => ({
      getPublicInstanceFromInternalInstanceHandle: () =>
        typeof instance === 'function' ? (instance as () => never)() : instance,
    }));
    return require('../surface') as typeof SurfaceModule;
  }

  it("reads the public instance's tag", () => {
    expect(withInstance({ __nativeTag: 56 }).nativeTagOfFiber(root())).toBe(56);
  });

  it.each([
    ['no instance', null],
    ['no tag', {}],
    ['a NaN tag', { __nativeTag: Number.NaN }],
    ['a string tag', { __nativeTag: '56' }],
  ])('is null for %s', (_name, instance) => {
    expect(withInstance(instance).nativeTagOfFiber(root())).toBeNull();
  });

  it('is null when the renderer throws', () => {
    expect(
      withInstance(() => {
        throw new Error('unmounted');
      }).nativeTagOfFiber(root()),
    ).toBeNull();
  });

  it('is exported for the walk', () => {
    expect(typeof nativeTagOfFiber).toBe('function');
  });
});

describe('surfaceOfInstance', () => {
  it('is the main surface for an instance with no fiber', () => {
    expect(surfaceOfInstance({})).toBe(MAIN_SURFACE);
    expect(surfaceOfInstance({ __internalInstanceHandle: null })).toBe(MAIN_SURFACE);
    expect(surfaceOfInstance({ __internalInstanceHandle: 7 })).toBe(MAIN_SURFACE);
  });

  it("is the surface of the instance's fiber", () => {
    jest.resetModules();
    jest.doMock(RENDERER_PROXY, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({ __nativeTag: 56 }),
    }));
    const fresh = require('../surface') as typeof SurfaceModule;
    expect(fresh.surfaceOfInstance({ __internalInstanceHandle: view(modal(root())) })).toBe(56);
    jest.dontMock(RENDERER_PROXY);
  });
});
