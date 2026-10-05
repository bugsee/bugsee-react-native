/**
 * `requests.ts` answers the native SDK's `onDataRequest` -- today only ever
 * `'vh'` -- by walking whatever anchors (`anchor.tsx`'s `wrap`) are currently
 * registered. `buildViewTree` itself is mocked throughout: this file's job is
 * the dispatch around it (which roots it is called with, that a reply always
 * happens exactly once, and when view-tree capture turns on and off), not the
 * walk's own behaviour, which `walk.test.ts` already covers against fake
 * fibers.
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PixelRatio: { get: () => 2 },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);
jest.mock('../walk', () => ({
  __esModule: true,
  buildViewTree: jest.fn(),
}));

import type { native as NativeMock } from '../../__mocks__/native';
import { FiberTag } from '../fiber';
import type { FiberLike } from '../fiber';
import type * as Requests from '../requests';

type WalkModule = { buildViewTree: jest.Mock };

let native: typeof NativeMock;
let requests: typeof Requests;
let buildViewTree: jest.Mock;
let warn: jest.SpyInstance;

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

/** A registered anchor's public instance, sitting under its own fresh `FiberRoot`. */
function anchorUnderNewRoot(): { instance: unknown; root: { current: FiberLike } } {
  const hostRootFiber = makeFiber({ tag: FiberTag.HostRoot });
  const root = { current: hostRootFiber };
  hostRootFiber.stateNode = root;
  const anchorFiber = makeFiber({ return: hostRootFiber });
  return { instance: { __internalInstanceHandle: anchorFiber }, root };
}

/** A second anchor's public instance under the SAME `FiberRoot` as `root`. */
function anchorUnderRoot(root: { current: FiberLike }): unknown {
  const anchorFiber = makeFiber({ return: root.current });
  return { __internalInstanceHandle: anchorFiber };
}

function emit(overrides: Partial<{
  requestId: string;
  type: string;
  originX: number;
  originY: number;
}> = {}): void {
  native.emitDataRequest({
    requestId: 'dr-1',
    type: 'vh',
    originX: 0,
    originY: 0,
    ...overrides,
  });
}

beforeEach(() => {
  jest.resetModules();
  ({ native } = require('../../__mocks__/native'));
  native.reset();
  ({ buildViewTree } = require('../walk') as WalkModule);
  buildViewTree.mockReset();
  buildViewTree.mockReturnValue({ id: '0', class_name: 'ReactNative', bounds: [0, 0, 0, 0], options: { kind: 'root' } });
  requests = require('../requests');
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('VH_DATA_TYPE', () => {
  it("is 'vh'", () => {
    expect(requests.VH_DATA_TYPE).toBe('vh');
  });
});

describe('a vh request', () => {
  it('replies the built tree as JSON', () => {
    const { instance } = anchorUnderNewRoot();
    const tree = { id: '0', class_name: 'ReactNative', bounds: [1, 2, 3, 4], options: { kind: 'root' as const } };
    buildViewTree.mockReturnValue(tree);
    requests.registerAnchor(instance);

    emit({ requestId: 'dr-42' });

    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-42', JSON.stringify(tree));
  });

  it('reaches the walk env with the origin the request carried', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);

    emit({ originX: 11, originY: 22 });

    expect(buildViewTree).toHaveBeenCalledTimes(1);
    const env = buildViewTree.mock.calls[0][1];
    expect(env.originX).toBe(11);
    expect(env.originY).toBe(22);
    // The outer `jest.mock('react-native', ...)` sets Platform.OS to 'ios'.
    expect(env.platform).toBe('ios');
  });
});

