/**
 * Follow-up to #87: a `<BugseeSecure>` drawn where nothing masks it during
 * native transitions (the Android deep test, phase 1). Each test states the
 * correct behaviour and failed on 58dc051:
 *  - W1: a popped react-native-screens screen is drawn sliding out after
 *    React unmounted it, and the box was withdrawn at once;
 *  - C3: a `<Modal animationType="slide">` draws its content below where it
 *    is laid out while it slides in, and lays it out again once the dialog is
 *    up, which only the next 100 ms tick saw;
 *  - B6: a native-driven `Animated` transform never reaches the shadow tree,
 *    so the mask stayed where React last rendered the view.
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { BugseeSecure } from '../BugseeSecure';
import { SCREEN_HOST_TYPE } from '../ancestry';
import { SECURE_SHRINK_HOLD_MS } from '../hold';
import { SECURE_TRANSITION_HOLD_MS, WHOLE_SURFACE } from '../transition';
import { native } from '../../__mocks__/native';
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import type { FiberSpec } from '../../viewtree/__tests__/fakeFibers';
import {
  ancestorOfType,
  composite,
  fabricHost,
  fakeRenderer,
  pairWith,
  rect,
  root,
  scrollView,
  self,
  selfIn,
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
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  getPublicInstanceFromInternalInstanceHandle: (fiber: FiberLike) =>
    renderer.getPublicInstanceFromInternalInstanceHandle(fiber),
}));

// See BugseeSecure.test.tsx: React Native's own test-environment flags.
(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Callback = (x: number, y: number, width: number, height: number) => void;

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
  wait(SECURE_TRANSITION_HOLD_MS + 200);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function render(fiber: FiberLike, element: ReactElement = <BugseeSecure />): ReactTestRenderer {
  let testRenderer: ReactTestRenderer | undefined;
  act(() => {
    testRenderer = create(element, {
      createNodeMock: () => ({ measureInWindow, __internalInstanceHandle: fiber }),
      unstable_isConcurrent: true,
    } as Parameters<typeof create>[1]);
  });
  mounted.push(testRenderer as ReactTestRenderer);
  return testRenderer as ReactTestRenderer;
}

function unmount(testRenderer: ReactTestRenderer): void {
  act(() => testRenderer.unmount());
  mounted = mounted.filter((entry) => entry !== testRenderer);
}

function wait(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** A window rectangle in points as the registry publishes it, at PixelRatio 2. */
const px = ({ x, y, width, height }: WindowRect): number[] => [2 * x, 2 * y, 2 * (x + width), 2 * (y + height)];

const lastPublished = (): unknown => native.setSecureRectangles.mock.lastCall;
const lastOnSurface = (): unknown => native.setSecureRectanglesOnSurface.mock.lastCall;

/** Gives every fiber on the way up from `fiber` an alternate: it existed before the commit running now. */
function existing(fiber: FiberLike): FiberLike {
  for (let current = fiber.return; current !== null; current = current.return) {
    current.alternate ??= { ...current, alternate: current };
  }
  return fiber;
}

/** Gives `ancestor` and every fiber above it an alternate: they were there before the commit running now. */
function existingFrom(ancestor: FiberLike): void {
  for (let current: FiberLike | null = ancestor; current !== null; current = current.return) {
    current.alternate ??= { ...current, alternate: current };
  }
}

/** Marks `fiber` deleted from its parent by the commit running now, as React lists it. */
function deleting(fiber: FiberLike): void {
  (fiber.return as FiberLike & { deletions?: FiberLike[] }).deletions = [fiber];
}

const SCREEN = rect(0, 0, 400, 800);

/** The view on a screen in a react-native-screens stack (or `container`). */
function onStackScreen(container = 'RNSScreenStack', inner: FiberSpec[] = [view([self()])]): FiberLike {
  const screen = fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, inner);
  return selfIn(root([fabricHost(container, null, {}, [screen])]));
}

const MODAL_TAG = 42;

