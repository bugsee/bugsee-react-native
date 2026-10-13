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
  NO_ANCESTRY,
  SCREEN_HOST_TYPE,
  SCROLL_HOST_TYPES,
  ancestryOfFiber,
  ancestryOfInstance,
  clipToAncestors,
  isHidden,
  styleValue,
} from '../ancestry';
import type { Ancestry } from '../ancestry';
import { MODAL_HOST_TYPE } from '../surface';
import {
  ancestorOfType,
  commitProps,
  composite,
  fabricHost,
  fakeRenderer,
  moveTo,
  offscreen,
  rect,
  root,
  scrollView,
  self,
  selfIn,
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

const types = (ancestry: Ancestry): unknown[] => ancestry.hosts.map((host) => host.fiber.type);

describe('ancestryOfFiber', () => {
  it('lists every host above the view, nearest first, and not the view itself', () => {
    const ancestry = ancestryIn(root([view([composite([scrollView(rect(0, 0, 1, 1), [self()])])])]));

    expect(types(ancestry)).toEqual(['RCTScrollContentView', 'RCTScrollView', 'RCTView']);
    expect(ancestry.offscreens).toEqual([]);
  });

  it('lists the Offscreen fibers in the same stretch', () => {
    const ancestry = ancestryIn(root([offscreen(1, [view([offscreen(0, [self()])])])]));

    expect(ancestry.offscreens.map((fiber) => fiber.stateNode)).toEqual([{ _visibility: 0 }, { _visibility: 1 }]);
    expect(types(ancestry)).toEqual(['RCTView']);
  });

  // A Modal's content is its own surface, measured from its own origin:
  // nothing above it clips or hides what is inside.
  it('stops at the nearest Modal host, leaving it out', () => {
    const modal = fabricHost(MODAL_HOST_TYPE, rect(0, 0, 1, 1), {}, [view([self()])]);
    const ancestry = ancestryIn(root([offscreen(0, [view([modal], { style: { display: 'none' } })])]));

    expect(types(ancestry)).toEqual(['RCTView']);
    expect(ancestry.offscreens).toEqual([]);
  });

  it('knows the react-native-screens screen host', () => {
    expect(SCREEN_HOST_TYPE).toBe('RNSScreen');
  });

  it('marks the ScrollView hosts of both platforms, and only those', () => {
    expect([...SCROLL_HOST_TYPES]).toEqual(['RCTScrollView', 'AndroidHorizontalScrollView']);
    const ancestry = ancestryIn(root([scrollView(null, [scrollView(null, [self()], 'AndroidHorizontalScrollView')])]));

    expect(ancestry.hosts.map((host) => [host.fiber.type, host.scrolls])).toEqual([
      ['RCTScrollContentView', false],
      ['AndroidHorizontalScrollView', true],
      ['RCTScrollContentView', false],
      ['RCTScrollView', true],
    ]);
  });

  it('starts every host unread and unmeasured', () => {
    const [host] = ancestryIn(root([view([self()])])).hosts;

    expect(host).toMatchObject({ hides: false, clips: false, instance: undefined });
    expect(typeof host?.props).toBe('symbol');
  });

  it('ends a cyclic chain', () => {
    const loop = { tag: FiberTag.HostComponent, type: 'RCTView', stateNode: null } as FiberLike;
    loop.return = loop;
    const fiber = { tag: FiberTag.HostComponent, type: 'SELF', return: loop } as FiberLike;

    expect(ancestryOfFiber(fiber).hosts).toHaveLength(10_000);
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
    expect(ancestryOfInstance(instance)).toBe(NO_ANCESTRY);
  });

  it('has no ancestors when the tree throws while it is read', () => {
    const fiber = { tag: FiberTag.HostComponent, type: 'SELF' };
    Object.defineProperty(fiber, 'return', {
      get(): never {
        throw new Error('torn fiber');
      },
    });

    expect(ancestryOfInstance({ __internalInstanceHandle: fiber })).toBe(NO_ANCESTRY);
  });

  it('NO_ANCESTRY hides nothing and clips nothing', () => {
    expect(NO_ANCESTRY).toEqual({ hosts: [], offscreens: [] });
  });
});

describe('styleValue', () => {
  it.each([
    ['an object', { display: 'none' }, 'none'],
    ['an object without the key', { opacity: 1 }, undefined],
    ['the last entry that sets it', [{ display: 'none' }, { display: 'flex' }], 'flex'],
    ['an earlier entry when later ones do not set it', [{ display: 'none' }, { opacity: 1 }, null, false], 'none'],
    ['nested arrays', [{ display: 'flex' }, [[{ display: 'none' }], undefined]], 'none'],
    ['an empty array', [], undefined],
    ['null', null, undefined],
    ['a registered style id', 12, undefined],
    ['a string', 'none', undefined],
  ])('reads %s', (_, style, expected) => {
    expect(styleValue(style, 'display')).toBe(expected);
  });
});

describe('isHidden', () => {
  it('is false with nothing hiding', () => {
    expect(isHidden(ancestryIn(root([view([view([self()])], { style: { display: 'flex' } })])))).toBe(false);
  });

  it('is false with no ancestors at all', () => {
    expect(isHidden(NO_ANCESTRY)).toBe(false);
  });

  it("is true under a host styled display: 'none'", () => {
    const ancestry = ancestryIn(root([view([view([self()])], { style: [{ display: 'flex' }, { display: 'none' }] })]));

    expect(isHidden(ancestry)).toBe(true);
  });

  it.each([
    [0, true],
    [1, false],
    [2, false],
    [-1, false],
    ['0', false],
    [undefined, false],
  ])('an RNSScreen with activityState %p hides: %p', (activityState, hidden) => {
    const ancestry = ancestryIn(root([fabricHost(SCREEN_HOST_TYPE, null, { activityState }, [view([self()])])]));

    expect(isHidden(ancestry)).toBe(hidden);
  });

  it('activityState 0 on any other host hides nothing', () => {
    expect(isHidden(ancestryIn(root([view([self()], { activityState: 0 })])))).toBe(false);
  });

  it.each([
    [0, true],
    [2, true],
    [1, false],
    [3, false],
    ['0', false],
    [undefined, false],
  ])('an Offscreen with _visibility %p hides: %p', (visibility, hidden) => {
    expect(isHidden(ancestryIn(root([offscreen(visibility, [view([self()])])])))).toBe(hidden);
  });

  it('an Offscreen with no instance hides nothing, and the one above it still can', () => {
    const bare = { tag: FiberTag.Offscreen, stateNode: null, children: [self()] };

    expect(isHidden(ancestryIn(root([bare])))).toBe(false);
    expect(isHidden(ancestryIn(root([offscreen(0, [bare])])))).toBe(true);
  });

  it('a hidden Offscreen above visible hosts hides', () => {
    expect(isHidden(ancestryIn(root([offscreen(0, [view([view([self()])])])])))).toBe(true);
  });

  // The stored fiber may be the stale one of the pair: its own memoizedProps
  // are not what is on screen. Both fibers share canonical, which is.
  it('reads committed props, not the stored fiber’s stale ones', () => {
    const staleHidden = fabricHost('RCTView', null, { style: {} }, [self()], { style: { display: 'none' } });
    const staleVisible = fabricHost('RCTView', null, { style: { display: 'none' } }, [self()], { style: {} });

    expect(isHidden(ancestryIn(root([staleHidden])))).toBe(false);
    expect(isHidden(ancestryIn(root([staleVisible])))).toBe(true);
  });

  // Not Fabric: a ScrollView still clips by type, and its measurement then
  // decides (Paper's answers late, which cuts nothing).
  it('a ScrollView with no committed props to read still clips', () => {
    const paper = { tag: FiberTag.HostComponent, type: 'RCTScrollView', stateNode: null, children: [self()] };
    const ancestry = ancestryIn(root([paper]));

    expect(isHidden(ancestry)).toBe(false);
    expect(ancestry.hosts[0]).toMatchObject({ clips: true, hides: false });
  });

  it('a host with no committed props to read hides nothing', () => {
    const paper = {
      tag: FiberTag.HostComponent,
      type: 'RCTView',
      memoizedProps: { style: { display: 'none' } },
      stateNode: {},
      children: [self()],
    };
    const bare = { ...paper, stateNode: null };

    expect(isHidden(ancestryIn(root([paper])))).toBe(false);
    expect(isHidden(ancestryIn(root([bare])))).toBe(false);
  });

  it('follows a commit that hides and then shows the view', () => {
    const fiber = selfIn(root([view([self()])]));
    const ancestry = ancestryOfFiber(fiber);
    const host = ancestorOfType(fiber, 'RCTView');

    expect(isHidden(ancestry)).toBe(false);
    commitProps(host, { style: { display: 'none' } });
    expect(isHidden(ancestry)).toBe(true);
    commitProps(host, { style: {} });
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

  it('stops reading at the first host that hides', () => {
    let read = false;
    const outer = {
      get style(): unknown {
        read = true;
        return {};
      },
    };
    const fiber = selfIn(root([view([view([self()], { style: { display: 'none' } })])]));
    const ancestry = ancestryOfFiber(fiber);
    commitProps(ancestry.hosts[1]!.fiber, outer);

    expect(isHidden(ancestry)).toBe(true);
    expect(read).toBe(false);
  });

  it('counts as visible when an ancestor throws while it is read', () => {
    const fiber = selfIn(root([offscreen(0, [view([self()])])]));
    commitProps(ancestorOfType(fiber, 'RCTView'), {
      get style(): never {
        throw new Error('torn props');
      },
    });

    expect(isHidden(ancestryOfFiber(fiber))).toBe(false);
  });

  it('records which hosts clip', () => {
    const open = view([scrollView(null, [self()])], { style: { overflow: 'visible' } });
    const ancestry = ancestryIn(root([view([open], { style: { overflow: 'hidden' } })]));

    isHidden(ancestry);

    expect(ancestry.hosts.map((host) => [host.fiber.type, host.clips])).toEqual([
      ['RCTScrollContentView', false],
      ['RCTScrollView', true],
      ['RCTView', false],
      ['RCTView', true],
    ]);
  });

  // A ScrollView clips its content whatever its own style says.
  it('a ScrollView styled overflow: visible still clips', () => {
    const fiber = selfIn(root([scrollView(null, [self()])]));
    commitProps(ancestorOfType(fiber, 'RCTScrollView'), { style: { overflow: 'visible' } });
    const ancestry = ancestryOfFiber(fiber);

    isHidden(ancestry);

    expect(ancestry.hosts[1]).toMatchObject({ scrolls: true, clips: true });
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
    expect(clipToAncestors(SELF_RECT, NO_ANCESTRY)).toBe(SELF_RECT);
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
      const outer = ancestry.hosts[3]!.fiber;
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