// A <Modal> is its own React surface: the walk asks native for the origin of
// a Modal by its host's native tag, once per Modal per walk.
describe('the walk env, per surface', () => {
  const RENDERER_PROXY = 'react-native/Libraries/ReactNative/RendererProxy';

  function envOf(): {
    originForSurface: (surface: number) => { x: number; y: number } | null;
    nativeTagOf: (fiber: FiberLike) => number | null;
  } {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    emit();
    return buildViewTree.mock.calls[0][1];
  }

  afterEach(() => {
    jest.dontMock(RENDERER_PROXY);
  });

  it("resolves a tag's origin through secureSurfaceOrigin", () => {
    native.secureSurfaceOrigin.mockReturnValue([40, 200.5]);

    expect(envOf().originForSurface(77)).toEqual({ x: 40, y: 200.5 });
    expect(native.secureSurfaceOrigin).toHaveBeenCalledWith(77);
  });

  it.each([
    ['empty', []],
    ['one number', [40]],
    ['a NaN x', [Number.NaN, 1]],
    ['an infinite y', [1, Number.POSITIVE_INFINITY]],
    ['not an array', { 0: 1, 1: 2, length: 2 }],
    ['null', null],
  ])('knows no origin when native answers %s', (_name, answer) => {
    native.secureSurfaceOrigin.mockReturnValue(answer as never);

    expect(envOf().originForSurface(77)).toBeNull();
  });

  it('knows no origin when native throws', () => {
    native.secureSurfaceOrigin.mockImplementation(() => {
      throw new Error('no root');
    });

    expect(envOf().originForSurface(77)).toBeNull();
  });

  it("reads a host fiber's tag off its public instance", () => {
    const fiber = makeFiber();
    const seen: unknown[] = [];
    jest.doMock(RENDERER_PROXY, () => ({
      getPublicInstanceFromInternalInstanceHandle: (handle: unknown) => {
        seen.push(handle);
        return { __nativeTag: 77 };
      },
    }));

    expect(envOf().nativeTagOf(fiber)).toBe(77);
    expect(seen).toEqual([fiber]);
  });

  it.each([
    ['no public instance', null],
    ['no tag', {}],
    ['a NaN tag', { __nativeTag: Number.NaN }],
    ['a string tag', { __nativeTag: '77' }],
  ])('has no tag for %s', (_name, instance) => {
    jest.doMock(RENDERER_PROXY, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => instance,
    }));

    expect(envOf().nativeTagOf(makeFiber())).toBeNull();
  });

  it('has no tag when the renderer throws', () => {
    jest.doMock(RENDERER_PROXY, () => ({
      getPublicInstanceFromInternalInstanceHandle: () => {
        throw new Error('unmounted');
      },
    }));

    expect(envOf().nativeTagOf(makeFiber())).toBeNull();
  });
});

describe('a walk that finds nothing', () => {
  // `buildViewTree` returns `null` whenever no surface emits a node: nothing
  // measurable yet, everything under a hidden Offscreen, or every root's
  // `.current` empty. `JSON.stringify(null)` is the four-character STRING
  // `"null"`, not the value `null` -- replying with it would make the SDK
  // store a real (if odd) `managed` payload instead of recognising "nothing
  // to report".
  it('replies null, not the string "null"', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    buildViewTree.mockReturnValue(null);

    emit({ requestId: 'dr-null-tree' });

    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-null-tree', null);
  });

  // Not a contract `buildViewTree` documents, but the payload must survive it
  // regardless -- `undefined` must not reach `replyDataRequest` unconverted
  // either (it crosses a TurboModule boundary far worse than a stray string).
  it('replies null when the walk returns undefined', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    buildViewTree.mockReturnValue(undefined);

    emit({ requestId: 'dr-undefined-tree' });

    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-undefined-tree', null);
  });

  // `JSON.stringify` can also return `undefined` WITHOUT throwing -- for a
  // bare function, symbol, or (here, standing in for either) `undefined`
  // itself at the top level. A non-null, non-undefined `tree` is not really
  // what `buildViewTree` returns, but the payload conversion must not let a
  // non-string `JSON.stringify` result slip through as a payload either.
  it('replies null when JSON.stringify itself returns undefined for a non-null tree', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    buildViewTree.mockReturnValue(() => {});

    emit({ requestId: 'dr-unstringifiable-tree' });

    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-unstringifiable-tree', null);
  });

  // A cyclic structure (or a BigInt) reaching `JSON.stringify` throws rather
  // than returning a string; the reply must still be exactly one, and null.
  it('replies null when JSON.stringify throws on the tree', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    buildViewTree.mockReturnValue(cyclic);

    emit({ requestId: 'dr-cyclic-tree' });

    expect(native.replyDataRequest).toHaveBeenCalledTimes(1);
    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-cyclic-tree', null);
  });
});