/** The view in a `<Modal>` with `props`, its content `content`. */
function inModal(props: Record<string, unknown>, content = rect(0, 0, 400, 800)): FiberLike {
  const fiber = selfIn(
    root([
      view([
        {
          tag: FiberTag.HostComponent,
          type: 'RCTModalHostView',
          memoizedProps: props,
          stateNode: { rect: null, tag: MODAL_TAG, canonical: { currentProps: props } },
          children: [fabricHost('RCTView', content, {}, [view([self()])])],
        },
      ]),
    ]),
  );
  // The screen that opens it was there before.
  existingFrom(ancestorOfType(ancestorOfType(fiber, 'RCTModalHostView'), 'RCTView'));
  return fiber;
}

describe('W1: a screen popped off a stack', () => {
  it('covers the whole screen from the unmount until the transition hold is over', () => {
    const fiber = existing(onStackScreen());
    const testRenderer = render(fiber);
    expect(lastPublished()).toEqual([0, px(selfRect)]);

    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));
    unmount(testRenderer);

    // Popped: still drawn, sliding or scaling inside the screen's bounds.
    expect(lastPublished()).toEqual([0, [...px(SCREEN), ...px(selfRect)]]);
    wait(SECURE_TRANSITION_HOLD_MS - 100);
    expect((lastPublished() as [number, number[]])[1].slice(0, 4)).toEqual(px(SCREEN));
    wait(200);
    expect(lastPublished()).toEqual([0, []]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('covers the screen when what is deleted is above it', () => {
    const fiber = selfIn(
      root([
        fabricHost('RNSScreenStack', null, {}, [
          composite([fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])])]),
        ]),
      ]),
    );
    existing(fiber);
    const testRenderer = render(fiber);

    // The stack item wrapping the screen, as native-stack removes a route.
    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE).return as FiberLike);
    unmount(testRenderer);

    expect(lastPublished()).toEqual([0, [...px(SCREEN), ...px(selfRect)]]);
  });

  it('reads the deletion from either fiber of the parent pair', () => {
    const fiber = existing(onStackScreen());
    const testRenderer = render(fiber);
    const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);
    // The commit finished the stack's other fiber: that one lists the deletion.
    ((screen.return as FiberLike).alternate as FiberLike & { deletions?: FiberLike[] }).deletions = [
      screen.alternate as FiberLike,
    ];

    unmount(testRenderer);

    expect(lastPublished()).toEqual([0, [...px(SCREEN), ...px(selfRect)]]);
  });

  it('covers the whole surface when the departing screen cannot be measured', () => {
    const fiber = existing(onStackScreen());
    const testRenderer = render(fiber);
    const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);
    (screen.stateNode as { rect: WindowRect | null }).rect = rect(0, 0, 0, 0);

    deleting(screen);
    unmount(testRenderer);

    expect(lastPublished()).toEqual([0, [...px(WHOLE_SURFACE), ...px(selfRect)]]);
  });

  it('a view removed from a screen that stays holds only itself, for the shrink hold', () => {
    const fiber = existing(onStackScreen());
    const testRenderer = render(fiber);

    deleting(ancestorOfType(fiber, 'RCTView'));
    unmount(testRenderer);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
    wait(SECURE_SHRINK_HOLD_MS + 100);
    expect(lastPublished()).toEqual([0, []]);
  });

  it('a screen removed from a tab container is not carried: it holds only itself', () => {
    const fiber = existing(onStackScreen('RNSScreenContainer'));
    const testRenderer = render(fiber);

    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));
    unmount(testRenderer);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('enabled={false} still clears at once, on a screen being popped', () => {
    const fiber = existing(onStackScreen());
    const testRenderer = render(fiber);
    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));

    act(() => testRenderer.update(<BugseeSecure enabled={false} />));

    expect(lastPublished()).toEqual([0, []]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a disabled view unmounts with nothing to hold', () => {
    const fiber = existing(onStackScreen());
    const testRenderer = render(fiber, <BugseeSecure enabled={false} />);
    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));

    unmount(testRenderer);

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('a screen pushed onto a stack', () => {
  it('covers the whole screen as it is carried in, then only the view', () => {
    // The stack was there; the push created the screen.
    const fiber = onStackScreen();
    existingFrom(ancestorOfType(fiber, 'RNSScreenStack'));
    render(fiber);

    expect(lastPublished()).toEqual([0, [...px(SCREEN), ...px(selfRect)]]);
    wait(SECURE_TRANSITION_HOLD_MS + 100);
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('the first screen of a stack mounted with it (an app starting) covers only the view', () => {
    render(onStackScreen());

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('a view mounted on a screen that was already there covers only itself', () => {
    const fiber = existing(onStackScreen());
    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});

describe('C3: a Modal sliding in and out', () => {
  it('a Modal mounted with the whole tree (open as the app starts) is not carried', () => {
    const fiber = inModal({ animationType: 'slide' });
    for (let current = fiber.return; current !== null; current = current.return) {
      current.alternate = null;
    }
    render(fiber);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });

  it('a view not laid out yet covers no band; the band follows it once it is', () => {
    selfRect = rect(0, 0, 0, 0);
    render(inModal({ animationType: 'slide' }));
    // Nothing to publish: the lane stays as the last test left it, empty.
    expect(native.setSecureRectanglesOnSurface).not.toHaveBeenCalled();

    selfRect = rect(10, 100, 200, 50);
    wait(17);

    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(band(selfRect)));
  });

  // The band below the view, as far as any surface reaches.
  const band = (at: WindowRect): WindowRect => ({ ...at, height: WHOLE_SURFACE.height - at.y });

  it('covers the band it slides in along as it opens, then only the view', () => {
    render(inModal({ animationType: 'slide' }));

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(band(selfRect)), ...px(selfRect)]]);
    wait(SECURE_TRANSITION_HOLD_MS + 100);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });

  it('follows the content laid out again once the dialog is up, within a frame', () => {
    render(inModal({ animationType: 'slide' }));

    // The dialog reports its real size: the content is centred lower.
    const before = selfRect;
    selfRect = rect(10, 163, 200, 50);
    wait(17);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(band(before)), ...px(selfRect), ...px(before)]]);
  });

  it('a band that moves as the content is laid out again covers both, joined', () => {
    render(inModal({ animationType: 'slide' }));

    const before = selfRect;
    selfRect = rect(5, 60, 200, 50);
    wait(17);

    // From the left of the second to the right of the first, from the top of the second down.
    const joined = { x: 5, y: 60, width: 205, height: WHOLE_SURFACE.height - 60 };
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(joined), ...px(selfRect), ...px(before)]]);

    // And again, further right: the join grows to its right edge.
    selfRect = rect(40, 60, 200, 50);
    wait(17);
    const wider = { ...joined, width: 235 };
    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(wider));
  });

  it('a fade Modal opening covers only the view, still followed every frame', () => {
    render(inModal({ animationType: 'fade' }));
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);

    const before = selfRect;
    selfRect = rect(10, 163, 200, 50);
    wait(17);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(selfRect), ...px(before)]]);
  });

  it('a view mounted in a Modal that was already open is not carried', () => {
    render(existing(inModal({ animationType: 'slide' })));

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });

  it('covers the band it slides out along as it closes', () => {
    const fiber = existing(inModal({ animationType: 'slide' }));
    const testRenderer = render(fiber);

    deleting(ancestorOfType(fiber, 'RCTModalHostView'));
    unmount(testRenderer);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(band(selfRect)), ...px(selfRect)]]);
    wait(SECURE_TRANSITION_HOLD_MS - 100);
    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(band(selfRect)));
    wait(200);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, []]);
  });

  it('a fading Modal holds the view where it rests as it closes', () => {
    const fiber = existing(inModal({ animationType: 'fade' }));
    const testRenderer = render(fiber);

    deleting(ancestorOfType(fiber, 'RCTModalHostView'));
    unmount(testRenderer);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
    wait(SECURE_SHRINK_HOLD_MS + 100);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, []]);
  });

  it('covers the band from the commit that hides a Modal still mounted (iOS), within a frame', () => {
    const fiber = existing(inModal({ animationType: 'slide', visible: true }));
    render(fiber);
    wait(16 * 20);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);

    // visible={false}: the host stays mounted until onDismiss, sliding out.
    ancestorOfType(fiber, 'RCTModalHostView').memoizedProps = { animationType: 'slide', visible: false };
    wait(17);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(band(selfRect)), ...px(selfRect)]]);

    // Covered once per close, until the transition hold runs out.
    wait(SECURE_TRANSITION_HOLD_MS + 100);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });

  /** The view on a screen of a `container` inside a `<Modal>` with `props`, every ancestor there before. */
  function onScreenInModal(container: string, activityState: number, props: Record<string, unknown>): FiberLike {
    const screen = fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState }, [view([self()])]);
    return existing(
      selfIn(
        root([
          view([
            {
              tag: FiberTag.HostComponent,
              type: 'RCTModalHostView',
              memoizedProps: props,
              stateNode: { rect: null, tag: MODAL_TAG, canonical: { currentProps: props } },
              children: [fabricHost('RCTView', rect(0, 0, 400, 800), {}, [fabricHost(container, null, {}, [screen])])],
            },
          ]),
        ]),
      ),
    );
  }

  it('a Modal hidden on a still-mounted host is covered even for a view hidden as it mounted', () => {
    const fiber = onScreenInModal('RNSScreenContainer', 0, { animationType: 'slide', visible: true });
    render(fiber);
    // Its screen shown later: no arrival ran while it was hidden.
    const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);
    screen.memoizedProps = { activityState: 2 };
    wait(17);
    wait(16 * 20);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);

    ancestorOfType(fiber, 'RCTModalHostView').memoizedProps = { animationType: 'slide', visible: false };
    wait(17);

    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(band(selfRect)));
  });

  it('a Modal hidden on a still-mounted host is covered for a view on a stack inside it', () => {
    const fiber = onScreenInModal('RNSScreenStack', 2, { animationType: 'slide', visible: true });
    render(fiber);
    wait(16 * 20);

    ancestorOfType(fiber, 'RCTModalHostView').memoizedProps = { animationType: 'slide', visible: false };
    wait(17);

    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(band(selfRect)));
  });

  it('a view mounted in a Modal already closing (iOS) covers the band at once', () => {
    render(existing(inModal({ animationType: 'slide', visible: false })));

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(band(selfRect)), ...px(selfRect)]]);
  });

  it('re-enabled while its Modal closes, it covers the band again', () => {
    const fiber = existing(inModal({ animationType: 'slide', visible: true }));
    const testRenderer = render(fiber);
    ancestorOfType(fiber, 'RCTModalHostView').memoizedProps = { animationType: 'slide', visible: false };
    wait(17);

    act(() => testRenderer.update(<BugseeSecure enabled={false} />));
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, []]);
    act(() => testRenderer.update(<BugseeSecure enabled />));

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(band(selfRect)), ...px(selfRect)]]);
  });

  it('a fading Modal hidden while mounted adds no band, and the view is still followed', () => {
    const fiber = existing(inModal({ animationType: 'fade', visible: true }));
    render(fiber);
    ancestorOfType(fiber, 'RCTModalHostView').memoizedProps = { animationType: 'fade', visible: false };
    wait(17);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);

    const before = selfRect;
    selfRect = rect(10, 300, 200, 50);
    wait(100);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(selfRect), ...px(before)]]);
  });

  it('a view hidden as a Modal opens is not carried in once shown later', () => {
    const fiber = onScreenInModal('RNSScreenContainer', 0, { animationType: 'slide', visible: true });
    // The Modal was created by the commit that mounted the view; the screen that opened it was there.
    const host = ancestorOfType(fiber, 'RCTModalHostView');
    for (let current: FiberLike | null = host; current !== null; current = current.child) {
      current.alternate = null;
    }
    render(fiber);
    ancestorOfType(fiber, SCREEN_HOST_TYPE).memoizedProps = { activityState: 2 };
    wait(17);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });

  it('a stack inside a slide Modal opening covers the band as well as the screen', () => {
    const fiber = onScreenInModal('RNSScreenStack', 2, { animationType: 'slide', visible: true });
    // The Modal and everything in it are new; what opened it was there.
    const host = ancestorOfType(fiber, 'RCTModalHostView');
    for (let current: FiberLike | null = host; current !== null; current = current.child) {
      current.alternate = null;
    }
    render(fiber);

    const joined = { x: 0, y: 0, width: 400, height: WHOLE_SURFACE.height };
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(joined), ...px(selfRect)]]);
  });

  it('a stack inside a slide Modal closing covers the band as well as the screen', () => {
    const fiber = onScreenInModal('RNSScreenStack', 2, { animationType: 'slide', visible: true });
    const testRenderer = render(fiber);

    deleting(ancestorOfType(fiber, 'RCTModalHostView'));
    unmount(testRenderer);

    const joined = { x: 0, y: 0, width: 400, height: WHOLE_SURFACE.height };
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, [...px(joined), ...px(selfRect)]]);
  });

  it('a Modal without animation holds only the view as it closes', () => {
    const fiber = existing(inModal({ animationType: 'none' }));
    const testRenderer = render(fiber);

    deleting(ancestorOfType(fiber, 'RCTModalHostView'));
    unmount(testRenderer);
    wait(SECURE_SHRINK_HOLD_MS + 100);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, []]);
  });
});

