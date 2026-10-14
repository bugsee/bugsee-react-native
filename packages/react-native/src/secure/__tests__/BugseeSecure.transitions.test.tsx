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
import { SECURE_TRANSITION_HOLD_MS, WHOLE_SURFACE, keyOf, noteBirth } from '../transition';
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
  selvesIn,
  view,
} from './fakeAncestors';
import type { FakeRenderer } from './fakeAncestors';

// Android, but for the tests that switch it to iOS (read at use, after this file's imports).
const mockPlatform = { OS: 'android' };
jest.mock('react-native', () => ({
  View: 'View',
  PixelRatio: { get: () => 2 },
  Platform: {
    get OS(): string {
      return mockPlatform.OS;
    },
  },
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

/**
 * Gives every fiber on the way up from `fiber` an alternate: it existed
 * before the commit running now; and its screens and Modal long before, as
 * a view that measured them when they came would have seen.
 */
function existing(fiber: FiberLike): FiberLike {
  for (let current = fiber.return; current !== null; current = current.return) {
    current.alternate ??= { ...current, alternate: current };
    if (CARRIER_TYPES.has(current.type)) {
      noteBirth(keyOf(current), -Infinity);
    }
  }
  return fiber;
}

/** Gives every fiber on the way up from `fiber` an alternate, its screens and Modal never seen come. */
function unseen(fiber: FiberLike): FiberLike {
  for (let current = fiber.return; current !== null; current = current.return) {
    current.alternate ??= { ...current, alternate: current };
  }
  return fiber;
}

const CARRIER_TYPES: ReadonlySet<unknown> = new Set([SCREEN_HOST_TYPE, 'RCTModalHostView']);

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

describe('P2-6: the screen below a push or pop moves too', () => {
  function stackOf(): { a: FiberLike; b: FiberLike } {
    const tree = root([
      fabricHost('RNSScreenStack', null, {}, [
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])]),
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, stackAnimation: 'slide_from_right' }, [
          view([self()]),
        ]),
      ]),
    ]);
    const selves = selvesIn(tree);
    const [a, b] = selves.sort((p, q) => {
      const screen = (fiber: FiberLike): FiberLike => ancestorOfType(fiber, SCREEN_HOST_TYPE);
      return screen(p).sibling === screen(q) ? -1 : 1;
    }) as [FiberLike, FiberLike];
    return { a, b };
  }

  /** The rectangles of the last publish on display 0, as strings. */
  const rects = (): string[] => {
    const published = (lastPublished() as [number, number[]])[1];
    const out: string[] = [];
    for (let index = 0; index < published.length; index += 4) {
      out.push(published.slice(index, index + 4).join());
    }
    return out;
  };
  const BAND = px(rect(0, 100, 400, 50)).join();

  it('a push (sliding sideways) covers the view on the screen below with its band, for the transition hold', () => {
    const { a, b } = stackOf();
    existing(a);
    // The pushed screen, and what is in it, are new.
    const pushed = ancestorOfType(b, SCREEN_HOST_TYPE);
    for (let current: FiberLike | null = pushed; current !== null; current = current.child) {
      current.alternate = null;
    }
    render(a);

    render(b);

    // The pushed view's band and the band of the view below.
    expect(rects().filter((entry) => entry === BAND)).toHaveLength(2);
    wait(SECURE_TRANSITION_HOLD_MS + 100);
    expect(rects()).toEqual([px(selfRect).join(), px(selfRect).join()]);
  });

  it('a pop covers the view on the screen it uncovers, and the view below joins every cover it is given', () => {
    const { a, b } = stackOf();
    existing(a);
    existing(b);
    render(a);
    const top = render(b);

    deleting(ancestorOfType(b, SCREEN_HOST_TYPE));
    unmount(top);
    // Told twice (as two views on the popped screen would tell it): one cover, joined.
    expect(rects().filter((entry) => entry === BAND)).toHaveLength(2);
  });

  it('a view on the screen below that is not on screen is told, and covers nothing', () => {
    const { a, b } = stackOf();
    existing(a);
    existing(b);
    render(a);
    const top = render(b);
    // Scrolled away (as a hidden view would be): nothing seen.
    ancestorOfType(a, SCREEN_HOST_TYPE).memoizedProps = { activityState: 0 };
    wait(SECURE_SHRINK_HOLD_MS + 200);
    native.reset();

    deleting(ancestorOfType(b, SCREEN_HOST_TYPE));
    unmount(top);

    expect(rects().filter((entry) => entry === BAND)).toHaveLength(1);
  });
});

