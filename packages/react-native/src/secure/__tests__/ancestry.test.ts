/**
 * What the ancestors of a `<BugseeSecure>` say about how much of it is on
 * screen. The failures guarded against go both ways: a region left over
 * something it no longer covers (a tab bar, another tab), and a region
 * withdrawn or cut while the view is still showing. Every doubt resolves to
 * the second never happening.
 */
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike } from '../../viewtree/fiber';
import {
  ROOT_KIND_HOST_TYPES,
  SCREEN_HOST_TYPE,
  SCROLL_HOST_TYPES,
  ancestryOfFiber,
  ancestryOfInstance,
  clipToAncestors,
  isHidden,
  measurePass,
  noAncestry,
  styleValue,
} from '../ancestry';
import type { Ancestry } from '../ancestry';
import {
  ancestorOfType,
  commitProps,
  composite,
  fabricHost,
  fakeRenderer,
  moveTo,
  offscreen,
  pairWith,
  rect,
  root,
  scrollView,
  self,
  selfIn,
  selvesIn,
  view,
} from './fakeAncestors';
import type { FakeRenderer } from './fakeAncestors';

const RENDERER_PROXY = 'react-native/Libraries/ReactNative/RendererProxy';

let renderer: FakeRenderer;

beforeEach(() => {
  renderer = fakeRenderer();
  // A fresh registry each test, so the lazy require sees this test's mock.
  jest.resetModules();
  jest.doMock(RENDERER_PROXY, () => ({
    getPublicInstanceFromInternalInstanceHandle: (fiber: FiberLike) =>
      renderer.getPublicInstanceFromInternalInstanceHandle(fiber),
  }));
});

afterEach(() => {
  jest.dontMock(RENDERER_PROXY);
});

/** The ancestry of the `SELF` host in `spec`'s tree. */
const ancestryIn = (spec: Parameters<typeof selfIn>[0]): Ancestry => ancestryOfFiber(selfIn(spec));

const types = (ancestry: Ancestry): unknown[] => ancestry.hosts.map((host) => ancestry.path[host.index]!.type);

/** A secure view under an RNSScreen with committed `activityState`, inside a wrapper with `wrapperProps`. */
function underScreen(activityState: unknown, wrapperProps: Record<string, unknown> = {}): FiberLike {
  return selfIn(
    root([composite([fabricHost(SCREEN_HOST_TYPE, null, { activityState }, [view([self()])])], wrapperProps)]),
  );
}

/** An RNSScreen whose committed `activityState` is 0, over `children`. */
const inactive = (children: Parameters<typeof fabricHost>[3]) =>
  fabricHost(SCREEN_HOST_TYPE, null, { activityState: 0 }, children);

