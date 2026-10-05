/**
 * `<BugseeSecure>` keeps the SDK's redaction on top of its view for as long as
 * it is mounted and enabled. The failure every test here guards against is a
 * region that is stale, shrunk or gone while the view is still on screen.
 */
import { act, useLayoutEffect } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { LayoutChangeEvent } from 'react-native';
import { BugseeSecure } from '../BugseeSecure';
import * as registry from '../registry';
import { native } from '../../__mocks__/native';

jest.mock('react-native', () => ({
  View: 'View',
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'android' },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

// React Native's own jest setup sets this flag. It tells react-test-renderer
// it is running under React Native's test environment, which is what this is,
// and it is the one flag that gates the renderer's deprecation message
// (read when create() is called, so setting it after the imports is enough).
// Nothing else is muted. The renderer is still created concurrent, below,
// like a Fabric root.
(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Measure = (callback: (x: number, y: number, width: number, height: number) => void) => void;

let measureInWindow: jest.Mock<void, Parameters<Measure>>;
let warn: jest.SpyInstance;
let mounted: ReactTestRenderer[] = [];

const measuresAt = (x: number, y: number, width: number, height: number): Measure =>
  (callback) => callback(x, y, width, height);

// Modules are NOT reset between tests: the JSX in this file is compiled
// against the react/jsx-runtime loaded once at the top, and a second React
// would be a different renderer. Instead every test leaves the registry as it
// found it: everything it mounted is unmounted and the manual set cleared, so
// display 0 is back to "nothing published" or "[] published".
beforeEach(() => {
  jest.useFakeTimers();
  native.reset();
  measureInWindow = jest.fn(measuresAt(10, 20, 30, 40));
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => mounted.forEach((renderer) => renderer.unmount()));
  mounted = [];
  registry.clearOwner('manual:0');
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function render(element: ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, {
      createNodeMock: () => ({ measureInWindow }),
      unstable_isConcurrent: true,
    } as Parameters<typeof create>[1]);
  });
  mounted.push(renderer as ReactTestRenderer);
  return renderer as ReactTestRenderer;
}

function update(renderer: ReactTestRenderer, element: ReactElement): void {
  act(() => renderer.update(element));
}

function tick(times = 1): void {
  act(() => {
    jest.advanceTimersByTime(100 * times);
  });
}

function layout(renderer: ReactTestRenderer, event: unknown = { nativeEvent: {} }): void {
  const view = renderer.root.findByType('View' as never);
  act(() => view.props.onLayout(event as LayoutChangeEvent));
}

// (10, 20, 30, 40) points at PixelRatio 2 is (20, 40) to (80, 120) pixels.
const MEASURED = [20, 40, 80, 120];

describe('<BugseeSecure>', () => {
  it('registers its measured rectangle on mount, scaled for Android', () => {
    render(<BugseeSecure />);

    expect(measureInWindow).toHaveBeenCalled();
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, MEASURED);
  });

  // Registered in the commit, before paint: a sibling's layout effect, which
  // runs after this one's and before any passive effect, already sees it.
  it('registers before the first paint', () => {
    const seenBySibling: unknown[][] = [];
    function Sibling(): null {
      useLayoutEffect(() => {
        seenBySibling.push(...native.setSecureRectangles.mock.calls);
      }, []);
      return null;
    }

    render(<><BugseeSecure /><Sibling /></>);

    expect(seenBySibling).toEqual([[0, MEASURED]]);
  });

  it('re-measures on every tick while mounted', () => {
    render(<BugseeSecure />);
    const before = measureInWindow.mock.calls.length;

    tick();
    expect(measureInWindow).toHaveBeenCalledTimes(before + 1);

    // An ancestor scrolled: no layout event, but the region follows.
    measureInWindow.mockImplementation(measuresAt(10, 70, 30, 40));
    tick();
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [20, 140, 80, 220]);

    tick(3);
    expect(measureInWindow).toHaveBeenCalledTimes(before + 5);
  });

  it('removes its rectangle on unmount', () => {
    const renderer = render(<BugseeSecure />);

    act(() => renderer.unmount());

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, []);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves a manual set alone when it unmounts', () => {
    registry.setOwnerRectangles('manual:0', 0, [{ x: 1, y: 2, width: 3, height: 4 }]);
    const renderer = render(<BugseeSecure />);

    act(() => renderer.unmount());

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [2, 4, 8, 12]);
  });

  it('keeps two instances apart', () => {
    const renderer = render(
      <>
        <BugseeSecure key="a" />
        <BugseeSecure key="b" />
      </>,
    );
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [...MEASURED, ...MEASURED]);

    update(renderer, <><BugseeSecure key="a" /></>);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, MEASURED);
  });

  it('enabled={false} removes its rectangle and stops measuring', () => {
    const renderer = render(<BugseeSecure />);

    update(renderer, <BugseeSecure enabled={false} />);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, []);

    measureInWindow.mockClear();
    tick(3);
    layout(renderer);
    expect(measureInWindow).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    update(renderer, <BugseeSecure enabled />);
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, MEASURED);
  });

  it('enabled={false} from the start never registers', () => {
    const renderer = render(<BugseeSecure enabled={false} />);
    tick();
    layout(renderer);

    expect(measureInWindow).not.toHaveBeenCalled();
    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });

  it('a throwing measureInWindow keeps the last rectangle', () => {
    render(<BugseeSecure />);
    const failure = new Error('view detached');
    measureInWindow.mockImplementation(() => {
      throw failure;
    });
    native.setSecureRectangles.mockClear();

    tick(3);

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
    // Logged once, not every 100 ms.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Bugsee] BugseeSecure could not measure', failure.name);

    measureInWindow.mockImplementation(measuresAt(10, 70, 30, 40));
    tick();
    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [20, 140, 80, 220]);
  });

  // A measurement the registry rejects (a detached view can report NaN) is
  // a failed measurement too: the last good rectangle stands.
  it('a measurement the registry rejects keeps the last rectangle', () => {
    render(<BugseeSecure />);
    measureInWindow.mockImplementation(measuresAt(Number.NaN, 0, 1, 1));
    native.setSecureRectangles.mockClear();

    tick(2);

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Paper answers measureInWindow asynchronously. An answer that lands after
  // unmount must not bring a phantom region back.
  it('a measurement that lands after unmount is dropped', () => {
    let pending: ((x: number, y: number, width: number, height: number) => void) | undefined;
    const renderer = render(<BugseeSecure />);
    measureInWindow.mockImplementation((callback) => {
      pending = callback;
    });
    tick();

    act(() => renderer.unmount());
    pending?.(10, 20, 30, 40);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, []);
  });

  // Nothing to measure yet is not a failure: no warning, nothing published.
  it('a view with no native instance measures nothing', () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(<BugseeSecure />, { createNodeMock: () => null });
    });
    mounted.push(renderer as ReactTestRenderer);
    tick();

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('measures again on layout', () => {
    const renderer = render(<BugseeSecure />);
    measureInWindow.mockImplementation(measuresAt(0, 0, 50, 50));

    layout(renderer);

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, [0, 0, 100, 100]);
  });

  it("calls the caller's onLayout", () => {
    const onLayout = jest.fn();
    const renderer = render(<BugseeSecure onLayout={onLayout} />);
    const event = { nativeEvent: { layout: { x: 0, y: 0, width: 1, height: 1 } } };
    const before = measureInWindow.mock.calls.length;

    layout(renderer, event);

    expect(onLayout).toHaveBeenCalledWith(event);
    expect(measureInWindow).toHaveBeenCalledTimes(before + 1);
  });

  it('renders a non-collapsable View with the caller\'s props', () => {
    const renderer = render(
      <BugseeSecure testID="card" style={{ padding: 4 }} collapsable>
        <BugseeSecure testID="inner" />
      </BugseeSecure>,
    );

    const [outer, inner] = renderer.root.findAllByType('View' as never);
    expect(outer?.props).toMatchObject({ testID: 'card', style: { padding: 4 }, collapsable: false });
    expect(outer?.props).not.toHaveProperty('enabled');
    expect(inner?.props.testID).toBe('inner');
  });
});