describe('P2-6: a screen with no secure view of its own pushed or popped over one with', () => {
  /** The view on the first screen of a stack; `more`: further screens on it, with no secure view. */
  function belowOf(more: FiberSpec[] = []): FiberLike {
    const below = selfIn(
      root([
        fabricHost('RNSScreenStack', null, { children: 1 }, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])]),
          ...more,
        ]),
      ]),
    );
    return existing(below);
  }

  /** Commits `screens` as the stack's screens, after the first, as a push or pop would. */
  function commitScreens(below: FiberLike, screens: FiberSpec[]): void {
    const stack = ancestorOfType(below, 'RNSScreenStack');
    const first = stack.child as FiberLike;
    first.sibling = null;
    let last = first;
    for (const spec of screens) {
      const fiber = { ...fabricHostFiber(spec), return: stack, sibling: null } as FiberLike;
      last.sibling = fiber;
      last = fiber;
    }
    // A new children prop: the stack re-rendered.
    stack.memoizedProps = { children: screens.length + 1 };
  }

  const fabricHostFiber = (spec: FiberSpec): Partial<FiberLike> => ({
    tag: spec.tag,
    type: spec.type,
    memoizedProps: spec.memoizedProps,
    stateNode: spec.stateNode,
    child: null,
  });

  const pushedScreen = (props: Record<string, unknown> = {}): FiberSpec =>
    fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, ...props }, []);

  it('a push covers the view below, within a frame, for the transition hold', () => {
    const below = belowOf();
    render(below);
    // To 212 ms: past the tick at 200, so only the stack's wake can measure it within the next frame.
    wait(212);

    commitScreens(below, [pushedScreen()]);
    wait(17);

    // The default animation: the whole screen below.
    expect(firstPublished()).toEqual(px(SCREEN));
    wait(SECURE_TRANSITION_HOLD_MS + 100);
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('a pop covers the view it uncovers, by the popped screen\'s animation', () => {
    const below = belowOf([pushedScreen({ stackAnimation: 'slide_from_left' })]);
    render(below);
    wait(212);

    commitScreens(below, []);
    wait(17);

    expect(firstPublished()).toEqual(px(rect(0, 100, 400, 50)));
  });

  it('a stack that re-renders with the same screens covers nothing', () => {
    const below = belowOf([pushedScreen()]);
    render(below);
    wait(212);

    ancestorOfType(below, 'RNSScreenStack').memoizedProps = { children: 2 };
    wait(17);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('reads the first screens without covering anything, or warning', () => {
    render(belowOf([pushedScreen()]));
    wait(212);

    expect(lastPublished()).toEqual([0, px(selfRect)]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reads the committed stack, not a stale one the view was mounted under', () => {
    const below = belowOf();
    const stack = ancestorOfType(below, 'RNSScreenStack');
    pairWith(stack, { children: 1 });
    render(below);
    wait(212);

    // Pushed in front, on the committed stack fiber only.
    const pushed = { ...fabricHostFiber(pushedScreen()), return: stack, sibling: stack.child } as FiberLike;
    stack.child = pushed;
    stack.memoizedProps = { children: 2 };
    wait(17);

    expect(firstPublished()).toEqual(px(SCREEN));
  });

  it('forgets the screens it saw once disabled: enabled again, nothing has moved', () => {
    const below = belowOf();
    const testRenderer = render(below);
    wait(212);
    act(() => testRenderer.update(<BugseeSecure enabled={false} />));

    commitScreens(below, [pushedScreen()]);
    wait(SECURE_TRANSITION_HOLD_MS + 100);
    act(() => testRenderer.update(<BugseeSecure enabled />));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('on iOS, a card presented over it scales the screen below: the whole screen', () => {
    mockPlatform.OS = 'ios';
    try {
      const below = belowOf();
      render(below);
      wait(212);

      commitScreens(below, [pushedScreen({ stackPresentation: 'formSheet' })]);
      wait(17);

      // iOS takes points.
      expect((lastPublished() as [number, number[]])[1].slice(0, 4)).toEqual([0, 0, 400, 800]);
    } finally {
      mockPlatform.OS = 'android';
    }
  });

  it('on iOS, a card presented by a view of its own tells the screen below the same', () => {
    mockPlatform.OS = 'ios';
    try {
      const tree = root([
        fabricHost('RNSScreenStack', null, {}, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])]),
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, stackPresentation: 'formSheet' }, [
            view([self()]),
          ]),
        ]),
      ]);
      const selves = selvesIn(tree);
      const low = selves.find((fiber) => ancestorOfType(fiber, SCREEN_HOST_TYPE).sibling !== null) as FiberLike;
      const card = selves.find((fiber) => fiber !== low) as FiberLike;
      existing(low);
      render(low);
      const pushed = ancestorOfType(card, SCREEN_HOST_TYPE);
      for (let current: FiberLike | null = pushed; current !== null; current = current.child) {
        current.alternate = null;
      }
      native.reset();

      render(card);

      // The view below: its whole screen; the card's own view: its column, from where it is down.
      const published = (lastPublished() as [number, number[]])[1];
      const rects: string[] = [];
      for (let index = 0; index < published.length; index += 4) {
        rects.push(published.slice(index, index + 4).join());
      }
      expect(rects).toContain([0, 0, 400, 800].join());
    } finally {
      mockPlatform.OS = 'android';
    }
  });

  it('screens below wrappers (a stack item) are found too', () => {
    const below = belowOf();
    render(below);
    wait(212);

    commitScreens(below, [composite([pushedScreen()])]);
    const item = ancestorOfType(below, 'RNSScreenStack').child?.sibling as FiberLike;
    const screen = { ...fabricHostFiber(pushedScreen()), return: item, sibling: null } as FiberLike;
    item.child = screen;
    wait(17);

    expect(firstPublished()).toEqual(px(SCREEN));
  });

  it('a screen pushed over it while it is still being pushed keeps it covered for the hold from that push', () => {
    const below = selfIn(
      root([
        fabricHost('RNSScreenStack', null, { children: 1 }, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])]),
        ]),
      ]),
    );
    // Its own screen is pushed by the commit that mounts it.
    existingFrom(ancestorOfType(below, 'RNSScreenStack'));
    render(below);
    expect(firstPublished()).toEqual(px(SCREEN));
    wait(400);

    commitScreens(below, [pushedScreen()]);
    wait(17);
    // Past its own push's hold (800 ms from the mount), inside the second push's (800 ms from it).
    wait(SECURE_TRANSITION_HOLD_MS - 300);
    expect(firstPublished()).toEqual(px(SCREEN));

    wait(400);
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});

