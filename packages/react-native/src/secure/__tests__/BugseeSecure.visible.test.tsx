/**
 * `<BugseeSecure>` publishes only the part of itself that is on screen
 * (bugsee/bugsee-react-native#86): cut to the ScrollViews and
 * `overflow: 'hidden'` views around it, and withdrawn while an ancestor
 * hides it. A region left where the view is not masks, and on Android drops
 * the taps on, whatever is there instead; a region withdrawn or cut while
 * the view shows leaks it. Every test checks one side of that, and how much
 * measuring each re-measure costs.
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { BugseeSecure } from '../BugseeSecure';
import { SCREEN_HOST_TYPE } from '../ancestry';
import { MODAL_HOST_TYPE } from '../surface';
import { native } from '../../__mocks__/native';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import {
  ancestorOfType,
  commitProps,
  fabricHost,
  fakeRenderer,
  moveTo,
  offscreen,
  rect,
  root,
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

describe('<BugseeSecure> clipping', () => {
  it('publishes only what a vertical ScrollView shows', () => {
    render(selfIn(root([view([scrollView(rect(0, 0, 400, 130), [self()])])])));

    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 30))]);
  });

  it('publishes nothing once scrolled fully out, and the visible part once back', () => {
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [self()])])));
    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 30))]);

    selfRect = rect(10, 140, 200, 50);
    tick();
    expect(lastPublished()).toEqual([0, []]);

    selfRect = rect(10, 120, 200, 50);
    tick();
    expect(lastPublished()).toEqual([0, px(rect(10, 120, 200, 10))]);
  });

  it('is cut by every ScrollView it is nested in', () => {
    const horizontal = scrollView(rect(50, 0, 100, 800), [self()], 'AndroidHorizontalScrollView');
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [horizontal])])));

    expect(lastPublished()).toEqual([0, px(rect(50, 100, 100, 30))]);
  });

  it("is cut by a view styled overflow: 'hidden'", () => {
    render(selfIn(root([fabricHost('RCTView', rect(0, 110, 400, 800), { style: { overflow: 'hidden' } }, [self()])])));

    expect(lastPublished()).toEqual([0, px(rect(10, 110, 200, 40))]);
  });

  it('follows a ScrollView that moves', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 800), [self()])]));
    render(fiber);
    expect(lastPublished()).toEqual([0, px(selfRect)]);

    moveTo(ancestorOfType(fiber, 'RCTScrollView'), rect(0, 0, 400, 125));
    tick();

    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 25))]);
  });

  it('measures a ScrollView shared by two views once a re-measure', () => {
    const [first, second] = selvesIn(root([scrollView(rect(0, 0, 400, 130), [self(), self()])]));
    let testRenderer: ReactTestRenderer | undefined;
    act(() => {
      testRenderer = create(
        <>
          <BugseeSecure testID="first" />
          <BugseeSecure testID="second" />
        </>,
        {
          createNodeMock: (element: { props: { testID?: string } }) => ({
            measureInWindow,
            __internalInstanceHandle: element.props.testID === 'first' ? first : second,
          }),
          unstable_isConcurrent: true,
        } as Parameters<typeof create>[1],
      );
    });
    mounted.push(testRenderer as ReactTestRenderer);
    const before = renderer.measures.length;

    tick();

    expect(renderer.measures.length - before).toBe(1);
    expect(lastPublished()).toEqual([0, [...px(rect(10, 100, 200, 30)), ...px(rect(10, 100, 200, 30))]]);
  });

  it('measures the view and its clipping ancestors once each per re-measure, and publishes once', () => {
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [scrollView(rect(0, 0, 400, 800), [self()])])])));
    const selfBefore = measureInWindow.mock.calls.length;
    const ancestorsBefore = renderer.measures.length;
    native.setSecureRectangles.mockClear();

    selfRect = rect(10, 90, 200, 50);
    tick();

    expect(measureInWindow.mock.calls.length - selfBefore).toBe(1);
    expect(renderer.measures.length - ancestorsBefore).toBe(2);
    expect(native.setSecureRectangles.mock.calls).toEqual([[0, px(rect(10, 90, 200, 40))]]);
  });
});

describe('<BugseeSecure> while hidden', () => {
  /** A secure view under an RNSScreen with `activityState`. */
  function underScreen(activityState: number): FiberLike {
    return selfIn(root([fabricHost(SCREEN_HOST_TYPE, rect(0, 0, 400, 800), { activityState }, [view([self()])])]));
  }

  it('an inactive react-native-screens screen withdraws it, and an active one brings it back', () => {
    const fiber = underScreen(2);
    render(fiber);
    expect(lastPublished()).toEqual([0, px(selfRect)]);

    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 });
    tick();
    expect(lastPublished()).toEqual([0, []]);

    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 2 });
    tick();
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it("a view styled display: 'none' withdraws it", () => {
    const fiber = selfIn(root([view([view([self()])])]));
    render(fiber);

    commitProps(ancestorOfType(fiber, 'RCTView'), { style: [{ flex: 1 }, { display: 'none' }] });
    tick();
    expect(lastPublished()).toEqual([0, []]);

    commitProps(ancestorOfType(fiber, 'RCTView'), { style: [{ flex: 1 }, { display: 'flex' }] });
    tick();
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('a hidden Offscreen (Activity) withdraws it', () => {
    const fiber = selfIn(root([offscreen(1, [view([self()])])]));
    render(fiber);
    const instance = fiber.return?.return?.stateNode as { _visibility: number };

    instance._visibility = 0;
    tick();
    expect(lastPublished()).toEqual([0, []]);

    instance._visibility = 1;
    tick();
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('mounted hidden, it publishes nothing and measures nothing', () => {
    render(underScreen(0));
    tick(5);

    expect(measureInWindow).not.toHaveBeenCalled();
    expect(renderer.measures).toEqual([]);
    publishedOnlyNothing();
  });

  it('measures nothing while hidden, and withdraws once', () => {
    const screen = fabricHost(SCREEN_HOST_TYPE, null, { activityState: 2 }, [self()]);
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 800), [screen])]));
    render(fiber);
    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 });
    measureInWindow.mockClear();
    renderer.measures = [];
    native.setSecureRectangles.mockClear();

    tick(5);

    expect(measureInWindow).not.toHaveBeenCalled();
    expect(renderer.measures).toEqual([]);
    // The registry sends only a change across the bridge.
    expect(native.setSecureRectangles.mock.calls).toEqual([[0, []]]);
  });

  // The stored ancestor fiber may be the stale one of its pair: what is on
  // screen is the committed props both share through canonical.
  it('goes by committed props, not the stored fiber’s stale ones', () => {
    const staleHidden = fabricHost('RCTView', null, { style: {} }, [self()], { style: { display: 'none' } });
    render(selfIn(root([staleHidden])));
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('goes by committed props when the stored fiber’s own are stale and visible', () => {
    const staleVisible = fabricHost('RCTView', null, { style: { display: 'none' } }, [self()], { style: {} });
    render(selfIn(root([staleVisible])));
    publishedOnlyNothing();
    expect(measureInWindow).not.toHaveBeenCalled();
  });
});