describe('ancestryOfFiber', () => {
  it('keeps the whole path to the root, and the hosts on it nearest first', () => {
    const fiber = selfIn(root([view([composite([scrollView(rect(0, 0, 1, 1), [self()])])])]));
    const ancestry = ancestryOfFiber(fiber);

    expect(ancestry.path.map((entry) => entry.tag)).toEqual([
      FiberTag.HostComponent,
      FiberTag.HostComponent,
      FiberTag.FunctionComponent,
      FiberTag.HostComponent,
      FiberTag.HostRoot,
    ]);
    expect(ancestry.path[0]).toBe(fiber.return);
    expect(types(ancestry)).toEqual(['RCTScrollContentView', 'RCTScrollView', 'RCTView']);
    expect(ancestry.hosts.map((host) => [host.index, host.above])).toEqual([
      [0, 1],
      [1, 3],
      [3, 5],
    ]);
    expect(ancestry.root).toBe(ancestry.path[4]!.stateNode);
    expect(ancestry.readable).toBe(false);
  });

  it('has no root when the path does not end at one', () => {
    const top = { tag: FiberTag.HostComponent, type: 'RCTView', return: null, stateNode: { current: 1 } } as FiberLike;
    const fiber = { tag: FiberTag.HostComponent, type: 'SELF', return: top } as FiberLike;

    expect(ancestryOfFiber(fiber).root).toBeNull();
    expect(ancestryOfFiber({ ...fiber, return: null }).root).toBeNull();
  });

  it.each([...ROOT_KIND_HOST_TYPES])('leaves out %s and every host above it', (type) => {
    const boundary = fabricHost(type as string, rect(0, 0, 1, 1), {}, [view([self()])]);
    const ancestry = ancestryIn(root([scrollView(null, [boundary])]));

    expect(types(ancestry)).toEqual(['RCTView']);
    // The view below it ends at the boundary, not at the next host above.
    expect(ancestry.hosts[0]!.above).toBe(1);
    expect(ancestry.path).toHaveLength(5);
  });

  it('knows the root-kind hosts of React Native and react-native-screens', () => {
    expect([...ROOT_KIND_HOST_TYPES]).toEqual([
      'RCTModalHostView',
      'RCTInputAccessoryView',
      'RNSFullWindowOverlay',
      'RNSModalScreen',
      'RNSSplitScreen',
    ]);
  });

  it('knows the react-native-screens screen host', () => {
    expect(SCREEN_HOST_TYPE).toBe('RNSScreen');
  });

  it('marks the ScrollView hosts of both platforms, and the screens', () => {
    expect([...SCROLL_HOST_TYPES]).toEqual(['RCTScrollView', 'AndroidHorizontalScrollView']);
    const ancestry = ancestryIn(
      root([
        fabricHost(SCREEN_HOST_TYPE, null, {}, [
          scrollView(null, [scrollView(null, [self()], 'AndroidHorizontalScrollView')]),
        ]),
      ]),
    );

    expect(ancestry.hosts.map((host) => [ancestry.path[host.index]!.type, host.scrolls, host.screen])).toEqual([
      ['RCTScrollContentView', false, false],
      ['AndroidHorizontalScrollView', true, false],
      ['RCTScrollContentView', false, false],
      ['RCTScrollView', true, false],
      [SCREEN_HOST_TYPE, false, true],
    ]);
  });

  it('starts every host unread and unmeasured', () => {
    const [host] = ancestryIn(root([view([self()])])).hosts;

    expect(host).toMatchObject({ inactive: false, clips: false, instance: undefined });
    expect(typeof host?.props).toBe('symbol');
  });

  it('ends a cyclic chain', () => {
    const loop = { tag: FiberTag.HostComponent, type: 'RCTView', stateNode: null } as FiberLike;
    loop.return = loop;
    const fiber = { tag: FiberTag.HostComponent, type: 'SELF', return: loop } as FiberLike;
    const ancestry = ancestryOfFiber(fiber);

    expect(ancestry.path).toHaveLength(10_000);
    expect(ancestry.hosts).toHaveLength(10_000);
    expect(ancestry.hosts[9_999]!.above).toBe(10_000);
  });
});

describe('ancestryOfInstance', () => {
  it("reads the instance's fiber", () => {
    const fiber = selfIn(root([view([self()])]));

    expect(types(ancestryOfInstance({ __internalInstanceHandle: fiber }))).toEqual(['RCTView']);
  });

  it.each([
    ['no fiber', {}],
    ['a null fiber', { __internalInstanceHandle: null }],
    ['a fiber that is not an object', { __internalInstanceHandle: 7 }],
  ])('has no ancestors with %s', (_, instance) => {
    expect(ancestryOfInstance(instance)).toEqual(noAncestry());
  });

  it('has no ancestors when the tree throws while it is read', () => {
    const fiber = { tag: FiberTag.HostComponent, type: 'SELF' };
    Object.defineProperty(fiber, 'return', {
      get(): never {
        throw new Error('torn fiber');
      },
    });

    expect(ancestryOfInstance({ __internalInstanceHandle: fiber })).toEqual(noAncestry());
  });

  it('noAncestry hides nothing and clips nothing', () => {
    const none = noAncestry();

    expect(none).toEqual({ path: [], root: null, hosts: [], readable: false });
    expect(isHidden(none)).toBe(false);
    expect(clipToAncestors(rect(1, 2, 3, 4), none)).toEqual(rect(1, 2, 3, 4));
    expect(noAncestry()).not.toBe(none);
  });
});

