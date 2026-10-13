/**
 * The review of PR #87 (#86): every way the visible-rectangle logic could
 * withdraw, or cut short, the region of a secure view that is on screen.
 * Main never withdrew a region, so each of these would be a leak the fix
 * introduced. Each test failed against the first version of the fix.
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { BugseeSecure } from '../BugseeSecure';
import { MODAL_SCREEN_HOST_TYPE, SCREEN_HOST_TYPE } from '../ancestry';
import { STEADY_FRAMES } from '../tracker';
import { native } from '../../__mocks__/native';
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import {
  ancestorOfType,
  commitProps,
  composite,
  fabricHost,
  fakeRenderer,
  offscreen,
  pairWith,
  rect,
  root,
  screenContainer,
  scrollView,
  self,
  selfIn,
  selvesIn,
  view,
} from './fakeAncestors';
import type { FakeRenderer } from './fakeAncestors';

jest.mock('react-native', () => ({
  View: 'View',
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'android' },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

let renderer: FakeRenderer;
// Delegates, so the mock module (cached for the whole file) reaches each
// test's own fake renderer.
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  getPublicInstanceFromInternalInstanceHandle: (fiber: FiberLike) =>
    renderer.getPublicInstanceFromInternalInstanceHandle(fiber),
}));

// See BugseeSecure.test.tsx: React Native's own test-environment flags.
(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Callback = (x: number, y: number, width: number, height: number) => void;

/** Where the secure view itself measures to; `moveTo` the self fiber's rect. */
let selfRect: WindowRect;
let measureInWindow: jest.Mock<void, [Callback]>;
let mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  native.reset();
  renderer = fakeRenderer();
  selfRect = rect(10, 100, 200, 50);
  measureInWindow = jest.fn((callback: Callback) => callback(selfRect.x, selfRect.y, selfRect.width, selfRect.height));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => mounted.forEach((mountedRenderer) => mountedRenderer.unmount()));
  mounted = [];
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Mounts `element` with its View backed by `fiber`. */
function render(fiber: FiberLike | undefined, element: ReactElement = <BugseeSecure />): ReactTestRenderer {
  let testRenderer: ReactTestRenderer | undefined;
  act(() => {
    testRenderer = create(element, {
      createNodeMock: () => ({ measureInWindow, ...(fiber === undefined ? {} : { __internalInstanceHandle: fiber }) }),
      unstable_isConcurrent: true,
    } as Parameters<typeof create>[1]);
  });
  mounted.push(testRenderer as ReactTestRenderer);
  return testRenderer as ReactTestRenderer;
}

function tick(times = 1): void {
  act(() => {
    jest.advanceTimersByTime(100 * times);
  });
}

/** A window rectangle in points as the registry publishes it, at PixelRatio 2. */
const px = ({ x, y, width, height }: WindowRect): number[] => [2 * x, 2 * y, 2 * (x + width), 2 * (y + height)];

const lastPublished = (): unknown => native.setSecureRectangles.mock.lastCall;

/**
 * Nothing but empty sets reached the bridge, at most once: the registry
 * sends only a change, and the lane may already be empty from an earlier
 * test (its state outlives each test, as a JS runtime's does).
 */
function publishedOnlyNothing(): void {
  const calls = native.setSecureRectangles.mock.calls;
  expect(calls.filter(([, flat]) => (flat as unknown[]).length > 0)).toEqual([]);
  expect(calls.length).toBeLessThanOrEqual(1);
}

/** A secure view under an RNSScreen with committed `activityState`, under a wrapper with `wrapperProps`. */
function underScreen(activityState: unknown, wrapperProps: Record<string, unknown> = {}): FiberLike {
  return selfIn(
    root([
      screenContainer([
        composite(
          [fabricHost(SCREEN_HOST_TYPE, rect(0, 0, 400, 800), { activityState }, [view([self()])])],
          wrapperProps,
        ),
      ]),
    ]),
  );
}

