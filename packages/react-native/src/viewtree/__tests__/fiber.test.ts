/**
 * `fiber.ts` is the only module allowed to touch React/React Native
 * internals. `measureHostFiber` requires `RendererProxy` lazily — React
 * Native ships that module as untranspiled Flow/ESM source, which throws a
 * SyntaxError under plain Jest — so every test of it mocks the module with
 * `jest.doMock` before calling the function; `fiberRootOf` never touches that
 * module at all and needs no mocking.
 */
import { FiberTag, fiberRootOf, measureHostFiber } from '../fiber';
import type { FiberLike } from '../fiber';

const RENDERER_PROXY_PATH = 'react-native/Libraries/ReactNative/RendererProxy';

function makeFiber(overrides: Partial<FiberLike> = {}): FiberLike {
  return {
    tag: FiberTag.HostComponent,
    type: 'View',
    child: null,
    sibling: null,
    return: null,
    memoizedProps: {},
    memoizedState: null,
    stateNode: null,
    ...overrides,
  };
}

describe('fiberRootOf', () => {
  it("walks __internalInstanceHandle up to the HostRoot's FiberRoot", () => {
    const hostRootFiber = makeFiber({ tag: FiberTag.HostRoot });
    const fiberRootObject = { current: hostRootFiber };
    hostRootFiber.stateNode = fiberRootObject;

    const mid = makeFiber({ tag: FiberTag.FunctionComponent, return: hostRootFiber });
    const leaf = makeFiber({ tag: FiberTag.HostComponent, return: mid });

    expect(fiberRootOf({ __internalInstanceHandle: leaf })).toBe(fiberRootObject);
  });

  it('is null without __internalInstanceHandle', () => {
    expect(fiberRootOf({})).toBeNull();
    expect(fiberRootOf(null)).toBeNull();
    expect(fiberRootOf(undefined)).toBeNull();
    expect(fiberRootOf(42)).toBeNull();
    expect(fiberRootOf({ __internalInstanceHandle: null })).toBeNull();
    expect(fiberRootOf({ __internalInstanceHandle: 42 })).toBeNull();
  });

  it('is null when the chain never reaches a HostRoot', () => {
    const orphan = makeFiber({ tag: FiberTag.FunctionComponent, return: null });
    const mid = makeFiber({ tag: FiberTag.HostComponent, return: orphan });
    expect(fiberRootOf({ __internalInstanceHandle: mid })).toBeNull();
  });

  it('is null when the HostRoot fiber carries no usable stateNode', () => {
    const hostRootFiber = makeFiber({ tag: FiberTag.HostRoot, stateNode: null });
    expect(fiberRootOf({ __internalInstanceHandle: hostRootFiber })).toBeNull();

    const hostRootFiber2 = makeFiber({ tag: FiberTag.HostRoot, stateNode: {} });
    expect(fiberRootOf({ __internalInstanceHandle: hostRootFiber2 })).toBeNull();

    const hostRootFiber3 = makeFiber({ tag: FiberTag.HostRoot, stateNode: 'not an object' });
    expect(fiberRootOf({ __internalInstanceHandle: hostRootFiber3 })).toBeNull();

    // A stateNode that HAS a `current` key, but it is exactly `null` —
    // distinct from `{}` (no key at all) above.
    const hostRootFiber4 = makeFiber({ tag: FiberTag.HostRoot, stateNode: { current: null } });
    expect(fiberRootOf({ __internalInstanceHandle: hostRootFiber4 })).toBeNull();
  });

  it('is null instead of hanging on a genuine .return cycle', () => {
    const a = makeFiber({ tag: FiberTag.FunctionComponent });
    const b = makeFiber({ tag: FiberTag.FunctionComponent });
    a.return = b;
    b.return = a; // a <-> b, never reaching a HostRoot

    expect(() => fiberRootOf({ __internalInstanceHandle: a })).not.toThrow();
    expect(fiberRootOf({ __internalInstanceHandle: a })).toBeNull();
  });

  it('the .return chain cap allows exactly FIBER_ROOT_RETURN_CHAIN_CAP hops, not one more', () => {
    // Mirrors fiber.ts's own FIBER_ROOT_RETURN_CHAIN_CAP (10,000). A real
    // HostRoot sits exactly one hop past the cap: `steps >= cap` (correct)
    // gives up right before reaching it (null); `steps > cap` (an off-by-one
    // mutant) would take that one extra hop and find it.
    const chainCap = 10_000;

    const hostRootFiber = makeFiber({ tag: FiberTag.HostRoot });
    const fiberRootObject = { current: hostRootFiber };
    hostRootFiber.stateNode = fiberRootObject;

    let handle = hostRootFiber;
    for (let i = 0; i <= chainCap; i += 1) {
      handle = makeFiber({ tag: FiberTag.FunctionComponent, return: handle });
    }

    expect(fiberRootOf({ __internalInstanceHandle: handle })).toBeNull();
  });
});

describe('measureHostFiber', () => {
  const fiber = makeFiber();

  afterEach(() => {
    jest.dontMock(RENDERER_PROXY_PATH);
    jest.resetModules();
  });

  it('returns the rect a synchronous callback delivers', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
          callback(1, 2, 3, 4),
      }),
    }));

    expect(measureHostFiber(fiber)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('is null when the callback does not run synchronously', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({
        measureInWindow: () => {
          // Deliberately never calls back synchronously.
        },
      }),
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });

  it.each([
    [Number.NaN, 2, 3, 4],
    [1, Number.NaN, 3, 4],
    [1, 2, Number.NaN, 4],
    [1, 2, 3, Number.NaN],
    [1, 2, 3, Number.POSITIVE_INFINITY],
  ])('is null when the callback delivers a non-finite number (%p, %p, %p, %p)', (x, y, width, height) => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
          callback(x, y, width, height),
      }),
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });

  it('is null when getPublicInstanceFromInternalInstanceHandle is not a function', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: 'not-a-function',
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });

  it('is null when the public instance has no measureInWindow', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({}),
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });

  it('is null when the public instance is undefined', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => undefined,
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });

  it('is null when measureInWindow itself throws synchronously', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({
        measureInWindow: () => {
          throw new Error('boom');
        },
      }),
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });

  it('is null when the renderer throws', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => {
        throw new Error('boom');
      },
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });

  it('is null when there is no public instance for the handle', () => {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => null,
    }));

    expect(measureHostFiber(fiber)).toBeNull();
  });
});
