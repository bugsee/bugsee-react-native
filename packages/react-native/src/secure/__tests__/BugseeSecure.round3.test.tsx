/**
 * Round 3 of the review of #87 (#86). The shadow tree leads what native
 * draws, so coverage is added at once and removed only after
 * SECURE_SHRINK_HOLD_MS; a static clipped or hidden view costs nothing per
 * frame beyond its share of a watched ScrollView; and the walk's last gaps
 * are closed. Each test failed against 42eb416, except the controls marked
 * so.
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { BugseeSecure } from '../BugseeSecure';
import { SECURE_TRANSITION_HOLD_MS } from '../transition';
import { SCREEN_HOST_TYPE } from '../ancestry';
import { SECURE_SHRINK_HOLD_MS } from '../hold';
import { native } from '../../__mocks__/native';
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import {
  ancestorOfType,
  commitProps,
  fabricHost,
  fakeRenderer,
  moveTo,
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
  // What an unmount leaves held runs out on the tick.
  act(() => {
    jest.advanceTimersByTime(SECURE_TRANSITION_HOLD_MS + 200);
  });
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


function frames(count = 1): void {
  act(() => {
    jest.advanceTimersByTime(16 * count);
  });
}

function wait(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** Mounts one BugseeSecure per fiber, each backed by its own. */
function renderAll(fibers: FiberLike[]): void {
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
}

/** The first rectangle of the last publish on display 0, as [left, top, right, bottom]. */
const firstPublished = (): number[] => (native.setSecureRectangles.mock.lastCall?.[1] as number[]).slice(0, 4);

/** Every rectangle list that reached the bridge on display 0, in order. */
const publishes = (): unknown[] => native.setSecureRectangles.mock.calls.map(([, flat]) => flat);

/** A secure view under an RNSScreen with committed `activityState`, in a container. */
function underScreen(activityState: number): FiberLike {
  const screen = fabricHost(SCREEN_HOST_TYPE, rect(0, 0, 400, 800), { activityState }, [view([self()])]);
  return selfIn(root([screenContainer([screen])]));
}

describe('P1: coverage is added at once and removed late', () => {
  it('a clipping ancestor that shrinks keeps the old rectangle until the hold expires', () => {
    const clipping = fabricHost('RCTView', rect(0, 0, 400, 800), { style: { overflow: 'hidden' } }, [self()]);
    const fiber = selfIn(root([clipping]));
    render(fiber);

    moveTo(ancestorOfType(fiber, 'RCTView'), rect(0, 0, 400, 120));
    tick();
    expect(lastPublished()).toEqual([0, [...px(rect(10, 100, 200, 20)), ...px(selfRect)]]);

    wait(SECURE_SHRINK_HOLD_MS - 200);
    expect(lastPublished()).toEqual([0, [...px(rect(10, 100, 200, 20)), ...px(selfRect)]]);
    wait(400);
    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 20))]);
  });

  it('an inactive screen withdraws the view only after it has been hidden for the hold', () => {
    const fiber = underScreen(2);
    render(fiber);

    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 });
    tick();
    wait(SECURE_SHRINK_HOLD_MS - 200);
    expect(lastPublished()).toEqual([0, px(selfRect)]);

    wait(400);
    expect(lastPublished()).toEqual([0, []]);
  });

  it('hidden and shown again within the hold, it is never withdrawn', () => {
    const fiber = underScreen(2);
    render(fiber);

    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 });
    tick();
    wait(250);
    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 2 });
    frames();
    wait(1_000);

    expect(publishes().some((flat) => (flat as unknown[]).length === 0)).toBe(false);
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('growth is never delayed (control)', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    render(fiber);

    moveTo(ancestorOfType(fiber, 'RCTScrollView'), rect(0, 0, 400, 800));
    frames();

    expect(firstPublished()).toEqual(px(selfRect));
  });

  it('unmounting and disabling still clear at once (control)', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 800), [self()])]));
    const testRenderer = render(fiber);
    moveTo(ancestorOfType(fiber, 'RCTScrollView'), rect(0, 0, 400, 120));
    tick();

    act(() => testRenderer.update(<BugseeSecure enabled={false} />));

    expect(lastPublished()).toEqual([0, []]);
  });
});