describe('N3: content that mounts after its screen or Modal came, still in the transition', () => {
  /** A stack of a screen below and a second screen, `b`'s view on the second; `a`'s on the first. */
  function twoScreens(): { a: FiberLike; b: FiberLike; stack: FiberLike; first: FiberLike; second: FiberLike } {
    const tree = root([
      fabricHost('RNSScreenStack', null, { children: 2 }, [
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])]),
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])]),
      ]),
    ]);
    const selves = selvesIn(tree);
    const stack = ancestorOfType(selves[0] as FiberLike, 'RNSScreenStack');
    const first = stack.child as FiberLike;
    const second = first.sibling as FiberLike;
    const on = (screen: FiberLike): FiberLike =>
      selves.find((fiber) => ancestorOfType(fiber, SCREEN_HOST_TYPE) === screen) as FiberLike;
    return { a: on(first), b: on(second), stack, first, second };
  }

  it('a screen pushed with a spinner: its secure content, mounting 200 ms later, is carried in', () => {
    const { b } = twoScreens();
    // The push commit had no secure view; the screen has rendered again since.
    unseen(b);
    wait(200);

    render(b);

    // The default animation: the whole screen, for the hold.
    expect(firstPublished()).toEqual(px(SCREEN));
    wait(SECURE_TRANSITION_HOLD_MS - 100);
    expect(firstPublished()).toEqual(px(SCREEN));
    wait(200);
    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });

  it('seen pushed by a view on the screen below, the late content is carried in from the push, not its mount', () => {
    const { a, b, stack, first, second } = twoScreens();
    // Sliding up: the screen below stays put, so only the pushed screen's own view covers its column.
    second.memoizedProps = { activityState: 2, stackAnimation: 'slide_from_bottom' };
    // Not pushed yet.
    first.sibling = null;
    stack.memoizedProps = { children: 1 };
    existing(a);
    unseen(b);
    render(a);
    wait(212);

    first.sibling = second;
    stack.memoizedProps = { children: 2 };
    wait(17);
    wait(200);
    render(b);
    const column = px({ ...selfRect, height: SCREEN.height - selfRect.y }).join();
    const published = (): string => (lastPublished() as [number, number[]])[1].join();
    expect(published()).toContain(column);

    // Past the push's hold (800 ms from it, and the tick that publishes its end), inside one from the mount.
    wait(SECURE_TRANSITION_HOLD_MS - 200 + 150);
    expect(published()).not.toContain(column);
  });

  it('a slide Modal opened with a spinner: its secure content, mounting 200 ms later, gets the band', () => {
    const fiber = unseen(inModal({ animationType: 'slide' }));
    const host = ancestorOfType(fiber, 'RCTModalHostView');
    host.alternate = { ...host, alternate: host };
    wait(200);

    render(fiber);

    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(
      px({ ...selfRect, height: WHOLE_SURFACE.height - selfRect.y }),
    );
  });
});

describe('N4: a screen replaced by another on its stack', () => {
  /** The view on a stack's only screen, `props` its screen's. */
  function onOnlyScreen(props: Record<string, unknown>): FiberLike {
    return existing(
      selfIn(
        root([
          fabricHost('RNSScreenStack', null, { children: 1 }, [
            fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, ...props }, [view([self()])]),
          ]),
        ]),
      ),
    );
  }

  /** Replaces the view's screen with a new one with `props`, in one commit, and unmounts the view. */
  function replace(fiber: FiberLike, testRenderer: ReactTestRenderer, props: Record<string, unknown>): void {
    const stack = ancestorOfType(fiber, 'RNSScreenStack');
    const leaving = ancestorOfType(fiber, SCREEN_HOST_TYPE);
    const spec = fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, ...props }, []);
    stack.child = {
      tag: spec.tag,
      type: spec.type,
      memoizedProps: spec.memoizedProps,
      stateNode: spec.stateNode,
      child: null,
      sibling: null,
      return: stack,
      alternate: null,
    } as FiberLike;
    stack.memoizedProps = { children: 1 };
    deleting(leaving);
    unmount(testRenderer);
  }

  it('a login screen set to fade, replaced by a Home that slides in, is covered by the slide\'s band', () => {
    const fiber = onOnlyScreen({ stackAnimation: 'fade' });
    const testRenderer = render(fiber);
    wait(212);
    // Whichever fiber of the stack's pair the commit has: here, with no other.
    ancestorOfType(fiber, 'RNSScreenStack').alternate = null;

    replace(fiber, testRenderer, { stackAnimation: 'slide_from_right' });

    expect(firstPublished()).toEqual(px(rect(0, 100, 400, 50)));
    wait(SECURE_TRANSITION_HOLD_MS - 100);
    expect(firstPublished()).toEqual(px(rect(0, 100, 400, 50)));
  });

  it('replaced by a screen with the default animation (not known): the whole screen', () => {
    const fiber = onOnlyScreen({ stackAnimation: 'none' });
    const testRenderer = render(fiber);
    wait(212);

    replace(fiber, testRenderer, {});

    expect(firstPublished()).toEqual(px(SCREEN));
  });

  it('replaced by a screen sliding up over it: as the screen below, it stays put', () => {
    const fiber = onOnlyScreen({ stackAnimation: 'fade' });
    const testRenderer = render(fiber);
    wait(212);

    replace(fiber, testRenderer, { stackAnimation: 'slide_from_bottom' });

    expect(firstPublished()).toEqual(px(selfRect));
  });

  it('on iOS, replaced by a card presented over it: the whole screen (the card scales it)', () => {
    mockPlatform.OS = 'ios';
    try {
      const fiber = onOnlyScreen({ stackAnimation: 'fade' });
      const testRenderer = render(fiber);
      wait(212);

      replace(fiber, testRenderer, { stackPresentation: 'formSheet' });

      // iOS takes points.
      expect((lastPublished() as [number, number[]])[1].slice(0, 4)).toEqual([0, 0, 400, 800]);
    } finally {
      mockPlatform.OS = 'android';
    }
  });

  it('replaced while nothing of it is on screen: nothing to cover, nothing thrown', () => {
    // Scrolled out of its ScrollView: seen nowhere.
    selfRect = rect(10, 500, 200, 50);
    const fiber = existing(
      selfIn(
        root([
          fabricHost('RNSScreenStack', null, { children: 1 }, [
            fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, stackAnimation: 'fade' }, [
              scrollView(rect(0, 0, 400, 300), [view([self()])]),
            ]),
          ]),
        ]),
      ),
    );
    const testRenderer = render(fiber);
    wait(212);

    replace(fiber, testRenderer, {});

    expect(console.warn).not.toHaveBeenCalled();
    // Nothing on screen to publish, if anything at all.
    const published = (lastPublished() as [number, number[]] | undefined)?.[1] ?? [];
    expect(published.join()).not.toContain(px(SCREEN).join());
  });

  it('a cover run out but not yet dropped (between ticks) is not joined as it departs', () => {
    const tree = root([
      fabricHost('RNSScreenStack', null, { children: 1 }, [
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, stackAnimation: 'fade' }, [view([self()])]),
      ]),
    ]);
    const fiber = existing(selvesIn(tree)[0] as FiberLike);
    const testRenderer = render(fiber);
    wait(212);
    const stack = ancestorOfType(fiber, 'RNSScreenStack');
    const spec = fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, []);
    (stack.child as FiberLike).sibling = {
      tag: spec.tag,
      type: spec.type,
      memoizedProps: spec.memoizedProps,
      stateNode: spec.stateNode,
      child: null,
      sibling: null,
      return: stack,
    } as FiberLike;
    stack.memoizedProps = { children: 2 };
    wait(17);
    expect(firstPublished()).toEqual(px(SCREEN));
    // The push's cover ran out at ~1029; the next tick, which drops it, is at 1100.
    wait(1050 - 229);

    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));
    unmount(testRenderer);

    expect(firstPublished()).toEqual(px(selfRect));
  });

  it('popped alone, nothing new on its stack: its own animation', () => {
    const fiber = onOnlyScreen({ stackAnimation: 'fade' });
    const testRenderer = render(fiber);
    wait(212);

    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));
    unmount(testRenderer);

    // Its fade's cover (the view where it rests), and the view held.
    expect(lastPublished()).toEqual([0, [...px(selfRect), ...px(selfRect)]]);
  });

  it('a cover still running is joined, not replaced: the later end kept', () => {
    // On a fading screen below; a push over it covers it whole, then its screen is removed (a reset).
    const tree = root([
      fabricHost('RNSScreenStack', null, { children: 1 }, [
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, stackAnimation: 'fade' }, [view([self()])]),
      ]),
    ]);
    const fiber = existing(selvesIn(tree)[0] as FiberLike);
    const testRenderer = render(fiber);
    wait(212);
    const stack = ancestorOfType(fiber, 'RNSScreenStack');
    const spec = fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, []);
    (stack.child as FiberLike).sibling = {
      tag: spec.tag,
      type: spec.type,
      memoizedProps: spec.memoizedProps,
      stateNode: spec.stateNode,
      child: null,
      sibling: null,
      return: stack,
    } as FiberLike;
    stack.memoizedProps = { children: 2 };
    wait(17);
    expect(firstPublished()).toEqual(px(SCREEN));
    wait(200);

    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));
    unmount(testRenderer);

    expect(firstPublished()).toEqual(px(SCREEN));
    // The push's hold has run out (800 ms from it); the removal's has not.
    wait(SECURE_TRANSITION_HOLD_MS - 150);
    expect(firstPublished()).toEqual(px(SCREEN));
  });
});