/** A stand-in for an `Animated.Value`. */
interface FakeValue {
  __isNative: boolean;
  _value: number;
  _offset: number;
  _animation: { _fromValue: number; _toValue: number; _easing: (t: number) => number } | null;
  __getValue: () => number;
}

function animatedValue(value: number, isNative = true): FakeValue {
  const node: FakeValue = {
    __isNative: isNative,
    _value: value,
    _offset: 0,
    _animation: null,
    __getValue: () => node._value + node._offset,
  };
  return node;
}

/** A stand-in for `value.interpolate({ inputRange, outputRange })`, extending past its ends. */
function interpolation(parent: FakeValue, inputRange: number[], outputRange: number[]): object {
  const interpolate = (input: number): number => {
    const [i0, i1] = inputRange as [number, number];
    const [o0, o1] = outputRange as [number, number];
    return o0 + ((input - i0) * (o1 - o0)) / (i1 - i0);
  };
  return {
    __isNative: parent.__isNative,
    _parent: parent,
    _config: { inputRange, outputRange },
    _getInterpolation: () => interpolate,
    __getValue: () => interpolate(parent.__getValue()),
  };
}

const AnimatedView = Object.assign(() => null, { displayName: 'Animated(View)' });

/**
 * The view under an `Animated.View` styled `transform`, which renders the
 * host `RCTView` measured at `animatedRect` with `rendered` as its transform.
 */