describe('styleValue', () => {
  it.each([
    ['an object', { overflow: 'hidden' }, 'hidden'],
    ['an object without the key', { opacity: 1 }, undefined],
    ['the last entry that sets it', [{ overflow: 'hidden' }, { overflow: 'visible' }], 'visible'],
    ['an earlier entry when later ones do not set it', [{ overflow: 'hidden' }, { opacity: 1 }, null, false], 'hidden'],
    ['nested arrays', [{ overflow: 'visible' }, [[{ overflow: 'hidden' }], undefined]], 'hidden'],
    ['an empty array', [], undefined],
    ['null', null, undefined],
    ['a registered style id', 12, undefined],
    ['a string', 'hidden', undefined],
  ])('reads %s', (_, style, expected) => {
    expect(styleValue(style, 'overflow')).toBe(expected);
  });
});

describe('isHidden', () => {
  it('is false with nothing hiding, and reads the tree', () => {
    const ancestry = ancestryIn(root([view([view([self()])])]));

    expect(isHidden(ancestry)).toBe(false);
    expect(ancestry.readable).toBe(true);
  });

  it.each([
    [0, true],
    [1, false],
    [2, false],
    [-1, false],
    ['0', false],
    [undefined, false],
  ])('a screen with committed activityState %p hides: %p', (activityState, hidden) => {
    expect(isHidden(ancestryOfFiber(underScreen(activityState)))).toBe(hidden);
  });

  it('activityState 0 on any other host hides nothing', () => {
    expect(isHidden(ancestryIn(root([view([self()], { activityState: 0 })])))).toBe(false);
  });

  it('hides when a screen further up is inactive, and still reads every host', () => {
    const fiber = selfIn(
      root([inactive([view([self()], { style: { overflow: 'hidden' } })])]),
    );
    const ancestry = ancestryOfFiber(fiber);

    expect(isHidden(ancestry)).toBe(true);
    expect(ancestry.hosts.map((host) => host.clips)).toEqual([true, false]);
  });

  it('a hidden display or Offscreen hides nothing: the shadow tree measures it 0x0', () => {
    expect(isHidden(ancestryIn(root([view([self()], { style: { display: 'none' } })])))).toBe(false);
    expect(isHidden(ancestryIn(root([offscreen(0, [view([self()])])])))).toBe(false);
  });

  describe('an Animated activityState', () => {
    it.each([
      ['an Animated node', { __getValue: () => 0 }],
      ['any object', {}],
    ])('on the wrapper, %s, hides nothing', (_, activityState) => {
      expect(isHidden(ancestryOfFiber(underScreen(0, { activityState })))).toBe(false);
    });

    it.each([
      ['a number', 0],
      ['null', null],
      ['nothing', undefined],
    ])('on the wrapper, %s, leaves the committed 0 hiding', (_, activityState) => {
      expect(isHidden(ancestryOfFiber(underScreen(0, { activityState })))).toBe(true);
    });

    it('on a wrapper with no props, leaves it hiding', () => {
      const fiber = underScreen(0);
      const wrapper = fiber.return!.return!.return!;
      wrapper.memoizedProps = null;

      expect(isHidden(ancestryOfFiber(fiber))).toBe(true);
    });

    it('is read every time, even when the screen host has not changed', () => {
      const fiber = underScreen(0, { activityState: 0 });
      const ancestry = ancestryOfFiber(fiber);
      expect(isHidden(ancestry)).toBe(true);

      fiber.return!.return!.return!.memoizedProps = { activityState: { __getValue: () => 0 } };

      expect(isHidden(ancestry)).toBe(false);
    });

    it('above the next host up is not the screen’s', () => {
      const screen = fabricHost(SCREEN_HOST_TYPE, null, { activityState: 0 }, [view([self()])]);
      const fiber = selfIn(root([composite([view([screen])], { activityState: { __getValue: () => 0 } })]));

      expect(isHidden(ancestryOfFiber(fiber))).toBe(true);
    });
  });

  describe('reads the committed fiber of each pair', () => {
    it('not a render in flight, nor the canonical props it wrote', () => {
      const fiber = underScreen(2);
      pairWith(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 }, true);

      expect(isHidden(ancestryOfFiber(fiber))).toBe(false);
    });

    it('the committed one when the stored chain runs through the other', () => {
      const fiber = underScreen(0);
      pairWith(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 2 });

      expect(isHidden(ancestryOfFiber(fiber))).toBe(true);
    });

    it('the committed one when the stored fiber is the committed one', () => {
      const fiber = underScreen(0);
      const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);
      const other = pairWith(screen, { activityState: 2 });
      // The chain from below runs through the committed fiber again.
      for (let child = screen.child; child !== null; child = child.sibling) {
        child.return = screen;
      }

      expect(isHidden(ancestryOfFiber(fiber))).toBe(true);
      expect(other.alternate).toBe(screen);
    });

    it('the root of either fiber of the root pair', () => {
      const fiber = underScreen(0);
      const ancestry = ancestryOfFiber(fiber);
      const top = ancestry.path[ancestry.path.length - 1]!;
      const otherRoot = { ...top, alternate: top } as FiberLike;
      top.alternate = otherRoot;
      (ancestry.root as { current: unknown }).current = otherRoot;
      otherRoot.child = top.child;

      expect(isHidden(ancestry)).toBe(true);
    });

    it('resolves a shared prefix once per pass, by either fiber of a pair', () => {
      const fibers = selvesIn(root([inactive([view([self()]), view([self()])])]));
      const screen = ancestorOfType(fibers[0]!, SCREEN_HOST_TYPE);
      const other = pairWith(screen, { activityState: 2 });
      // One view's chain runs through each fiber of the screen's pair.
      fibers[1]!.return!.return = screen;
      fibers[0]!.return!.return = other;
      const [first, second] = fibers.map((fiber) => ancestryOfFiber(fiber));
      let childReads = 0;
      const rootFiber = screen.return!;
      const children = rootFiber.child;
      Object.defineProperty(rootFiber, 'child', {
        get(): FiberLike | null {
          childReads += 1;
          return children;
        },
      });

      measurePass(() => {
        expect([isHidden(first!), isHidden(second!)]).toEqual([true, true]);
      });
      expect(childReads).toBe(1);

      isHidden(first!);
      isHidden(second!);
      expect(childReads).toBe(3);
    });
  });

  describe('cannot be read: false, and nothing clipped', () => {
    function clipsAfter(ancestry: Ancestry): boolean {
      const hidden = isHidden(ancestry);
      expect(ancestry.readable).toBe(false);
      return hidden;
    }

    it('with no root', () => {
      expect(clipsAfter({ ...ancestryOfFiber(underScreen(0)), root: null })).toBe(false);
    });

    it('with no path', () => {
      expect(clipsAfter(noAncestry())).toBe(false);
    });

    it('with a root whose current is not the path’s top', () => {
      const ancestry = ancestryOfFiber(underScreen(0));
      (ancestry.root as { current: unknown }).current = { tag: FiberTag.HostRoot };

      expect(clipsAfter(ancestry)).toBe(false);
    });

    it('with a root that has no current', () => {
      const ancestry = ancestryOfFiber(underScreen(0));
      (ancestry.root as { current: unknown }).current = null;
      // React's first root has a null alternate: not a match either.
      ancestry.path[ancestry.path.length - 1]!.alternate = null;

      expect(clipsAfter(ancestry)).toBe(false);
    });

    it('with a root whose current is some other tree holding the same children', () => {
      const ancestry = ancestryOfFiber(underScreen(0));
      const top = ancestry.path[ancestry.path.length - 1]!;
      (ancestry.root as { current: unknown }).current = { ...top, alternate: null };

      expect(clipsAfter(ancestry)).toBe(false);
    });

    it('with a stored fiber that is not in the committed tree', () => {
      const fiber = underScreen(0);
      const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);
      const ancestry = ancestryOfFiber(fiber);
      screen.child = null;

      expect(clipsAfter(ancestry)).toBe(false);
    });

    it('with a stored fiber further up that is not in the committed tree', () => {
      const fiber = underScreen(0);
      const ancestry = ancestryOfFiber(fiber);
      ancestry.path[2]!.child = null;

      expect(clipsAfter(ancestry)).toBe(false);
    });

    it('with a stored fiber found among later siblings', () => {
      const fiber = selfIn(root([view([]), view([]), inactive([self()])]));

      expect(isHidden(ancestryOfFiber(fiber))).toBe(true);
    });

    it('with props that throw while read, even after a nearer host read as clipping', () => {
      const fiber = selfIn(root([inactive([scrollView(null, [self()])])]));
      commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), {
        get style(): never {
          throw new Error('torn props');
        },
      });
      const ancestry = ancestryOfFiber(fiber);

      expect(clipsAfter(ancestry)).toBe(false);
      expect(ancestry.hosts[1]!.clips).toBe(true);
    });

    it('until it can be read again', () => {
      const ancestry = ancestryOfFiber(underScreen(0));
      const rootState = ancestry.root as { current: unknown };
      const committed = rootState.current;
      rootState.current = null;
      expect(clipsAfter(ancestry)).toBe(false);

      rootState.current = committed;
      expect(isHidden(ancestry)).toBe(true);
      expect(ancestry.readable).toBe(true);
    });
  });

  it('follows a commit that hides and then shows the view', () => {
    const fiber = underScreen(2);
    const ancestry = ancestryOfFiber(fiber);
    const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);

    expect(isHidden(ancestry)).toBe(false);
    commitProps(screen, { activityState: 0 });
    expect(isHidden(ancestry)).toBe(true);
    commitProps(screen, { activityState: 2 });
    expect(isHidden(ancestry)).toBe(false);
  });

  it('re-reads a host only when its committed props change', () => {
    let reads = 0;
    const props = {
      get style(): unknown {
        reads += 1;
        return {};
      },
    };
    const fiber = selfIn(root([view([self()])]));
    commitProps(ancestorOfType(fiber, 'RCTView'), props);
    const ancestry = ancestryOfFiber(fiber);

    isHidden(ancestry);
    isHidden(ancestry);
    expect(reads).toBe(1);

    commitProps(ancestorOfType(fiber, 'RCTView'), { ...props });
    isHidden(ancestry);
    expect(reads).toBe(2);
  });

  it('records which hosts clip', () => {
    const open = view([scrollView(null, [self()])], { style: { overflow: 'visible' } });
    const ancestry = ancestryIn(root([view([open], { style: { overflow: 'hidden' } })]));

    isHidden(ancestry);

    expect(ancestry.hosts.map((host) => [ancestry.path[host.index]!.type, host.clips])).toEqual([
      ['RCTScrollContentView', false],
      ['RCTScrollView', true],
      ['RCTView', false],
      ['RCTView', true],
    ]);
  });

  it.each([
    [{ overflow: 'visible' }, false],
    [[{ overflow: 'hidden' }, { overflow: 'visible' }], false],
    [{ overflow: 'hidden' }, true],
    [{ overflow: 'scroll' }, true],
    [{}, true],
    [undefined, true],
  ])('a ScrollView styled %p clips: %p', (style, clips) => {
    const fiber = selfIn(root([scrollView(null, [self()])]));
    commitProps(ancestorOfType(fiber, 'RCTScrollView'), { style });
    const ancestry = ancestryOfFiber(fiber);

    isHidden(ancestry);

    expect(ancestry.hosts[1]).toMatchObject({ scrolls: true, clips });
  });

  it('a host with no committed props clips nothing and hides nothing', () => {
    const fiber = underScreen(0);
    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), null);

    expect(isHidden(ancestryOfFiber(fiber))).toBe(false);
  });
});