describe('P3-g: a Modal opened over a stack screen', () => {
  // A Modal is a root of its own: the screens it was opened over are not the view's carriers (as on c812b12).
  it('a push on that stack, under the Modal, covers nothing on the Modal', () => {
    const fiber = existing(
      selfIn(
        root([
          fabricHost('RNSScreenStack', null, { children: 1 }, [
            fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [
              view([
                {
                  tag: FiberTag.HostComponent,
                  type: 'RCTModalHostView',
                  memoizedProps: { animationType: 'slide' },
                  stateNode: { rect: null, tag: MODAL_TAG, canonical: { currentProps: {} } },
                  children: [fabricHost('RCTView', rect(0, 0, 400, 800), {}, [view([self()])])],
                },
              ]),
            ]),
          ]),
        ]),
      ),
    );
    render(fiber);
    wait(212);
    const stack = ancestorOfType(fiber, 'RNSScreenStack');
    const spec = fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, []);
    (stack.child as FiberLike).sibling = {
      tag: spec.tag,
      type: spec.type,
      memoizedProps: spec.memoizedProps,
      stateNode: spec.stateNode,
      child: null,
      sibling: null,
      return: stack,
    } as FiberLike;
    stack.memoizedProps = { children: 2 };
    wait(17);

    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });
});

describe('P2-8: the cover follows the screen\'s stackAnimation', () => {
  function pushed(stackAnimation: unknown, extra: Record<string, unknown> = {}): void {
    const fiber = selfIn(
      root([
        fabricHost('RNSScreenStack', null, {}, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, stackAnimation, ...extra }, [view([self()])]),
        ]),
      ]),
    );
    existingFrom(ancestorOfType(fiber, 'RNSScreenStack'));
    render(fiber);
  }

  it.each([
    ['slide_from_right', { x: 0, y: 100, width: 400, height: 50 }],
    ['ios_from_left', { x: 0, y: 100, width: 400, height: 50 }],
    ['slide_from_bottom', { x: 10, y: 100, width: 200, height: 700 }],
    ['fade', { x: 10, y: 100, width: 200, height: 50 }],
    ['default', SCREEN],
    ['flip', SCREEN],
    [undefined, SCREEN],
  ])('%s', (animation, expected) => {
    pushed(animation);

    expect(firstPublished()).toEqual(px(expected));
  });

  it('a modal presentation with the default animation on Android covers the whole screen', () => {
    pushed('default', { stackPresentation: 'modal' });

    expect(firstPublished()).toEqual(px(SCREEN));
  });

  it('a view cut away by a ScrollView on the screen covers nothing more as it moves', () => {
    const fiber = selfIn(
      root([
        fabricHost('RNSScreenStack', null, {}, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2, stackAnimation: 'slide_from_right' }, [
            scrollView(rect(0, 400, 400, 100), [self()]),
          ]),
        ]),
      ]),
    );
    existingFrom(ancestorOfType(fiber, 'RNSScreenStack'));
    render(fiber);

    // Nothing published at all: the lane already holds nothing.
    expect(native.setSecureRectangles.mock.calls.every(([, flat]) => (flat as number[]).length === 0)).toBe(true);
  });
});