describe('P2: a static clipped or hidden view costs nothing per frame', () => {
  it('many still, clipped views measure nothing per frame but their shared ScrollView content', () => {
    const fibers = selvesIn(root([scrollView(rect(0, 0, 400, 120), Array.from({ length: 20 }, () => self()))]));
    renderAll(fibers);
    // Settle: STEADY_FRAMES still frames, then parked; then just past the tick
    // at 200 ms, so the five frames below (to 285 ms) hold no tick.
    frames(12);
    wait(13);
    const selfBefore = measureInWindow.mock.calls.length;
    const ancestorsBefore = renderer.measures.length;

    frames(5);

    expect(measureInWindow.mock.calls.length - selfBefore).toBe(0);
    // The ScrollView's content and the ScrollView itself, watched once a frame.
    expect(renderer.measures.slice(ancestorsBefore).map((fiber) => fiber.type)).toEqual(
      // Android's vertical ScrollView: its content container is the `RCTView` host the `View` component renders.
      Array(5).fill(['RCTView', 'RCTScrollView']).flat(),
    );
  });

  it('R4-1: a parked view is woken, and follows, the frame its (Android, vertical) ScrollView content moves', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    render(fiber);
    // Parked, and just past the 200 ms tick: the frame below holds no tick.
    frames(12);
    wait(13);

    // The content container's host, below the `View` component.
    moveTo(ancestorOfType(fiber, 'RCTView'), rect(0, -5040, 400, 9000));
    selfRect = rect(10, 60, 200, 50);
    const before = measureInWindow.mock.calls.length;
    frames();

    expect(measureInWindow.mock.calls.length - before).toBe(1);

    expect(firstPublished()).toEqual(px(rect(10, 60, 200, 50)));
  });

  it('the tick re-checks every parked view, by measuring each alone', () => {
    const fibers = selvesIn(root([scrollView(rect(0, 0, 400, 120), Array.from({ length: 40 }, () => self()))]));
    renderAll(fibers);
    frames(12);
    wait(100);
    const selfBefore = measureInWindow.mock.calls.length;

    wait(100);

    expect(measureInWindow.mock.calls.length - selfBefore).toBe(40);
  });

  it('a layout event on a parked view that did not move leaves it parked', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    const testRenderer = render(fiber);
    frames(12);
    wait(13);

    const view = testRenderer.root.findByType('View' as never);
    act(() => view.props.onLayout({ nativeEvent: {} }));
    const before = measureInWindow.mock.calls.length;
    frames(5);

    expect(measureInWindow.mock.calls.length).toBe(before);
  });

  it('a parked view the tick finds moved is measured again (control)', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    render(fiber);
    frames(12);

    selfRect = rect(10, 80, 200, 50);
    tick();

    expect(firstPublished()).toEqual(px(rect(10, 80, 200, 40)));
  });

  it('hidden views ask only about their screen each frame, not about what is below it', () => {
    const views = Array.from({ length: 10 }, () => view([self()]));
    const screen = fabricHost(SCREEN_HOST_TYPE, null, { activityState: 0 }, views);
    const fibers = selvesIn(root([screenContainer([screen])]));
    renderAll(fibers);
    const screenFiber = ancestorOfType(fibers[0]!, SCREEN_HOST_TYPE);
    const children = screenFiber.child;
    let reads = 0;
    Object.defineProperty(screenFiber, 'child', {
      get(): FiberLike | null {
        reads += 1;
        return children;
      },
    });

    frames(5);

    expect(reads).toBe(0);
    expect(measureInWindow).not.toHaveBeenCalled();
  });
});

// Cursor review of ec4913f: a parked view must still be hidden by a
// screen going inactive, and must follow its viewport growing.
describe('parked views', () => {
  it('a parked view under a screen that goes inactive is withdrawn after the hold', () => {
    const screen = fabricHost(SCREEN_HOST_TYPE, rect(0, 0, 400, 800), { activityState: 2 }, [
      scrollView(rect(0, 0, 400, 120), [self()]),
    ]);
    const fiber = selfIn(root([screenContainer([screen])]));
    render(fiber);
    frames(12);
    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 20))]);

    commitProps(ancestorOfType(fiber, SCREEN_HOST_TYPE), { activityState: 0 });
    frames();
    const before = measureInWindow.mock.calls.length;
    wait(SECURE_SHRINK_HOLD_MS + 200);

    expect(lastPublished()).toEqual([0, []]);
    // Hidden: measured no more.
    expect(measureInWindow.mock.calls.length).toBe(before);
  });

  it('a parked view follows its ScrollView viewport growing, within a frame', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    render(fiber);
    frames(12);
    wait(13);

    // The viewport grows; the content does not move, the view does not lay out.
    moveTo(ancestorOfType(fiber, 'RCTScrollView'), rect(0, 0, 400, 800));
    frames();

    expect(firstPublished()).toEqual(px(selfRect));
  });
});

describe('P3: the walk and the loop', () => {
  it('(1) nothing above a HostPortal clips the view', () => {
    const portal = { tag: FiberTag.HostPortal, type: null, children: [view([self()])] };
    render(selfIn(root([scrollView(rect(0, 0, 400, 110), [portal])])));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('(4) activityState 0 hides nothing outside a screens container', () => {
    const screen = fabricHost(SCREEN_HOST_TYPE, rect(0, 0, 400, 800), { activityState: 0 }, [view([self()])]);
    render(selfIn(root([view([screen])])));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('(5) stays on the per-frame re-measure until still for STEADY_FRAMES frames', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    render(fiber);
    // Wholly visible now: still measured every frame, until it has stayed put.
    moveTo(ancestorOfType(fiber, 'RCTScrollView'), rect(0, 0, 400, 800));
    frames();
    const before = measureInWindow.mock.calls.length;

    frames(5);
    expect(measureInWindow.mock.calls.length - before).toBe(5);
    frames(10);
    // To 288 ms: frames, and no tick (the next is at 300 ms).
    const settled = measureInWindow.mock.calls.length;
    frames(2);
    expect(measureInWindow.mock.calls.length).toBe(settled);
  });

  it('(6) nothing above a react-native-screens form sheet host clips the view', () => {
    const sheet = fabricHost('RNSFormSheetHost', rect(0, 0, 400, 800), {}, [view([self()])]);
    render(selfIn(root([scrollView(rect(0, 0, 400, 110), [sheet])])));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});