describe('P0-1: hidden or clipped only by what is committed', () => {
  // A transition rendered the screen inactive, then suspended (or was
  // interrupted, or abandoned): the work-in-progress fiber and the shared
  // canonical say 0, the committed fiber still says 2, and the screen shows.
  it('a render in flight that makes a screen inactive withdraws nothing', () => {
    const fiber = underScreen(2);
    pairWith(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 }, true);

    render(fiber);
    tick(3);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('a render in flight that sets overflow: hidden clips nothing', () => {
    const fiber = selfIn(root([fabricHost('RCTView', rect(0, 0, 400, 110), {}, [self()])]));
    pairWith(ancestorOfType(fiber, 'RCTView'), { style: { overflow: 'hidden' } }, true);

    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('a stale fiber that still says inactive withdraws nothing', () => {
    const fiber = underScreen(2);
    pairWith(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 });

    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('a committed inactive screen withdraws it, whichever fiber of the pair was stored', () => {
    const fiber = underScreen(0);
    pairWith(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 2 }, true);

    render(fiber);

    expect(measureInWindow).not.toHaveBeenCalled();
    publishedOnlyNothing();
  });

  // Fabric lays a display: 'none' subtree out at 0x0, which publishes
  // nothing; props say nothing reliable about it (setNativeProps, Reanimated).
  it("committed display: 'none' props alone withdraw nothing", () => {
    render(selfIn(root([view([view([self()])], { style: { display: 'none' } })])));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});

describe('P0-2: an Animated activityState is not committed', () => {
  it('a screen whose wrapper drives activityState with an Animated node stays masked', () => {
    const animated = { __getValue: () => 0 };
    render(underScreen(0, { activityState: animated }));
    tick(2);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
    expect(measureInWindow).toHaveBeenCalled();
  });

  it('a plain number on the wrapper is committed, and withdraws it', () => {
    render(underScreen(0, { activityState: 0 }));

    publishedOnlyNothing();
  });
});

describe('P0-3: a ScrollView styled overflow: visible draws outside its viewport', () => {
  it('clips nothing', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 110), [self()])]));
    commitProps(ancestorOfType(fiber, 'RCTScrollView'), { style: [{ flex: 1 }, { overflow: 'visible' }] });

    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});

describe('P0-4: nothing above a root-kind host clips or hides what is inside', () => {
  it.each(['RNSFullWindowOverlay', 'RCTInputAccessoryView', 'RNSModalScreen', 'RNSSplitScreen'])(
    'stops at %s',
    (type) => {
      const overlay = fabricHost(type, rect(0, 0, 400, 800), {}, [view([self()])]);
      const fiber = selfIn(
        root([fabricHost(SCREEN_HOST_TYPE, null, { activityState: 0 }, [scrollView(rect(0, 0, 400, 110), [overlay])])]),
      );

      render(fiber);

      expect(lastPublished()).toEqual([0, px(selfRect)]);
      expect(renderer.measures).toEqual([]);
    },
  );
});

// Cursor review on #87: react-native-screens' iOS modals mount
// RNSModalScreen, which takes activityState like RNSScreen.
describe('a react-native-screens modal screen', () => {
  it('withdraws it while inactive, and shows it again within a frame', () => {
    const modal = fabricHost(MODAL_SCREEN_HOST_TYPE, rect(0, 0, 400, 800), { activityState: 0 }, [view([self()])]);
    const fiber = selfIn(root([screenContainer([composite([modal])], 'RNSScreenStack')]));
    render(fiber);
    publishedOnlyNothing();

    commitProps(ancestorOfType(fiber, MODAL_SCREEN_HOST_TYPE), { activityState: 2 });
    act(() => {
      jest.advanceTimersByTime(17);
    });

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});

describe('P1-1: a hidden Offscreen can be a frozen screen that is still drawn', () => {
  it('withdraws nothing under a hidden Offscreen', () => {
    const frozen = fabricHost(SCREEN_HOST_TYPE, rect(0, 0, 400, 800), { activityState: 2 }, [view([self()])]);
    const fiber = selfIn(root([{ ...offscreen(0, [frozen]), memoizedState: { baseLanes: 0, cachePool: null } }]));

    render(fiber);
    tick(2);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});

describe('P1-2: shown again, it is masked again within a frame', () => {
  it('republishes in the next frame, not the next re-measure', () => {
    const fiber = underScreen(0);
    render(fiber);
    publishedOnlyNothing();

    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 2 });
    act(() => {
      jest.advanceTimersByTime(17);
    });

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('uses requestAnimationFrame where there is one, and cancels it on unmount', () => {
    const frames: Array<() => void> = [];
    const cancelled: number[] = [];
    const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
    let handles = 0;
    g.requestAnimationFrame = (callback: () => void) => {
      frames.push(callback);
      handles += 1;
      return handles;
    };
    g.cancelAnimationFrame = (handle: number) => cancelled.push(handle);
    try {
      const fiber = underScreen(0);
      const testRenderer = render(fiber);
      expect(frames).toHaveLength(1);

      // Still hidden: it watches the next frame too, measuring nothing.
      act(() => frames.shift()?.());
      expect(frames).toHaveLength(1);
      expect(measureInWindow).not.toHaveBeenCalled();

      commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 2 });
      act(() => frames.shift()?.());
      expect(lastPublished()).toEqual([0, px(selfRect)]);
      // Just shown: on the per-frame re-measure until it has stayed put.
      for (let frame = 0; frame < STEADY_FRAMES; frame += 1) {
        expect(frames).toHaveLength(1);
        act(() => frames.shift()?.());
      }
      expect(frames).toHaveLength(0);

      commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 });
      tick();
      expect(frames).toHaveLength(1);
      act(() => testRenderer.unmount());
      mounted = mounted.filter((entry) => entry !== testRenderer);
      expect(cancelled).toEqual([handles]);
    } finally {
      delete g.requestAnimationFrame;
      delete g.cancelAnimationFrame;
    }
  });
});

describe('P1-2: the frame fallback', () => {
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };

  afterEach(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });

  it.each([
    ['requestAnimationFrame without cancelAnimationFrame', 'requestAnimationFrame'],
    ['cancelAnimationFrame without requestAnimationFrame', 'cancelAnimationFrame'],
  ])('falls back to a timer with %s', (_, only) => {
    const called = jest.fn(() => 1);
    (g as Record<string, unknown>)[only] = called;
    const fiber = underScreen(0);
    render(fiber);

    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 2 });
    act(() => {
      jest.advanceTimersByTime(17);
    });

    expect(lastPublished()).toEqual([0, px(selfRect)]);
    expect(called).not.toHaveBeenCalled();
  });
});