describe('P2-5: views that come later into a transition still running', () => {
  it('a view mounted on a pushed screen a commit later, within the hold, is carried in until the hold ends', () => {
    const tree = root([
      fabricHost('RNSScreenStack', null, {}, [
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()]), view([self()])]),
      ]),
    ]);
    const [first, later] = selvesIn(tree) as [FiberLike, FiberLike];
    existingFrom(ancestorOfType(first, 'RNSScreenStack'));
    render(first);

    // 300 ms on, a row rendered in a later batch: the screen has been rendered again since.
    wait(300);
    existing(later);
    native.reset();
    render(later);
    // Both views cover the screen: the first from its own push, the later one carried in with it.
    const published = (lastPublished() as [number, number[]])[1];
    const screens = published.filter((_, index) => index % 4 === 0).filter((_, index) =>
      published.slice(index * 4, index * 4 + 4).join() === px(SCREEN).join(),
    );
    expect(screens).toHaveLength(2);

    wait(SECURE_TRANSITION_HOLD_MS - 300 + 100);
    expect(lastPublished()).toEqual([0, [...px(selfRect), ...px(selfRect)]]);
  });

  it('a view whose first measurement failed still covers its popped screen', () => {
    const fiber = existing(onStackScreen());
    measureInWindow.mockImplementationOnce(() => {
      throw new Error('not laid out');
    });
    const testRenderer = render(fiber);
    expect(native.setSecureRectangles).not.toHaveBeenCalled();

    deleting(ancestorOfType(fiber, SCREEN_HOST_TYPE));
    unmount(testRenderer);

    expect(lastPublished()).toEqual([0, px(SCREEN)]);
  });
});

const SLIDING = { activityState: 2, stackAnimation: 'slide_from_right' };