describe('<BugseeSecure> ancestors cost and failures', () => {
  it('with nothing that clips, a re-measure is one measurement', () => {
    render(selfIn(root([view([view([self()])], { style: { overflow: 'visible' } })])));
    const before = measureInWindow.mock.calls.length;

    tick(4);

    expect(measureInWindow.mock.calls.length - before).toBe(4);
    expect(renderer.measures).toEqual([]);
  });

  it('with no fiber at all, a re-measure is one measurement', () => {
    render(undefined);
    const before = measureInWindow.mock.calls.length;

    tick(3);

    expect(measureInWindow.mock.calls.length - before).toBe(3);
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('reads its ancestors once per mount, however often it measures', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 800), [self()])]));
    const parent = fiber.return;
    let reads = 0;
    Object.defineProperty(fiber, 'return', {
      get(): FiberLike | null {
        reads += 1;
        return parent;
      },
    });
    const testRenderer = render(fiber);
    // One walk for the surface, one for the ancestry.
    expect(reads).toBe(2);

    tick(5);
    expect(reads).toBe(2);
    expect(renderer.lookups).toHaveLength(1);

    act(() => testRenderer.update(<BugseeSecure enabled={false} />));
    act(() => testRenderer.update(<BugseeSecure enabled />));
    expect(reads).toBe(4);
  });

  it('an ancestor whose measurement throws leaves the whole view masked', () => {
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [self()])])));
    renderer.getPublicInstanceFromInternalInstanceHandle = () => ({
      measureInWindow: () => {
        throw new Error('detached');
      },
    });

    // The instance is looked up once; a fresh mount looks it up again.
    act(() => mounted.forEach((mountedRenderer) => mountedRenderer.unmount()));
    mounted = [];
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [self()])])));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('an ancestor that never answers leaves the whole view masked', () => {
    render(selfIn(root([scrollView(null, [self()])])));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it("the view's own failed measurement keeps the last rectangle", () => {
    render(selfIn(root([scrollView(rect(0, 0, 400, 130), [self()])])));
    native.setSecureRectangles.mockClear();

    selfRect = rect(Number.NaN, 100, 200, 50);
    tick(2);

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });

  it('an ancestor that throws while its props are read hides nothing', () => {
    const fiber = selfIn(root([offscreen(0, [view([self()])])]));
    commitProps(ancestorOfType(fiber, 'RCTView'), {
      get style(): never {
        throw new Error('torn props');
      },
    });
    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  // A Modal's content is its own surface: nothing outside it clips or hides
  // what is inside.
  it('stops at the Modal it is in', () => {
    const modal = {
      ...fabricHost(MODAL_HOST_TYPE, rect(0, 0, 400, 800), {}, [view([self()])]),
      stateNode: { tag: 56, rect: null, canonical: { currentProps: {} } },
    };
    const hiding = { style: { display: 'none', overflow: 'hidden' } };
    const outside = fabricHost('RCTView', rect(0, 0, 1, 1), hiding, [modal]);
    render(selfIn(root([scrollView(rect(0, 0, 1, 1), [outside])])));

    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(0, 56, px(selfRect));
    expect(renderer.measures).toEqual([]);
  });
});