describe('a non-vh type', () => {
  it('replies null without walking anything', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);

    emit({ type: 'something-else', requestId: 'dr-2' });

    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-2', null);
    expect(buildViewTree).not.toHaveBeenCalled();
  });
});

describe('no anchor mounted', () => {
  // Native never emits `onDataRequest` before some anchor has registered at
  // least once (that first registration is what subscribes at all), so the
  // realistic version of "no anchor mounted" is "every registered anchor has
  // since unregistered" -- the subscription outlives them.
  it('replies null without walking anything, once every registered anchor has unregistered', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    requests.unregisterAnchor(instance);

    emit({ requestId: 'dr-4' });

    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-4', null);
    expect(buildViewTree).not.toHaveBeenCalled();
  });
});

describe('a throwing walk', () => {
  it('replies null and warns once', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    buildViewTree.mockImplementation(() => {
      throw new Error('walk exploded');
    });

    emit({ requestId: 'dr-5' });

    expect(native.replyDataRequest).toHaveBeenCalledWith('dr-5', null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Bugsee]'), 'Error');
  });

  // "Once" means once per FAILING request, not once ever for the process: a
  // deterministically broken walk should keep saying so on every capture
  // pass, unlike `BugseeSecure`'s own one-time warning for an unrelated,
  // expected-to-be-rare failure.
  it('warns again on a second, separate failing request', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    buildViewTree.mockImplementation(() => {
      throw new Error('walk exploded');
    });

    emit({ requestId: 'dr-5a' });
    emit({ requestId: 'dr-5b' });

    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('a throwing replyDataRequest', () => {
  // The payload is computed entirely before `replyDataRequest` is ever
  // called, and it is called from exactly one place -- so a throwing
  // `replyDataRequest` cannot be retried into throwing a second time (an
  // earlier version of this function called it from inside each branch AND
  // again from the `catch`, so a throw on the success path was retried with
  // the SAME call, escaping if the retry also threw).
  it('is called exactly once, even when it throws', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);
    native.replyDataRequest.mockImplementationOnce(() => {
      throw new Error('bridge is gone');
    });

    expect(() => emit({ requestId: 'dr-reply-throws' })).not.toThrow();

    expect(native.replyDataRequest).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('deliver a view-hierarchy reply'),
      'Error',
    );
  });
});

describe('every request', () => {
  it('is replied to exactly once, whatever happens while answering it', () => {
    const { instance } = anchorUnderNewRoot();
    requests.registerAnchor(instance);

    emit({ requestId: 'ok' });
    expect(native.replyDataRequest).toHaveBeenCalledTimes(1);

    emit({ requestId: 'bad-type', type: 'nope' });
    expect(native.replyDataRequest).toHaveBeenCalledTimes(2);

    buildViewTree.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    emit({ requestId: 'throws' });
    expect(native.replyDataRequest).toHaveBeenCalledTimes(3);

    requests.unregisterAnchor(instance);
    emit({ requestId: 'no-roots' });
    expect(native.replyDataRequest).toHaveBeenCalledTimes(4);
  });
});