describe('round 2: what only a mounted tracker shows', () => {
  it('a view mounted on a screen that was there before is not followed every frame', () => {
    render(existing(onStackScreen()));
    const before = measureInWindow.mock.calls.length;

    act(() => {
      jest.advanceTimersByTime(16 * 5);
    });

    // Five frames, no tick yet: not measured.
    expect(measureInWindow.mock.calls.length).toBe(before);
  });

  it('a view hidden as its screen is pushed, shown after the screen rendered again, is carried in', () => {
    const fiber = selfIn(
      root([
        fabricHost('RNSScreenStack', null, {}, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 0 }, [view([self()])]),
        ]),
      ]),
    );
    existingFrom(ancestorOfType(fiber, 'RNSScreenStack'));
    render(fiber);

    // Rendered again (so no longer without an alternate), and shown.
    const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);
    existing(fiber);
    screen.memoizedProps = { activityState: 2 };
    wait(17);

    expect(firstPublished()).toEqual(px(SCREEN));
  });

  it('the screen below is told the committed stackAnimation, not one in flight', () => {
    const tree = root([
      fabricHost('RNSScreenStack', null, {}, [
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [view([self()])]),
        fabricHost(SCREEN_HOST_TYPE, SCREEN, SLIDING, [view([self()])]),
      ]),
    ]);
    const selves = selvesIn(tree);
    const below = selves.find((fiber) => ancestorOfType(fiber, SCREEN_HOST_TYPE).sibling !== null) as FiberLike;
    const top = selves.find((fiber) => fiber !== below) as FiberLike;
    existing(below);
    existing(top);
    const pushed = ancestorOfType(top, SCREEN_HOST_TYPE);
    render(below);
    const topRenderer = render(top);
    // A render in flight that would change the animation, never committed.
    pairWith(pushed.alternate as FiberLike, { activityState: 2 });

    deleting(pushed);
    unmount(topRenderer);

    const published = (lastPublished() as [number, number[]])[1];
    expect(published.slice(0, 4)).toEqual(px(rect(0, 100, 400, 50)));
  });

  it('a parked view below a push drops the cover it was given once it runs out', () => {
    const tree = root([
      fabricHost('RNSScreenStack', null, {}, [
        fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState: 2 }, [scrollView(rect(0, 0, 400, 120), [self()])]),
        fabricHost(SCREEN_HOST_TYPE, SCREEN, SLIDING, [view([self()])]),
      ]),
    ]);
    const selves = selvesIn(tree);
    const below = selves.find((fiber) => ancestorOfType(fiber, SCREEN_HOST_TYPE).sibling !== null) as FiberLike;
    const top = selves.find((fiber) => fiber !== below) as FiberLike;
    existing(below);
    render(below);
    wait(16 * 12);
    // Parked, clipped to 100..120; then the other screen is pushed over it.
    const pushed = ancestorOfType(top, SCREEN_HOST_TYPE);
    for (let current: FiberLike | null = pushed; current !== null; current = current.child) {
      current.alternate = null;
    }
    render(top);
    wait(SECURE_TRANSITION_HOLD_MS + 200);

    const published = (lastPublished() as [number, number[]])[1];
    expect(published).toEqual([...px(rect(10, 100, 200, 20)), ...px(selfRect)]);
  });

  it('a native value replaced by another in a commit is watched instead', () => {
    const a = animatedValue(0);
    const b = animatedValue(0);
    const fiber = underAnimated([{ translateX: a }, { translateY: b }], [{ translateX: 0 }, { translateY: 0 }]);
    render(fiber);
    wait(16 * 12);

    const c = animatedValue(0);
    const wrapper = ancestorOfType(fiber, AnimatedView);
    wrapper.memoizedProps = { style: { transform: [{ translateX: a }, { translateY: c }] } };
    // To 242 ms: the tick at 200 measures it with c.
    wait(50);
    c._animation = timing(0, 100);
    // To 259 ms: no tick; only the watch on c can wake it.
    wait(17);

    expect(firstPublished()).toEqual(px(rect(10, 100, 200, 150)));
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
    // Carried with no cover from it: nothing to join, nothing thrown.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('a view first laid out with no width, elsewhere, joins nothing of there into its band', () => {
    selfRect = rect(300, 100, 0, 50);
    render(inModal({ animationType: 'slide' }));
    selfRect = rect(10, 100, 200, 50);
    wait(17);

    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(band(selfRect)));
  });

  it('a view carried in while cut away by a ScrollView in it covers nothing, and throws nothing', () => {
    selfRect = rect(10, 500, 200, 50);
    const fiber = selfIn(
      root([
        view([
          {
            tag: FiberTag.HostComponent,
            type: 'RCTModalHostView',
            memoizedProps: { animationType: 'slide' },
            stateNode: { rect: null, tag: MODAL_TAG, canonical: { currentProps: {} } },
            children: [
              fabricHost('RCTView', rect(0, 0, 400, 800), {}, [scrollView(rect(0, 0, 400, 300), [view([self()])])]),
            ],
          },
        ]),
      ]),
    );
    existingFrom(ancestorOfType(ancestorOfType(fiber, 'RCTModalHostView'), 'RCTView'));
    render(fiber);
    wait(17);

    expect(console.warn).not.toHaveBeenCalled();
    const published = (lastOnSurface() as [number, number, number[]] | undefined)?.[2] ?? [];
    expect(published).toEqual([]);
  });

  it('a stack inside a fading Modal opening covers the screen, and nothing for the Modal', () => {
    const fiber = onScreenInModal('RNSScreenStack', 2, { animationType: 'fade', visible: true }, true);
    const host = ancestorOfType(fiber, 'RCTModalHostView');
    for (let current: FiberLike | null = host; current !== null; current = current.child) {
      current.alternate = null;
    }
    render(fiber);

    expect(console.warn).not.toHaveBeenCalled();
    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(SCREEN));
  });

  it.each<[string, WindowRect]>([
    ['no width', rect(10, 100, 0, 50)],
    ['no height', rect(10, 100, 200, 0)],
  ])('a view laid out with %s while carried covers no band', (_, laidOut) => {
    selfRect = laidOut;
    render(inModal({ animationType: 'slide' }));
    wait(17);

    const published = (lastOnSurface() as [number, number, number[]] | undefined)?.[2] ?? [];
    expect(published.join()).not.toContain(px(band(laidOut)).join());
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
    // A Modal has no stack to look for a replacement on.
    expect(console.warn).not.toHaveBeenCalled();
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

  it('a Modal hidden while it still slides in keeps the close band for the hold from the hide', () => {
    const fiber = inModal({ animationType: 'slide', visible: true });
    render(fiber);
    wait(400);

    ancestorOfType(fiber, 'RCTModalHostView').memoizedProps = { animationType: 'slide', visible: false };
    wait(17);
    // Past the open's hold (800 ms from the mount), inside the close's (800 ms from the hide).
    wait(SECURE_TRANSITION_HOLD_MS - 300);
    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(band(selfRect)));

    wait(400);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });

  /** The view on a screen of a `container` inside a `<Modal>` with `props`, every ancestor there before. */
  /** `opening`: the Modal and what is in it come with the commit that mounts the view. */
  function onScreenInModal(
    container: string,
    activityState: number,
    props: Record<string, unknown>,
    opening = false,
  ): FiberLike {
    const screen = fabricHost(SCREEN_HOST_TYPE, SCREEN, { activityState }, [view([self()])]);
    return (opening ? unseen : existing)(
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

  it('P2-5: a view hidden as a Modal opens, shown while it still slides in, is carried in; shown later, not', () => {
    const fiber = onScreenInModal('RNSScreenContainer', 0, { animationType: 'slide', visible: true }, true);
    // The Modal was created by the commit that mounted the view; the screen that opened it was there.
    const host = ancestorOfType(fiber, 'RCTModalHostView');
    for (let current: FiberLike | null = host; current !== null; current = current.child) {
      current.alternate = null;
    }
    render(fiber);
    const screen = ancestorOfType(fiber, SCREEN_HOST_TYPE);
    screen.memoizedProps = { activityState: 2 };
    wait(17);

    expect((lastOnSurface() as [number, number, number[]])[2].slice(0, 4)).toEqual(px(band(selfRect)));

    // Hidden, and shown again once the transition is over: no band.
    screen.memoizedProps = { activityState: 0 };
    wait(SECURE_TRANSITION_HOLD_MS + 100);
    screen.memoizedProps = { activityState: 2 };
    wait(17);
    expect(lastOnSurface()).toEqual([0, MODAL_TAG, px(selfRect)]);
  });

  it('a stack inside a slide Modal opening covers the band as well as the screen', () => {
    const fiber = onScreenInModal('RNSScreenStack', 2, { animationType: 'slide', visible: true }, true);
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

  it('a view in a Modal on no stack reads no stack, and warns about nothing', () => {
    render(existing(inModal({ animationType: 'slide' })));
    wait(212);

    expect(console.warn).not.toHaveBeenCalled();
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
  _tracking: null;
  __getValue: () => number;
  hasListeners: () => boolean;
}

/** `synced`: JS provably holds its native value (the app listens to it). */
function animatedValue(value: number, isNative = true, synced = true): FakeValue {
  const node: FakeValue = {
    __isNative: isNative,
    _value: value,
    _offset: 0,
    _animation: null,
    _tracking: null,
    __getValue: () => node._value + node._offset,
    hasListeners: () => synced,
  };
  return node;
}

const linear = (t: number): number => t;
const timing = (from: number, to: number): FakeValue['_animation'] => ({
  _fromValue: from,
  _toValue: to,
  _easing: linear,
});

/** A stand-in for `value.interpolate({ inputRange, outputRange, ...extra })`, extending past its ends. */
function interpolation(
  parent: object,
  inputRange: number[],
  outputRange: number[],
  extra: Record<string, unknown> = {},
): object {
  const interpolate = (input: number): number => {
    const [i0, i1] = inputRange as [number, number];
    const [o0, o1] = outputRange as [number, number];
    return o0 + ((input - i0) * (o1 - o0)) / (i1 - i0);
  };
  return {
    __isNative: true,
    _parent: parent,
    _config: { inputRange, outputRange, ...extra },
    _getInterpolation: () => interpolate,
    __getValue: () => interpolate((parent as FakeValue).__getValue()),
  };
}

const AnimatedView = Object.assign(() => null, { displayName: 'Animated(View)' });

/**
 * The view under an `Animated.View` styled `transform` (and `extra`), which
 * renders the host `RCTView` measured at `animatedRect` with `rendered` as
 * its transform.
 */
function underAnimated(
  transform: Array<Record<string, unknown>>,
  rendered: Array<Record<string, unknown>>,
  animatedRect = rect(0, 0, 400, 800),
  outer: (spec: FiberSpec) => FiberSpec = (spec) => spec,
  inner: (spec: FiberSpec) => FiberSpec = (spec) => spec,
  extra: Record<string, unknown> = {},
): FiberLike {
  return existing(
    selfIn(
      root([
        outer({
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform, ...extra } },
          children: [
            fabricHost('RCTView', animatedRect, { style: { transform: rendered, ...extra } }, [inner(view([self()]))]),
          ],
        }),
      ]),
    ),
  );
}

/** The first rectangle of the last publish on display 0. */
const firstPublished = (): number[] => (lastPublished() as [number, number[]])[1].slice(0, 4);

describe('B6: a native-driven Animated transform above the view', () => {
  it('covers every place an interpolated translateX can draw it', () => {
    const value = animatedValue(0);
    value._animation = timing(0, 1);
    render(underAnimated([{ translateX: interpolation(value, [0, 1], [0, 160]) }], [{ translateX: 0 }]));

    expect(lastPublished()).toEqual([0, px(rect(10, 100, 360, 50))]);
  });

  it('covers a value stopped part-way, whichever value the shadow tree holds', () => {
    const value = animatedValue(0);
    render(underAnimated([{ translateY: value }], [{ translateY: 0 }]));

    // Stopped at 40: synced back to JS; the shadow tree holds 0 (or 40, with C++ Animated).
    value._value = 40;
    wait(100);

    expect(firstPublished()).toEqual(px(rect(10, 100, 200, 90)));
  });

  it('P1-1: with the end value in the shadow tree and the stale one in props, the mask stays on the view', () => {
    // C++ Animated: the card slid from 300 to 0; native committed 0 to the shadow tree; props still say 300.
    const value = animatedValue(0);
    render(underAnimated([{ translateY: value }], [{ translateY: 300 }]));

    const published = firstPublished();
    // The view, where the shadow tree (and native) have it, is covered...
    expect(published[1]).toBeLessThanOrEqual(2 * selfRect.y);
    expect(published[3]).toBeGreaterThanOrEqual(2 * (selfRect.y + selfRect.height));
    // ...and so is where it would be with the props' value in the shadow tree.
    expect(published[1]).toBe(2 * (selfRect.y - 300));
  });

  it('covers a running timing animation from end to end, and follows it every frame', () => {
    const value = animatedValue(0);
    render(underAnimated([{ translateY: value }], [{ translateY: 0 }]));
    const measures = measureInWindow.mock.calls.length;

    value._animation = timing(0, 100);
    wait(17);
    expect(firstPublished()).toEqual(px(rect(10, 100, 200, 150)));

    // Running: measured every frame, however still the shadow tree is.
    wait(16 * 20);
    expect(measureInWindow.mock.calls.length - measures).toBeGreaterThanOrEqual(20);
  });

  it('P2-3: a still native transform measures nothing per frame, and wakes the frame an animation starts', () => {
    const value = animatedValue(0);
    render(underAnimated([{ translateY: value }], [{ translateY: 0 }]));
    wait(16 * 12);
    const before = measureInWindow.mock.calls.length;

    // Six frames, no tick: nothing measured.
    act(() => {
      jest.advanceTimersByTime(16 * 5);
    });
    expect(measureInWindow.mock.calls.length).toBeLessThanOrEqual(before + 1);

    value._animation = timing(0, 100);
    const started = measureInWindow.mock.calls.length;
    wait(17);
    expect(measureInWindow.mock.calls.length).toBeGreaterThan(started);
    expect(firstPublished()).toEqual(px(rect(10, 100, 200, 150)));
  });

  it('N1: a clipped view whose value is not native yet is covered from the frame its first native slide starts', () => {
    // A list row partly scrolled out (so parked), swiped away on a fresh value.
    const value = animatedValue(0, false);
    render(
      underAnimated([{ translateY: value }], [{ translateY: 0 }], undefined, (spec) =>
        scrollView(rect(0, 0, 400, 120), [spec]),
      ),
    );
    wait(16 * 20);
    expect(firstPublished()).toEqual(px(rect(10, 100, 200, 20)));

    // `start()` with the native driver: made native, and the animation set; nothing committed.
    value.__isNative = true;
    value._animation = timing(0, -100);
    wait(17);

    expect(firstPublished()).toEqual(px(rect(10, 0, 200, 120)));
  });

  it('N1: a wholly visible view whose value is not native yet is covered within a frame, not a tick', () => {
    const value = animatedValue(0, false);
    render(underAnimated([{ translateY: value }], [{ translateY: 0 }]));
    // To 212 ms: past the tick at 200, so only the value's watch can measure it within the next frame.
    wait(212);

    value.__isNative = true;
    value._animation = timing(0, -100);
    wait(17);

    expect(firstPublished()).toEqual(px(rect(10, 0, 200, 150)));
  });

  it('P2-3: under an Animated component with no native transform, a view parks like any other', () => {
    render(
      underAnimated([{ translateX: 5 }], [{ translateX: 5 }], undefined, undefined, (spec) =>
        scrollView(rect(0, 0, 400, 120), [spec]),
      ),
    );
    wait(16 * 12);
    const before = measureInWindow.mock.calls.length;

    act(() => {
      jest.advanceTimersByTime(16 * 5);
    });

    // Parked: only the tick's own check (at 200 ms) measures it.
    expect(measureInWindow.mock.calls.length).toBe(before + 1);
  });

  it('P1-2: a native value nobody animated from JS (an Animated.event) covers the whole surface, clipped', () => {
    const scrollY = animatedValue(0, true, false);
    render(
      underAnimated([{ translateY: scrollY }], [{ translateY: 0 }], undefined, (spec) =>
        scrollView(rect(0, 50, 400, 300), [spec]),
      ),
    );

    expect(firstPublished()).toEqual(px(rect(0, 50, 400, 300)));
  });

  it('P1-2: a collapsing header (diffClamp, clamped interpolation) is covered over its whole travel', () => {
    const scrollY = animatedValue(0, true, false);
    const clamp = { __isNative: true, _a: scrollY, _min: 0, _max: 60, _value: 0, __getValue: () => 0 };
    const header = interpolation(clamp, [0, 60], [0, -60], { extrapolate: 'clamp' });
    render(underAnimated([{ translateY: header }], [{ translateY: 0 }]));

    expect(firstPublished()).toEqual(px(rect(10, 40, 200, 110)));
  });

  it('P1-2: a clamped interpolation of a value it cannot bound is covered over its output range', () => {
    const scrollY = animatedValue(0, true, false);
    render(
      underAnimated(
        [
          {
            translateY: interpolation(scrollY, [0, 100], [0, -30], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          },
        ],
        [{ translateY: 0 }],
      ),
    );

    expect(firstPublished()).toEqual(px(rect(10, 70, 200, 80)));
  });

  it('P2-1: a value whose fields were renamed is unbounded: the whole surface', () => {
    const value = animatedValue(0) as unknown as Record<string, unknown>;
    value._runningAnimation = value._animation;
    delete value._animation;
    render(underAnimated([{ translateY: value }], [{ translateY: 0 }]));

    expect(firstPublished()).toEqual(px(WHOLE_SURFACE));
  });

  it('includes what an easing overshoots', () => {
    const value = animatedValue(0);
    value._animation = { _fromValue: 0, _toValue: 100, _easing: (t) => t * (1.2 - 0.2 * t) * (t < 0.5 ? 1 : 1.25) };
    render(underAnimated([{ translateX: value }], [{ translateX: 0 }]));

    expect(firstPublished()[2]).toBeGreaterThan(2 * (10 + 200 + 100));
  });

  it('scales about the animated view’s centre', () => {
    const value = animatedValue(2);
    render(underAnimated([{ scale: value }], [{ scale: 1 }], rect(0, 0, 400, 400)));

    // Twice the size about (200, 200): x 10..210 to -180..220, y 100..150 to 0..100; and where it rests.
    expect(firstPublished()).toEqual(px(rect(-180, 0, 400, 150)));
  });

  it('P2-2: scales about its transformOrigin', () => {
    const value = animatedValue(1);
    value._animation = timing(1, 1.5);
    render(underAnimated([{ scale: value }], [{ scale: 1 }], rect(0, 0, 400, 400), undefined, undefined, {
      transformOrigin: 'top left',
    }));

    // About (0, 0), by 1 to 1.5: x 10..315, y 100..225.
    expect(firstPublished()).toEqual(px(rect(10, 100, 305, 125)));
  });

  it('P2-2: a transformOrigin it cannot read is unbounded', () => {
    const value = animatedValue(1);
    value._animation = timing(1, 1.5);
    render(underAnimated([{ scale: value }], [{ scale: 1 }], rect(0, 0, 400, 400), undefined, undefined, {
      transformOrigin: 'calc(50% - 2px) top',
    }));

    expect(firstPublished()).toEqual(px(WHOLE_SURFACE));
  });

  it('P2-4: composes a translation with a scale, and adds two bounded values', () => {
    const lift = animatedValue(0);
    lift._animation = timing(0, -20);
    const sum = { __isNative: true, _a: lift, _b: animatedValue(10), __getValue: () => lift.__getValue() + 10 };
    const zoom = animatedValue(1);
    zoom._animation = timing(1, 1.1);
    render(
      underAnimated([{ translateY: sum }, { scale: zoom }], [{ translateY: 10 }, { scale: 1 }], rect(0, 0, 400, 400)),
    );

    const [left, top, right, bottom] = firstPublished();
    // Never the whole surface; reaches 20 up (the sum from 10 down to -10) and the 10% growth about the centre.
    expect(right! - left!).toBeLessThan(2 * 400);
    expect(top).toBeLessThanOrEqual(2 * (100 - 20 - 10));
    expect(bottom).toBeGreaterThanOrEqual(2 * 150);
  });

  it('P2-4: clips by a clipping ancestor inside the transform before moving, and by one above after', () => {
    const value = animatedValue(0);
    value._animation = timing(0, 1);
    render(
      underAnimated(
        [{ translateY: interpolation(value, [0, 1], [0, 300]) }],
        [{ translateY: 0 }],
        undefined,
        (spec) => scrollView(rect(0, 0, 400, 1000), [spec]),
        (spec) => scrollView(rect(0, 0, 400, 130), [spec]),
      ),
    );

    // Cut to 100..130 inside, then moved by up to 300: 100..430 (not 100..450), within 0..1000 above.
    expect(firstPublished()).toEqual(px(rect(10, 100, 200, 330)));
  });

  it('a rotation stays unbounded: the whole surface, cut by a clipping ancestor above', () => {
    render(
      underAnimated([{ rotate: animatedValue(1) }], [{ rotate: '0deg' }], undefined, (spec) =>
        scrollView(rect(0, 50, 400, 300), [spec]),
      ),
    );

    expect(firstPublished()).toEqual(px(rect(0, 50, 400, 300)));
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

const ReanimatedView = Object.assign(() => null, { displayName: 'AnimatedComponent(View)' });

/** The view under a Reanimated component with `style`. */
function underReanimated(style: unknown): FiberLike {
  return existing(
    selfIn(
      root([
        scrollView(rect(0, 50, 400, 300), [
          {
            tag: FiberTag.FunctionComponent,
            type: ReanimatedView,
            memoizedProps: { style },
            children: [view([self()])],
          },
        ]),
      ]),
    ),
  );
}

describe('P2-7: Reanimated', () => {
  it('an animated style that sets a transform covers the whole surface, clipped', () => {
    const animatedStyle = { viewDescriptors: {}, initial: { value: { transform: [{ translateY: 0 }] } } };
    render(underReanimated([{ flex: 1 }, animatedStyle]));

    expect(firstPublished()).toEqual(px(rect(0, 50, 400, 300)));
  });

  it('an animated style it cannot read is taken as moving the view', () => {
    render(underReanimated({ viewDescriptors: {}, initial: {} }));

    expect(firstPublished()).toEqual(px(rect(0, 50, 400, 300)));
  });

  it('an animated style without a transform, or plain styles, move nothing', () => {
    render(underReanimated([{ viewDescriptors: {}, initial: { value: { opacity: 1 } } }, null, { margin: 2 }]));

    expect(lastPublished()).toEqual([0, px(selfRect)]);
  });
});