// Fabric measureInWindow is relative to the React root that holds the view,
// and a <Modal> is its own root. The rectangle goes out under the surface of
// the nearest Modal host above the view, read off the fiber tree once per
// mount, with no native call.
describe('<BugseeSecure> surfaces', () => {
  const MODAL_TAG = 56;
  /** Host fibers handed to RendererProxy, so a test can count the reads. */
  let tagReads: unknown[];

  beforeEach(() => {
    tagReads = [];
    jest.doMock('react-native/Libraries/ReactNative/RendererProxy', () => ({
      getPublicInstanceFromInternalInstanceHandle: (fiber: { tagForTest?: unknown }) => {
        tagReads.push(fiber);
        return { __nativeTag: fiber.tagForTest };
      },
    }));
  });

  afterEach(() => {
    jest.dontMock('react-native/Libraries/ReactNative/RendererProxy');
  });

  /** A host fiber for the view, under `ancestors` (nearest first). */
  function fiberUnder(...ancestors: Array<Record<string, unknown>>): Record<string, unknown> {
    const view: Record<string, unknown> = { tag: 5, type: 'RCTView', return: null };
    let child = view;
    for (const ancestor of ancestors) {
      const parent = { ...ancestor, return: null };
      child.return = parent;
      child = parent;
    }
    return view;
  }

  const modalHost = (tag: unknown = MODAL_TAG) => ({ tag: 5, type: 'RCTModalHostView', tagForTest: tag });

  function renderWithNode(element: ReactElement, node: Record<string, unknown>): ReactTestRenderer {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(element, {
        createNodeMock: () => ({ measureInWindow, ...node }),
        unstable_isConcurrent: true,
      } as Parameters<typeof create>[1]);
    });
    mounted.push(renderer as ReactTestRenderer);
    return renderer as ReactTestRenderer;
  }

  it('publishes on the surface of the Modal it is in, asking native nothing', () => {
    renderWithNode(<BugseeSecure />, {
      __internalInstanceHandle: fiberUnder({ tag: 5, type: 'RCTView' }, modalHost(), { tag: 3, type: null }),
    });

    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(0, MODAL_TAG, MEASURED);
    expect(native.setSecureRectangles).not.toHaveBeenCalled();
    expect(native.secureSurfaceOrigin).not.toHaveBeenCalled();
  });

  it('a view outside every Modal publishes on the main surface', () => {
    renderWithNode(<BugseeSecure />, {
      __internalInstanceHandle: fiberUnder({ tag: 5, type: 'RCTView' }, { tag: 3, type: null }),
    });

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, MEASURED);
    expect(native.setSecureRectanglesOnSurface).not.toHaveBeenCalled();
  });

  it('a view with no fiber publishes on the main surface', () => {
    renderWithNode(<BugseeSecure />, {});

    expect(native.setSecureRectangles).toHaveBeenLastCalledWith(0, MEASURED);
  });

  // Never the main surface: native serves a surface whose origin it cannot
  // find as the whole display.
  it('a Modal whose tag cannot be read publishes on the unknown-Modal surface', () => {
    renderWithNode(<BugseeSecure />, { __internalInstanceHandle: fiberUnder(modalHost(null)) });

    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(0, -1, MEASURED);
    expect(native.setSecureRectangles).not.toHaveBeenCalled();
  });

  it('reads its surface once per mount, however often it measures', () => {
    renderWithNode(<BugseeSecure />, { __internalInstanceHandle: fiberUnder(modalHost()) });

    tick(5);

    expect(tagReads).toHaveLength(1);
    expect(measureInWindow.mock.calls.length).toBeGreaterThan(5);
  });

  it('reads it again after being re-enabled', () => {
    const node = { __internalInstanceHandle: fiberUnder(modalHost()) };
    const renderer = renderWithNode(<BugseeSecure />, node);

    update(renderer, <BugseeSecure enabled={false} />);
    update(renderer, <BugseeSecure enabled />);

    expect(tagReads).toHaveLength(2);
  });

  it('removes its rectangle from that surface on unmount', () => {
    const renderer = renderWithNode(<BugseeSecure />, { __internalInstanceHandle: fiberUnder(modalHost()) });

    act(() => renderer.unmount());

    expect(native.setSecureRectanglesOnSurface).toHaveBeenLastCalledWith(0, MODAL_TAG, []);
  });

  // Same as any failed measurement: nothing is published, and the next
  // measurement tries again.
  it('a fiber tree that throws while it is read publishes nothing and warns once', () => {
    const fiber = { tag: 5, type: 'RCTView' };
    const failure = new Error('torn fiber');
    Object.defineProperty(fiber, 'return', {
      get(): never {
        throw failure;
      },
    });

    renderWithNode(<BugseeSecure />, { __internalInstanceHandle: fiber });
    tick(2);

    expect(native.setSecureRectangles).not.toHaveBeenCalled();
    expect(native.setSecureRectanglesOnSurface).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Bugsee] BugseeSecure could not measure', failure);
  });
});