describe('registerAnchor / unregisterAnchor', () => {
  it('enables view-tree capture on the first anchor and disables it on the last', () => {
    const a = {};
    const b = {};

    requests.registerAnchor(a);
    expect(native.setViewTreeEnabled).toHaveBeenCalledTimes(1);
    expect(native.setViewTreeEnabled).toHaveBeenLastCalledWith(true);

    requests.registerAnchor(b);
    expect(native.setViewTreeEnabled).toHaveBeenCalledTimes(1);

    requests.unregisterAnchor(a);
    expect(native.setViewTreeEnabled).toHaveBeenCalledTimes(1);

    requests.unregisterAnchor(b);
    expect(native.setViewTreeEnabled).toHaveBeenCalledTimes(2);
    expect(native.setViewTreeEnabled).toHaveBeenLastCalledWith(false);
  });

  // Registering the SAME instance twice does not raise the Set's size a
  // second time (0 -> 1, then 1 -> 1): only the very first registration is a
  // real "0 to 1" transition, so only it may enable capture.
  it('registering the same anchor instance twice enables capture only once', () => {
    const a = {};

    requests.registerAnchor(a);
    requests.registerAnchor(a);

    expect(native.setViewTreeEnabled).toHaveBeenCalledTimes(1);
  });

  // The mirror case: unregistering an instance that is already gone (or was
  // never registered) does not raise a second "1 to 0" transition.
  it('unregistering an anchor that is already gone does not disable capture again', () => {
    const a = {};
    requests.registerAnchor(a);
    requests.unregisterAnchor(a);
    native.setViewTreeEnabled.mockClear();

    requests.unregisterAnchor(a);

    expect(native.setViewTreeEnabled).not.toHaveBeenCalled();
  });

  // The exact sequence a review round flagged: a stale, redundant unregister
  // for an anchor that is ALREADY gone must not disable capture while a
  // DIFFERENT anchor is still mounted.
  it('a stale double-unregister does not disable capture while another anchor is mounted', () => {
    const a = {};
    const b = {};
    requests.registerAnchor(a);
    requests.registerAnchor(b);
    requests.unregisterAnchor(a);
    native.setViewTreeEnabled.mockClear();

    requests.unregisterAnchor(a);

    expect(native.setViewTreeEnabled).not.toHaveBeenCalled();
  });

  it('subscribes to onDataRequest once, no matter how many anchors register', () => {
    const a = {};
    const b = {};
    const c = {};

    requests.registerAnchor(a);
    requests.registerAnchor(b);
    requests.unregisterAnchor(a);
    requests.registerAnchor(c);
    requests.unregisterAnchor(b);
    requests.unregisterAnchor(c);
    requests.registerAnchor(a);

    expect(native.dataRequestSubscribeCallCount()).toBe(1);
  });
});

describe('monotonicNow', () => {
  const originalPerformance = (globalThis as { performance?: unknown }).performance;

  afterEach(() => {
    (globalThis as { performance?: unknown }).performance = originalPerformance;
  });

  // A fake clock, not the real one: `performance.now()`'s exact value is
  // never itself the contract -- only "did it get used, and is the fallback
  // robust to it misbehaving" is.
  function fakeClock(now: () => number): void {
    (globalThis as { performance?: { now: () => number } }).performance = { now };
  }

  it('uses performance.now() when it returns a finite number', () => {
    fakeClock(() => 123.5);

    expect(requests.monotonicNow()).toBe(123.5);
  });

  // The real gap a review round found: `walk.ts`'s `safeNow` coerces a
  // non-finite `now()` result to 0, and if BOTH of a walk's two `now()` calls
  // (its start time and every later budget check) coerced to that same 0, the
  // 250 ms walk budget would never trip -- silently disabling the one bound
  // keeping a pathological tree's walk inside the SDK's capture deadline.
  // `monotonicNow` itself must not let a bad `performance.now()` reach
  // `safeNow` at all.
  it('falls back to Date.now() when performance.now() returns NaN', () => {
    fakeClock(() => NaN);
    const before = Date.now();

    const result = requests.monotonicNow();

    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(before);
  });

  it('falls back to Date.now() when performance.now() returns a non-number', () => {
    fakeClock(() => undefined as unknown as number);
    const before = Date.now();

    const result = requests.monotonicNow();

    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(before);
  });

  it('falls back to Date.now() when performance.now is not a function', () => {
    (globalThis as { performance?: unknown }).performance = { now: 'not a function' };
    const before = Date.now();

    const result = requests.monotonicNow();

    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(before);
  });

  it('falls back to Date.now() when the performance global is missing', () => {
    delete (globalThis as { performance?: unknown }).performance;
    const before = Date.now();

    const result = requests.monotonicNow();

    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(before);
  });
});

