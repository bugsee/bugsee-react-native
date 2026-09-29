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

  // N1 (fix round 2): `fiberRootOf` must never throw, even on input the
  // explicit `isObject`/tag checks cannot see coming — a throwing getter
  // anywhere along the read path, or a revoked `Proxy` standing in for
  // either the public instance itself or the handle it carries. Task 6.4's
  // `registerAnchor(instance: unknown)` calls this on whatever a consumer
  // registers, and turns any throw into a blanked-out `vh` reply for every
  // root, for as long as that one bad object stays registered — so each of
  // these is a `not.toThrow()` alongside the `toBeNull()`.
  describe('never throws, even on hostile input (N1)', () => {
    it('a throwing __internalInstanceHandle getter', () => {
      const publicInstance: unknown = {
        get __internalInstanceHandle(): unknown {
          throw new Error('boom');
        },
      };
      expect(() => fiberRootOf(publicInstance)).not.toThrow();
      expect(fiberRootOf(publicInstance)).toBeNull();
    });

    it('a get trap that throws, on the public instance itself', () => {
      const publicInstance = new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        },
      );
      expect(() => fiberRootOf(publicInstance)).not.toThrow();
      expect(fiberRootOf(publicInstance)).toBeNull();
    });

    it('a get trap that throws, on the handle', () => {
      const handle = new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        },
      );
      expect(() => fiberRootOf({ __internalInstanceHandle: handle })).not.toThrow();
      expect(fiberRootOf({ __internalInstanceHandle: handle })).toBeNull();
    });

    it('a revoked Proxy as the public instance', () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      expect(() => fiberRootOf(proxy)).not.toThrow();
      expect(fiberRootOf(proxy)).toBeNull();
    });

    it('a revoked Proxy as the handle', () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      expect(() => fiberRootOf({ __internalInstanceHandle: proxy })).not.toThrow();
      expect(fiberRootOf({ __internalInstanceHandle: proxy })).toBeNull();
    });

    it('a throwing .tag getter', () => {
      const handle: unknown = {
        get tag(): number {
          throw new Error('boom');
        },
      };
      expect(() => fiberRootOf({ __internalInstanceHandle: handle })).not.toThrow();
      expect(fiberRootOf({ __internalInstanceHandle: handle })).toBeNull();
    });

    it('a throwing .return getter', () => {
      const handle: unknown = {
        tag: FiberTag.FunctionComponent,
        get return(): unknown {
          throw new Error('boom');
        },
      };
      expect(() => fiberRootOf({ __internalInstanceHandle: handle })).not.toThrow();
      expect(fiberRootOf({ __internalInstanceHandle: handle })).toBeNull();
    });

    it('a throwing .stateNode getter on the HostRoot fiber', () => {
      const handle: unknown = {
        tag: FiberTag.HostRoot,
        get stateNode(): unknown {
          throw new Error('boom');
        },
      };
      expect(() => fiberRootOf({ __internalInstanceHandle: handle })).not.toThrow();
      expect(fiberRootOf({ __internalInstanceHandle: handle })).toBeNull();
    });
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

  it('is null (not the delivered rect) when the callback fires with a good rect and measureInWindow then throws (M10, pinned)', () => {
    // Distinct from the case above: here the callback DOES run first,
    // synchronously, with a fully valid rect — and only then does
    // `measureInWindow` itself throw (e.g. some renderer-side bookkeeping
    // after the callback). Without its own `catch`, this specific ordering
    // would let the exception propagate out of `measureHostFiber` instead
    // of yielding a clean `null` — see the doc comment on the second `try`
    // in fiber.ts for why `null`, not the already-delivered rect, is the
    // pinned outcome.
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => ({
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
          callback(1, 2, 3, 4);
          throw new Error('boom after delivering');
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