// Round 2: a part of a clipped view that scrolls into view must be masked
// within a frame. A clipped view re-measures every frame; a wholly visible one
// stays on the 100 ms tick.
describe('a clipped view follows a scroll into view within a frame', () => {
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };

  afterEach(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });

  function frame(): void {
    act(() => {
      jest.advanceTimersByTime(16);
    });
  }

  it('publishes a view entering the viewport within one frame', () => {
    selfRect = rect(10, 200, 200, 50);
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [self()])])));
    publishedOnlyNothing();

    selfRect = rect(10, 100, 200, 50);
    frame();

    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 30))]);
  });

  it('follows a horizontal scroll within one frame, clipped only in width', () => {
    render(selfIn(root([scrollView(rect(0, 0, 110, 800), [self()], 'AndroidHorizontalScrollView')])));
    expect(lastPublished()).toEqual([0, px(rect(10, 100, 100, 50))]);

    selfRect = rect(-40, 100, 200, 50);
    frame();

    // The new part at once, the old one held.
    expect(lastPublished()).toEqual([0, [...px(rect(0, 100, 110, 50)), ...px(rect(10, 100, 100, 50))]]);
  });

  it('leaves the per-frame re-measure once the view is wholly visible', () => {
    selfRect = rect(10, 100, 200, 50);
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [self()])])));

    selfRect = rect(10, 50, 200, 50);
    frame();
    expect(lastPublished()).toEqual([0, [...px(selfRect), ...px(rect(10, 100, 200, 30))]]);
    // Still for STEADY_FRAMES frames, then off the per-frame re-measure.
    act(() => {
      jest.advanceTimersByTime(16 * STEADY_FRAMES);
    });
    const settled = measureInWindow.mock.calls.length;

    // Frames between ticks measure nothing; a tick measures once.
    act(() => {
      jest.advanceTimersByTime(64);
    });
    tick();
    expect(measureInWindow.mock.calls.length - settled).toBeLessThanOrEqual(2);
    expect(measureInWindow.mock.calls.length - settled).toBeGreaterThanOrEqual(1);
  });

  it('a clipped view is measured once a frame, not again on the tick', () => {
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [self()])])));
    const before = measureInWindow.mock.calls.length;

    // 100 ms: six frames and one tick.
    tick();

    expect(measureInWindow.mock.calls.length - before).toBe(6);
  });

  it('many clipped views share one frame callback and one measure pass', () => {
    const frames: Array<() => void> = [];
    g.requestAnimationFrame = (callback: () => void) => frames.push(callback);
    g.cancelAnimationFrame = () => undefined;
    const fibers = selvesIn(root([scrollView(rect(0, 0, 400, 130), [self(), self(), self()])]));
    let testRenderer: ReactTestRenderer | undefined;
    act(() => {
      testRenderer = create(
        <>
          {fibers.map((_, index) => (
            <BugseeSecure key={index} testID={String(index)} />
          ))}
        </>,
        {
          createNodeMock: (element: { props: { testID?: string } }) => ({
            measureInWindow,
            __internalInstanceHandle: fibers[Number(element.props.testID)],
          }),
          unstable_isConcurrent: true,
        } as Parameters<typeof create>[1],
      );
    });
    mounted.push(testRenderer as ReactTestRenderer);
    expect(frames).toHaveLength(1);
    const ancestorsBefore = renderer.measures.length;
    const selfBefore = measureInWindow.mock.calls.length;

    act(() => frames.shift()?.());

    expect(measureInWindow.mock.calls.length - selfBefore).toBe(3);
    // The ScrollView and its content (watched), once each.
    expect(renderer.measures.length - ancestorsBefore).toBe(2);
    expect(frames).toHaveLength(1);
  });
});

describe('P3-1: a read error clips nothing and hides nothing', () => {
  it('leaves the whole view masked when an ancestor further up cannot be read', () => {
    const fiber = selfIn(root([view([scrollView(rect(0, 0, 400, 110), [self()])])]));
    commitProps(ancestorOfType(fiber, 'RCTView'), {
      get style(): never {
        throw new Error('torn props');
      },
    });

    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('leaves it masked when the stored path is not in the committed tree', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 110), [self()])]));
    const scroll = ancestorOfType(fiber, 'RCTScrollView');
    (scroll.return as FiberLike).child = null;

    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('leaves it masked with no fiber root to resolve from', () => {
    const children = [scrollView(rect(0, 0, 400, 110), [self()])];
    const fiber = selfIn({ tag: FiberTag.HostRoot, type: null, stateNode: {}, children });

    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});

describe('P3-2: an ancestor measured 0/0/0/0 is unknown', () => {
  it('clips nothing itself, while the others still clip', () => {
    render(selfIn(root([scrollView(rect(0, 0, 400, 120), [scrollView(rect(0, 0, 0, 0), [self()])])])));

    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 20))]);
  });
});