describe('two anchors in one surface', () => {
  it('walk that root once', () => {
    const { instance: first, root } = anchorUnderNewRoot();
    const second = anchorUnderRoot(root);
    requests.registerAnchor(first);
    requests.registerAnchor(second);

    emit();

    expect(buildViewTree).toHaveBeenCalledTimes(1);
    const roots = buildViewTree.mock.calls[0][0];
    expect(roots).toEqual([root]);
  });

  // An anchor instance whose fiber root cannot be found (a malformed handle,
  // or one that never reached a HostRoot) is skipped, not passed through as a
  // `null` entry that would otherwise sit alongside the real root.
  it('skips a registered anchor whose fiber root cannot be found', () => {
    const { instance: good, root } = anchorUnderNewRoot();
    const bad = {};
    requests.registerAnchor(good);
    requests.registerAnchor(bad);

    emit();

    expect(buildViewTree).toHaveBeenCalledTimes(1);
    expect(buildViewTree.mock.calls[0][0]).toEqual([root]);
  });
});

/**
 * `buildViewTree` is real here (unmocked), so these exercise what `requests.ts`
 * itself assembles into `WalkEnv` -- `isWrapper`, `isSecureBoundary`,
 * `monotonicNow` and the platform/scale it reads off `react-native` -- rather
 * than merely asserting it was passed *some* object. `walk.ts`'s own
 * behaviour beyond that (depth limits, truncation, naming) stays covered by
 * `walk.test.ts`.
 */