describe('clipToAncestors', () => {
  /** The ancestry of `spec`'s SELF, with its clips read. */
  function readAncestry(spec: Parameters<typeof selfIn>[0]): Ancestry {
    const ancestry = ancestryIn(spec);
    isHidden(ancestry);
    return ancestry;
  }

  const SELF_RECT = rect(10, 100, 200, 50);

  it('returns the rectangle itself, measuring nothing, when nothing clips', () => {
    const ancestry = readAncestry(root([view([view([self()])])]));

    expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    expect(clipToAncestors(rect(0, 0, 0, 0), ancestry)).toEqual(rect(0, 0, 0, 0));
    expect(renderer.measures).toEqual([]);
    expect(renderer.lookups).toEqual([]);
  });

  it('returns the rectangle itself with no ancestors', () => {
    expect(clipToAncestors(SELF_RECT, noAncestry())).toBe(SELF_RECT);
  });

  it('returns the rectangle itself, measuring nothing, when the last read was not complete', () => {
    const ancestry = readAncestry(root([scrollView(rect(0, 0, 400, 110), [self()])]));
    ancestry.readable = false;

    expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    expect(renderer.measures).toEqual([]);
  });

  it('lets an ancestor answering 0/0/0/0 clip nothing, and the others still clip', () => {
    const only = readAncestry(root([scrollView(rect(0, 0, 0, 0), [self()])]));
    expect(clipToAncestors(SELF_RECT, only)).toBe(SELF_RECT);

    const nested = readAncestry(root([scrollView(rect(0, 0, 400, 120), [scrollView(rect(0, 0, 0, 0), [self()])])]));
    expect(clipToAncestors(SELF_RECT, nested)).toEqual(rect(10, 100, 200, 20));
  });

  it.each([
    ['x', rect(5, 0, 0, 0)],
    ['y', rect(0, 5, 0, 0)],
    ['width', rect(0, 0, 5, 0)],
    ['height', rect(0, 0, 0, 5)],
  ])('lets an ancestor with a non-zero %s and nothing else clip', (_, measured) => {
    expect(clipToAncestors(SELF_RECT, readAncestry(root([scrollView(measured, [self()])])))).toBeNull();
  });

  it('keeps an ancestor answering 0/0/0/0 for the pass', () => {
    const ancestry = readAncestry(root([scrollView(rect(0, 0, 0, 0), [self()])]));

    measurePass(() => {
      clipToAncestors(SELF_RECT, ancestry);
      expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    });

    expect(renderer.measures).toHaveLength(1);
  });

  it('is the whole rectangle inside the viewport', () => {
    expect(clipToAncestors(SELF_RECT, readAncestry(root([scrollView(rect(0, 0, 400, 800), [self()])])))).toEqual(
      SELF_RECT,
    );
  });

  it.each([
    ['above', rect(0, 120, 400, 800), rect(10, 120, 200, 30)],
    ['below', rect(0, 0, 400, 130), rect(10, 100, 200, 30)],
    ['to the left', rect(60, 0, 400, 800), rect(60, 100, 150, 50)],
    ['to the right', rect(0, 0, 110, 800), rect(10, 100, 100, 50)],
    ['on every side', rect(20, 110, 100, 20), rect(20, 110, 100, 20)],
  ])('cuts off what lies outside the viewport %s', (_, viewport, expected) => {
    expect(clipToAncestors(SELF_RECT, readAncestry(root([scrollView(viewport, [self()])])))).toEqual(expected);
  });

  it.each([
    ['above', rect(0, 0, 400, 100)],
    ['below', rect(0, 150, 400, 800)],
    ['to the left', rect(0, 0, 10, 800)],
    ['to the right', rect(210, 0, 400, 800)],
    ['far away', rect(0, 1000, 400, 800)],
  ])('is nothing when the viewport lies wholly %s', (_, viewport) => {
    expect(clipToAncestors(SELF_RECT, readAncestry(root([scrollView(viewport, [self()])])))).toBeNull();
  });

  it('is cut by every clipping ancestor: nested ScrollViews', () => {
    const horizontal = scrollView(rect(50, 0, 400, 800), [self()], 'AndroidHorizontalScrollView');
    const ancestry = readAncestry(root([scrollView(rect(0, 0, 400, 130), [horizontal])]));

    expect(clipToAncestors(SELF_RECT, ancestry)).toEqual(rect(50, 100, 160, 30));
    expect(renderer.measures.map((fiber) => fiber.type)).toEqual(['AndroidHorizontalScrollView', 'RCTScrollView']);
  });

  it("is cut by a view styled overflow: 'hidden', and not by one that is not", () => {
    const clipped = fabricHost('RCTView', rect(0, 0, 400, 120), { style: { overflow: 'hidden' } }, [self()]);
    const open = fabricHost('RCTView', rect(0, 0, 400, 120), { style: { overflow: 'visible' } }, [self()]);

    expect(clipToAncestors(SELF_RECT, readAncestry(root([clipped])))).toEqual(rect(10, 100, 200, 20));
    expect(clipToAncestors(SELF_RECT, readAncestry(root([open])))).toEqual(SELF_RECT);
  });

  it('follows the ancestors as they move', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 800), [self()])]));
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);
    expect(clipToAncestors(SELF_RECT, ancestry)).toEqual(SELF_RECT);

    moveTo(ancestorOfType(fiber, 'RCTScrollView'), rect(0, 0, 400, 110));

    expect(clipToAncestors(SELF_RECT, ancestry)).toEqual(rect(10, 100, 200, 10));
  });

  it('looks each clipping host up once, however often it measures', () => {
    const ancestry = readAncestry(root([scrollView(rect(0, 0, 400, 800), [self()])]));

    clipToAncestors(SELF_RECT, ancestry);
    clipToAncestors(SELF_RECT, ancestry);

    expect(renderer.lookups).toHaveLength(1);
    expect(renderer.measures).toHaveLength(2);
  });

  it('uses the clips the last isHidden read', () => {
    const fiber = selfIn(root([view([self()])]));
    const ancestry = ancestryOfFiber(fiber);
    moveTo(ancestorOfType(fiber, 'RCTView'), rect(0, 0, 400, 110));
    isHidden(ancestry);
    commitProps(ancestorOfType(fiber, 'RCTView'), { style: { overflow: 'hidden' } });

    expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    isHidden(ancestry);
    expect(clipToAncestors(SELF_RECT, ancestry)).toEqual(rect(10, 100, 200, 10));
  });

  describe('in a measure pass', () => {
    /** Two views under one ScrollView, each with its ancestry read. */
    function twoUnder(viewport: Parameters<typeof scrollView>[0]): Ancestry[] {
      return selvesIn(root([scrollView(viewport, [self(), self()])])).map((fiber) => {
        const ancestry = ancestryOfFiber(fiber);
        isHidden(ancestry);
        return ancestry;
      });
    }

    it('measures an ancestor shared by two views once', () => {
      const [first, second] = twoUnder(rect(0, 0, 400, 120));
      const results: unknown[] = [];

      measurePass(() => {
        results.push(clipToAncestors(SELF_RECT, first!), clipToAncestors(rect(0, 110, 100, 100), second!));
      });

      expect(results).toEqual([rect(10, 100, 200, 20), rect(0, 110, 100, 10)]);
      expect(renderer.measures).toHaveLength(1);
    });

    it('keeps an ancestor that did not answer for the pass, unclipped for both', () => {
      const [first, second] = twoUnder(null);
      const results: unknown[] = [];

      measurePass(() => {
        results.push(clipToAncestors(SELF_RECT, first!), clipToAncestors(SELF_RECT, second!));
      });

      expect(results).toEqual([SELF_RECT, SELF_RECT]);
      expect(renderer.measures).toHaveLength(1);
    });

    it('measures afresh in the next pass and outside any pass', () => {
      const [first] = twoUnder(rect(0, 0, 400, 120));
      measurePass(() => {
        clipToAncestors(SELF_RECT, first!);
      });
      measurePass(() => {
        clipToAncestors(SELF_RECT, first!);
      });
      clipToAncestors(SELF_RECT, first!);
      clipToAncestors(SELF_RECT, first!);

      expect(renderer.measures).toHaveLength(4);
    });

    it('ends the pass when it throws', () => {
      const [first] = twoUnder(rect(0, 0, 400, 120));
      const failure = new Error('measurer broke');

      expect(() =>
        measurePass(() => {
          clipToAncestors(SELF_RECT, first!);
          throw failure;
        }),
      ).toThrow(failure);
      clipToAncestors(SELF_RECT, first!);

      expect(renderer.measures).toHaveLength(2);
    });
  });

  describe('fails closed: the whole rectangle, unclipped', () => {
    it('when a clipping ancestor never answers', () => {
      const ancestry = readAncestry(root([scrollView(rect(0, 0, 400, 120), [scrollView(null, [self()])])]));

      expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    });

    it.each([
      ['x', rect(Number.NaN, 0, 400, 120)],
      ['y', rect(0, Number.POSITIVE_INFINITY, 400, 120)],
      ['width', rect(0, 0, Number.NaN, 120)],
      ['height', rect(0, 0, 400, Number.NEGATIVE_INFINITY)],
    ])('when a clipping ancestor answers a non-finite %s', (_, measured) => {
      const ancestry = readAncestry(root([scrollView(rect(0, 0, 400, 110), [scrollView(measured, [self()])])]));

      expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    });

    it('when a clipping ancestor further out never answers, after a nearer one cut', () => {
      const ancestry = readAncestry(root([scrollView(null, [scrollView(rect(0, 0, 400, 120), [self()])])]));

      expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    });

    it('when a clipping ancestor further out throws, after a nearer one cut', () => {
      const fiber = selfIn(root([scrollView(rect(0, 0, 400, 800), [scrollView(rect(0, 0, 400, 120), [self()])])]));
      const ancestry = ancestryOfFiber(fiber);
      const outer = ancestry.path[ancestry.hosts[3]!.index]!;
      isHidden(ancestry);
      const working = renderer.getPublicInstanceFromInternalInstanceHandle;
      renderer.getPublicInstanceFromInternalInstanceHandle = (host) => {
        if (host === outer) {
          throw new Error('detached');
        }
        return working(host);
      };

      expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    });

    it('when measuring a clipping ancestor throws', () => {
      const ancestry = readAncestry(root([scrollView(rect(0, 0, 400, 120), [self()])]));
      renderer.getPublicInstanceFromInternalInstanceHandle = () => ({
        measureInWindow: () => {
          throw new Error('detached');
        },
      });

      expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    });

    it('when the renderer cannot be loaded', () => {
      const ancestry = readAncestry(root([scrollView(rect(0, 0, 400, 120), [self()])]));
      jest.doMock(RENDERER_PROXY, () => {
        throw new Error('no renderer');
      });

      expect(clipToAncestors(SELF_RECT, ancestry)).toBe(SELF_RECT);
    });

    // A non-finite rectangle is the view's own failed measurement; it goes
    // on as it is, for the registry to reject.
    it.each([
      ['x', rect(Number.NaN, 100, 200, 50)],
      ['y', rect(10, Number.NaN, 200, 50)],
      ['width', rect(10, 100, Number.POSITIVE_INFINITY, 50)],
      ['height', rect(10, 100, 200, Number.NaN)],
    ])("when the view's own %s is not finite", (_, measured) => {
      const ancestry = readAncestry(root([scrollView(rect(0, 1000, 400, 120), [self()])]));

      expect(clipToAncestors(measured, ancestry)).toBe(measured);
      expect(renderer.measures).toEqual([]);
    });
  });
});