function underAnimated(
  transform: Array<Record<string, unknown>>,
  rendered: Array<Record<string, unknown>>,
  animatedRect = rect(0, 0, 400, 800),
  outer: (spec: FiberSpec) => FiberSpec = (spec) => spec,
  inner: (spec: FiberSpec) => FiberSpec = (spec) => spec,
): FiberLike {
  return existing(
    selfIn(
      root([
        outer({
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform } },
          children: [fabricHost('RCTView', animatedRect, { style: { transform: rendered } }, [inner(view([self()]))])],
        }),
      ]),
    ),
  );
}

describe('B6: a native-driven Animated transform above the view', () => {
  it('covers every place an interpolated translateX can draw it', () => {
    const value = animatedValue(0);
    value._animation = { _fromValue: 0, _toValue: 1, _easing: (t) => t };
    render(underAnimated([{ translateX: interpolation(value, [0, 1], [0, 160]) }], [{ translateX: 0 }]));

    expect(lastPublished()).toEqual([0, px(rect(10, 100, 360, 50))]);
  });

  it('follows a value stopped part-way, which the shadow tree never saw', () => {
    const value = animatedValue(0);
    render(underAnimated([{ translateY: value }], [{ translateY: 0 }]));

    // Stopped at 40: native synced the value back to JS, not to the shadow tree.
    value._value = 40;
    wait(100);

    expect(lastPublished()).toEqual([0, [...px(rect(10, 140, 200, 50)), ...px(selfRect)]]);
  });

  it('covers a running timing animation from end to end, and follows it every frame', () => {
    const value = animatedValue(0);
    render(underAnimated([{ translateY: value }], [{ translateY: 0 }]));
    const measures = measureInWindow.mock.calls.length;

    value._animation = { _fromValue: 0, _toValue: 100, _easing: (t) => t };
    wait(100);
    expect(lastPublished()).toEqual([0, [...px(rect(10, 100, 200, 150)), ...px(selfRect)]]);

    // Running: measured every frame, however still the shadow tree is.
    wait(16 * 20);
    expect(measureInWindow.mock.calls.length - measures).toBeGreaterThanOrEqual(20);
  });

  it('follows a still value that jumps (a loop restarting), within a frame', () => {
    const value = animatedValue(160);
    render(underAnimated([{ translateX: value }], [{ translateX: 0 }]));
    wait(16 * 20);
    expect(lastPublished()).toEqual([0, px(rect(170, 100, 200, 50))]);

    // `Animated.loop` resets the value before each iteration: native draws it there at once.
    value._value = 0;
    wait(17);

    expect((lastPublished() as [number, number[]])[1].slice(0, 4)).toEqual(px(selfRect));
  });

  it('a clipped, still view under an Animated component follows a native animation that starts later', () => {
    // JS-driven so far (in the shadow tree), and the view half cut by a ScrollView above.
    const value = animatedValue(0, false);
    render(
      underAnimated([{ translateY: value }], [{ translateY: 0 }], undefined, (spec) =>
        scrollView(rect(0, 0, 400, 125), [spec]),
      ),
    );
    wait(16 * 20);
    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 25))]);

    // Now driven natively: the view slides up, into the viewport, with no layout and no scroll.
    value.__isNative = true;
    value._value = -60;
    wait(17);

    expect((lastPublished() as [number, number[]])[1].slice(0, 4)).toEqual(px(rect(10, 40, 200, 50)));
  });

  it('includes what an easing overshoots', () => {
    const value = animatedValue(0);
    value._animation = { _fromValue: 0, _toValue: 100, _easing: (t) => t * (1.2 - 0.2 * t) * (t < 0.5 ? 1 : 1.25) };
    render(underAnimated([{ translateX: value }], [{ translateX: 0 }]));

    const published = (lastPublished() as [number, number[]])[1];
    expect(published[2]).toBeGreaterThan(2 * (10 + 200 + 100));
  });

  it('measures from the value React last rendered, not from zero', () => {
    const value = animatedValue(30);
    render(underAnimated([{ translateX: value }], [{ translateX: 20 }]));

    expect(lastPublished()).toEqual([0, px(rect(20, 100, 200, 50))]);
  });

  it('scales about the animated view’s centre', () => {
    const value = animatedValue(2);
    render(underAnimated([{ scale: value }], [{ scale: 1 }], rect(0, 0, 400, 400)));

    // Drawn at twice the size about (200, 200): x 10..210 to -180..220, y 100..150 to 0..100.
    expect(lastPublished()).toEqual([0, px(rect(-180, 0, 400, 100))]);
  });

  it('covers the whole surface for a transform it cannot bound, cut by a clipping ancestor above', () => {
    render(
      underAnimated([{ rotate: animatedValue(1) }], [{ rotate: '0deg' }], undefined, (spec) =>
        scrollView(rect(0, 50, 400, 300), [spec]),
      ),
    );

    expect(lastPublished()).toEqual([0, px(rect(0, 50, 400, 300))]);
  });

  it('a clipping ancestor below the transform does not cut where it draws the view', () => {
    const value = animatedValue(0);
    value._animation = { _fromValue: 0, _toValue: 1, _easing: (t) => t };
    render(
      underAnimated(
        [{ translateY: interpolation(value, [0, 1], [0, 300]) }],
        [{ translateY: 0 }],
        undefined,
        undefined,
        (spec) => scrollView(rect(0, 0, 400, 130), [spec]),
      ),
    );

    // The ScrollView moves with the transform: the whole path stays covered.
    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 350))]);
  });

  it('a JS-driven transform is in the shadow tree already, and changes nothing', () => {
    render(underAnimated([{ translateX: animatedValue(80, false) }], [{ translateX: 80 }]));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('reads the committed props of the Animated component', () => {
    const value = animatedValue(0);
    const fiber = underAnimated([{ translateX: 5 }], [{ translateX: 5 }]);
    const wrapper = ancestorOfType(fiber, AnimatedView);
    // A render in flight gives it a native transform that has not committed.
    pairWith(wrapper, { style: { transform: [{ translateX: interpolation(value, [0, 1], [0, 160]) }] } });

    render(fiber);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});
