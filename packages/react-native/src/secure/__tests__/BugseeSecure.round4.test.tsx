/**
 * Round 4 of the review of #87 (#86): parked views must not under-mask.
 * R1 and R2 are the reviewer's reproductions. Each test here failed against
 * 51c6024.
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { BugseeSecure } from '../BugseeSecure';
import { SECURE_SHRINK_HOLD_MS } from '../hold';
import { native } from '../../__mocks__/native';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import {
  ancestorOfType,
  commitProps,
  fabricHost,
  fakeRenderer,
  moveTo,
  rect,
  root,
  scrollView,
  self,
  selfIn,
  selvesIn,
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


/** The first rectangle of the last publish on display 0, as [left, top, right, bottom]. */
const firstPublished = (): number[] => (native.setSecureRectangles.mock.lastCall?.[1] as number[]).slice(0, 4);


describe('round 4: parked views', () => {
  it('R1: a parked view whose clipper stops clipping is masked whole within a frame', () => {
    const clipping = fabricHost('RCTView', rect(0, 0, 400, 120), { style: { overflow: 'hidden' } }, [self()]);
    const fiber = selfIn(root([clipping]));
    render(fiber);
    frames(12);
    wait(13);
    expect(lastPublished()).toEqual([0, px(rect(10, 100, 200, 20))]);

    commitProps(ancestorOfType(fiber, 'RCTView'), { style: { overflow: 'visible' } });
    frames();

    expect(firstPublished()).toEqual(px(selfRect));
  });

  it('a parked view whose ScrollView becomes overflow: visible is masked whole within a frame', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    render(fiber);
    frames(12);
    wait(13);

    commitProps(ancestorOfType(fiber, 'RCTScrollView'), { style: { overflow: 'visible' } });
    frames();

    expect(firstPublished()).toEqual(px(selfRect));
  });

  it('R2: one of 200 parked views moved into view by a layout shift is masked within a tick', () => {
    const n = 200;
    const rects: WindowRect[] = Array.from({ length: n }, () => rect(10, 500, 200, 50));
    const fibers = selvesIn(root([scrollView(rect(0, 0, 400, 120), Array.from({ length: n }, () => self()))]));
    let testRenderer: ReactTestRenderer | undefined;
    act(() => {
      testRenderer = create(
        <>
          {fibers.map((_, index) => (
            <BugseeSecure key={index} testID={String(index)} />
          ))}
        </>,
        {
          createNodeMock: (element: { props: { testID?: string } }) => {
            const index = Number(element.props.testID);
            return {
              measureInWindow: (callback: Callback) => {
                const at = rects[index] as WindowRect;
                callback(at.x, at.y, at.width, at.height);
              },
              __internalInstanceHandle: fibers[index],
            };
          },
          unstable_isConcurrent: true,
        } as Parameters<typeof create>[1],
      );
    });
    mounted.push(testRenderer as ReactTestRenderer);
    frames(12);
    wait(300);
    expect((lastPublished() as [number, number[]] | undefined)?.[1] ?? []).toEqual([]);

    // A sibling's layout moves one into the viewport; the content does not move.
    rects[n - 1] = rect(10, 20, 200, 50);
    let ms = 0;
    while (ms < 2000 && ((lastPublished() as [number, number[]] | undefined)?.[1] ?? []).length === 0) {
      wait(16);
      ms += 16;
    }

    expect(ms).toBeLessThanOrEqual(116);
  });

  it('holds on a clock that only goes forward: a wall-clock jump ends no hold early', () => {
    const clipping = fabricHost('RCTView', rect(0, 0, 400, 800), { style: { overflow: 'hidden' } }, [self()]);
    const fiber = selfIn(root([clipping]));
    render(fiber);
    moveTo(ancestorOfType(fiber, 'RCTView'), rect(0, 0, 400, 120));
    tick();
    expect(lastPublished()).toEqual([0, [...px(rect(10, 100, 200, 20)), ...px(selfRect)]]);

    jest.setSystemTime(Date.now() + 3_600_000);
    tick();

    expect(lastPublished()).toEqual([0, [...px(rect(10, 100, 200, 20)), ...px(selfRect)]]);
  });

  it('a publish that failed for a lane of parked views is published again on the next tick', () => {
    const fiber = selfIn(root([scrollView(rect(0, 0, 400, 120), [self()])]));
    render(fiber);
    // It moves, then parks holding where it was.
    selfRect = rect(10, 90, 200, 50);
    frames(12);
    expect(lastPublished()).toEqual([0, [...px(rect(10, 90, 200, 30)), ...px(rect(10, 100, 200, 20))]]);

    // The tick that drops the held box fails to publish; nothing on the lane
    // will change again.
    native.setSecureRectangles.mockClear();
    native.setSecureRectangles.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    wait(SECURE_SHRINK_HOLD_MS + 300);

    // The failed publish, then the same again on the next tick.
    expect(native.setSecureRectangles.mock.calls).toEqual([
      [0, px(rect(10, 90, 200, 30))],
      [0, px(rect(10, 90, 200, 30))],
    ]);
  });

});