describe('the real walk env', () => {
  const RENDERER_PROXY_PATH = 'react-native/Libraries/ReactNative/RendererProxy';

  function findFiber(root: FiberLike, predicate: (fiber: FiberLike) => boolean): FiberLike {
    const stack: FiberLike[] = [root];
    while (stack.length > 0) {
      const fiber = stack.pop() as FiberLike;
      if (predicate(fiber)) {
        return fiber;
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    throw new Error('fiber not found');
  }

  function mockMeasuring(): void {
    jest.doMock(RENDERER_PROXY_PATH, () => ({
      getPublicInstanceFromInternalInstanceHandle: (fiber: FiberLike) => ({
        __nativeTag: (fiber.stateNode as { tag?: number } | null)?.tag,
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
          const rect = (fiber.stateNode as { rect?: { x: number; y: number; width: number; height: number } } | null)?.rect;
          if (rect) {
            callback(rect.x, rect.y, rect.width, rect.height);
          }
        },
      }),
    }));
  }

  afterEach(() => {
    jest.dontMock(RENDERER_PROXY_PATH);
    // `jest.unmock('../walk')` inside `runRealWalk` persists past its own
    // test; every OTHER describe block's `beforeEach` re-requires '../walk'
    // expecting the module-level mock, so it must be back in place before the
    // next test in the file runs.
    jest.doMock('../walk', () => ({ __esModule: true, buildViewTree: jest.fn() }));
  });

  interface Node {
    class_name: string;
    bounds: number[];
    options: Record<string, unknown>;
    subitems?: Node[];
  }

  /** Builds `HostRoot -> WrapMarker -> [appHost, BugseeSecure -> secureHost, anchor]` and registers a real anchor instance for it, returning the parsed 'vh' reply payload. */
  function runRealWalk(
    platform: 'ios' | 'android',
    origin: { x: number; y: number } = { x: 0, y: 0 },
    arrange: () => void = () => undefined,
    inModal = false,
  ): Node {
    jest.unmock('../walk');
    jest.resetModules();
    ({ native } = require('../../__mocks__/native'));
    native.reset();
    arrange();
    jest.doMock('react-native', () => ({
      Platform: { OS: platform },
      PixelRatio: { get: () => 3 },
    }));
    mockMeasuring();
    requests = require('../requests');
    const { BugseeSecure } = require('../../secure/BugseeSecure') as { BugseeSecure: unknown };
    const { VH_ANCHOR_NATIVE_ID } = require('../anchor') as { VH_ANCHOR_NATIVE_ID: string };

    function WrapMarker(): null {
      return null;
    }

    const appHost = makeFiber({
      type: 'RootView',
      memoizedProps: { testID: 'app-root' },
      stateNode: { rect: { x: 1, y: 2, width: 10, height: 20 } },
    });
    // Unmeasurable, like a real Modal host on Android: its children are
    // promoted, carrying the Modal's origin.
    const modalHost = makeFiber({ type: 'RCTModalHostView', stateNode: { tag: 56 }, child: appHost });
    const secureHost = makeFiber({
      type: 'SecretView',
      memoizedProps: { testID: 'nope' },
      stateNode: { rect: { x: 0, y: 0, width: 5, height: 5 } },
    });
    const secureBoundary = makeFiber({ tag: FiberTag.FunctionComponent, type: BugseeSecure, child: secureHost });
    secureHost.return = secureBoundary;

    // A second secure boundary, reached only through `elementType` -- not a
    // shape any real `<BugseeSecure>` fiber takes today (see
    // `isSecureBoundary`'s own doc comment: it is free insurance against a
    // Fast-Refresh-family/`lazy` resolution, not against `memo`/`forwardRef`),
    // but `isSecureBoundary` checks `.elementType` defensively regardless, and
    // this is what actually exercises that half of the `||`.
    const secureHostViaElementType = makeFiber({
      type: 'SecretView2',
      memoizedProps: { testID: 'also-nope' },
      stateNode: { rect: { x: 50, y: 50, width: 5, height: 5 } },
    });
    function NotBugseeSecure(): null {
      return null;
    }
    const secureBoundaryViaElementType = makeFiber({
      tag: FiberTag.FunctionComponent,
      type: NotBugseeSecure,
      elementType: BugseeSecure,
      child: secureHostViaElementType,
    });
    secureHostViaElementType.return = secureBoundaryViaElementType;

    // Measurable, unlike a real anchor's actual `<View>` (which has no
    // content of its own to measure) -- so that if `isWrapper` ever failed to
    // recognise it, it would show up as a real, visible node instead of
    // vanishing either way.
    const anchor = makeFiber({
      type: 'AnchorView',
      memoizedProps: { nativeID: VH_ANCHOR_NATIVE_ID },
      stateNode: { rect: { x: 99, y: 99, width: 1, height: 1 } },
    });

    appHost.sibling = secureBoundary;
    secureBoundary.sibling = secureBoundaryViaElementType;
    secureBoundaryViaElementType.sibling = anchor;

    const firstChild = inModal ? modalHost : appHost;
    if (inModal) {
      modalHost.sibling = appHost.sibling;
      appHost.sibling = null;
      appHost.return = modalHost;
    }
    const wrapFiber = makeFiber({ tag: FiberTag.FunctionComponent, type: WrapMarker, child: firstChild });
    firstChild.return = wrapFiber;
    secureBoundary.return = wrapFiber;
    secureBoundaryViaElementType.return = wrapFiber;
    anchor.return = wrapFiber;

    const hostRootFiber = makeFiber({ tag: FiberTag.HostRoot, child: wrapFiber });
    wrapFiber.return = hostRootFiber;
    const root = { current: hostRootFiber };
    hostRootFiber.stateNode = root;

    const anchorInFiberTree = findFiber(hostRootFiber, (f) => f === anchor);
    requests.markWrapComponent(WrapMarker);
    requests.registerAnchor({ __internalInstanceHandle: anchorInFiberTree });

    native.emitDataRequest({ requestId: 'dr-real', type: 'vh', originX: origin.x, originY: origin.y });

    const call = (native.replyDataRequest as jest.Mock).mock.calls[0] as [string, string | null];
    expect(call[0]).toBe('dr-real');
    expect(call[1]).not.toBeNull();
    return JSON.parse(call[1] as string) as Node;
  }

  /** Every node anywhere in the tree, flattened. */
  function flatten(node: Node): Node[] {
    return [node, ...(node.subitems ?? []).flatMap(flatten)];
  }

  it('excludes the wrap fiber and its anchor, and redacts under BugseeSecure, on iOS (1:1 points)', () => {
    const tree = runRealWalk('ios');
    const nodes = flatten(tree);

    expect(nodes.some((n) => n.class_name === 'WrapMarker')).toBe(false);
    // The anchor is measurable (unlike a real one) precisely so this proves
    // isWrapper actually excluded it, rather than it merely having nothing to
    // measure either way.
    expect(nodes.some((n) => n.class_name === 'AnchorView')).toBe(false);
    expect(nodes.some((n) => n.options.native_id !== undefined)).toBe(false);

    const appNode = nodes.find((n) => n.class_name === 'RootView');
    expect(appNode?.options.tag).toBe('app-root');
    expect(appNode?.options.secure).toBeUndefined();
    expect(appNode?.bounds).toEqual([1, 2, 10, 20]);

    const secureNode = nodes.find((n) => n.class_name === 'BugseeSecure');
    expect(secureNode?.options.secure).toBe(true);
    expect(secureNode?.options.tag).toBeUndefined();

    const secureHostNode = nodes.find((n) => n.class_name === 'SecretView');
    expect(secureHostNode?.options.secure).toBe(true);
    expect(secureHostNode?.options.tag).toBeUndefined();

    // The elementType-only boundary redacts its subtree exactly the same way.
    const secureViaElementTypeHost = nodes.find((n) => n.class_name === 'SecretView2');
    expect(secureViaElementTypeHost?.options.secure).toBe(true);
    expect(secureViaElementTypeHost?.options.tag).toBeUndefined();
  });

  it('scales bounds by PixelRatio on Android and adds the origin unscaled, in display px', () => {
    const tree = runRealWalk('android', { x: 100, y: 200 });
    const appNode = flatten(tree).find((n) => n.class_name === 'RootView');

    // rect was {x:1,y:2,width:10,height:20}; PixelRatio 3 on Android; then
    // origin (100, 200) is added AFTER scaling, per androidBounds (walk.ts) --
    // it is already in display px, not a point value that itself needs 3x.
    expect(appNode?.bounds).toEqual([103, 206, 30, 60]);
  });

  it("places a node inside a Modal by the Modal's origin, asking once", () => {
    const tree = runRealWalk(
      'android',
      { x: 100, y: 200 },
      () => {
        native.secureSurfaceOrigin.mockImplementation((tag: number) => (tag === 56 ? [40, 60] : []));
      },
      true,
    );
    const appNode = flatten(tree).find((n) => n.class_name === 'RootView');

    // Scaled by 3 as above, then moved by (40, 60), not the request's (100, 200).
    expect(appNode?.bounds).toEqual([43, 66, 30, 60]);
    expect(native.secureSurfaceOrigin.mock.calls).toEqual([[56]]);
  });

  it('asks native nothing for a tree without a Modal', () => {
    runRealWalk('android', { x: 100, y: 200 });

    expect(native.secureSurfaceOrigin).not.toHaveBeenCalled();
  });
});
