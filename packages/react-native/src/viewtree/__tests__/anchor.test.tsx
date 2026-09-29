/**
 * `wrap` never talks to native itself -- `registerAnchor`/`unregisterAnchor`/
 * `markWrapComponent` (`../requests`) are mocked throughout, so a failure
 * here means `wrap`'s own rendering or lifecycle wiring is wrong, never that
 * `requests.ts` misbehaved (that module has its own tests).
 */
import { StrictMode, act, createElement, forwardRef, memo } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';

jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('../requests', () => ({
  __esModule: true,
  registerAnchor: jest.fn(),
  unregisterAnchor: jest.fn(),
  markWrapComponent: jest.fn(),
}));

import { registerAnchor, unregisterAnchor, markWrapComponent } from '../requests';
import { VH_ANCHOR_NATIVE_ID, wrap } from '../anchor';

// See BugseeSecure.test.tsx for why these two flags are set here: they gate
// react-test-renderer's own deprecation message and enable `act()` under a
// concurrent ("Fabric-like") root, without muting anything else.
(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: ReactTestRenderer[] = [];

function render(element: ReactElement, createNodeMock?: (element: unknown) => unknown): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, {
      createNodeMock: createNodeMock ?? (() => ({})),
      unstable_isConcurrent: true,
    } as Parameters<typeof create>[1]);
  });
  mounted.push(renderer as ReactTestRenderer);
  return renderer as ReactTestRenderer;
}

function update(renderer: ReactTestRenderer, element: ReactElement): void {
  act(() => renderer.update(element));
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  act(() => mounted.forEach((renderer) => renderer.unmount()));
  mounted = [];
});

interface RootProps {
  label: string;
}

function Root({ label }: RootProps): ReactElement {
  return createElement('root-marker', { label });
}

describe('wrap', () => {
  it("renders the root with its props", () => {
    const Wrapped = wrap(Root);
    const renderer = render(<Wrapped label="hello" />);

    const marker = renderer.root.findByType('root-marker' as never);
    expect(marker.props.label).toBe('hello');
  });

  it("renders an anchor that is zero-size, absolute, non-collapsable, and does not intercept touches", () => {
    const Wrapped = wrap(Root);
    const renderer = render(<Wrapped label="x" />);

    const anchor = renderer.root.findByType('View' as never);
    expect(anchor.props.nativeID).toBe(VH_ANCHOR_NATIVE_ID);
    expect(anchor.props.collapsable).toBe(false);
    expect(anchor.props.pointerEvents).toBe('none');
    expect(anchor.props.style).toEqual({ position: 'absolute', width: 0, height: 0 });
  });

  it('registers the anchor instance on mount and unregisters the same instance on unmount', () => {
    const instance = { marker: 'anchor-instance' };
    const Wrapped = wrap(Root);
    const renderer = render(<Wrapped label="x" />, () => instance);

    expect(registerAnchor).toHaveBeenCalledTimes(1);
    expect(registerAnchor).toHaveBeenCalledWith(instance);
    expect(unregisterAnchor).not.toHaveBeenCalled();

    act(() => renderer.unmount());
    mounted = mounted.filter((r) => r !== renderer);

    expect(unregisterAnchor).toHaveBeenCalledTimes(1);
    expect(unregisterAnchor).toHaveBeenCalledWith(instance);
  });

  it("names the wrapped root in its displayName", () => {
    function Named(): ReactElement {
      return createElement('root-marker');
    }

    const Wrapped = wrap(Named);

    expect(Wrapped.displayName).toBe('BugseeRoot(Named)');
  });

  it('falls through to the function name when displayName is set but empty', () => {
    function Named(): ReactElement {
      return createElement('root-marker');
    }
    Named.displayName = '';

    const Wrapped = wrap(Named);

    expect(Wrapped.displayName).toBe('BugseeRoot(Named)');
  });

  it('falls back to an explicit displayName over the function name when the root has one', () => {
    function Named(): ReactElement {
      return createElement('root-marker');
    }
    Named.displayName = 'CustomName';

    const Wrapped = wrap(Named);

    expect(Wrapped.displayName).toBe('BugseeRoot(CustomName)');
  });

  it('falls all the way back to Anonymous when the root has neither a displayName nor a usable name', () => {
    const anon = () => createElement('root-marker');
    Object.defineProperty(anon, 'name', { value: '' });

    const Wrapped = wrap(anon as unknown as typeof Root);

    expect(Wrapped.displayName).toBe('BugseeRoot(Anonymous)');
  });

  // Not a real caller (the TS signature requires a `ComponentType<P>`), but
  // `nameOf`'s own guard exists specifically so a non-object, non-function
  // value -- `null` included, despite `typeof null === 'object'` -- degrades
  // to `'Anonymous'` rather than crashing on a `.displayName` read off it.
  it('does not throw and falls back to Anonymous for a nullish root', () => {
    let Wrapped!: ReturnType<typeof wrap<RootProps>>;
    expect(() => {
      Wrapped = wrap(null as unknown as typeof Root);
    }).not.toThrow();

    expect(Wrapped.displayName).toBe('BugseeRoot(Anonymous)');
  });

  it('tags the returned component as a wrap() root', () => {
    const Wrapped = wrap(Root);

    expect(markWrapComponent).toHaveBeenCalledWith(Wrapped);
  });

  it('registers only once across re-renders -- the effect does not re-run on every update', () => {
    const instance = { marker: 'anchor-instance' };
    const Wrapped = wrap(Root);
    const renderer = render(<Wrapped label="one" />, () => instance);

    update(renderer, <Wrapped label="two" />);
    update(renderer, <Wrapped label="three" />);

    expect(registerAnchor).toHaveBeenCalledTimes(1);
    expect(unregisterAnchor).not.toHaveBeenCalled();
  });

  it('does not register when the anchor ref never resolves to a host instance', () => {
    const Wrapped = wrap(Root);
    render(<Wrapped label="x" />, () => null);

    expect(registerAnchor).not.toHaveBeenCalled();
  });

  it("VH_ANCHOR_NATIVE_ID has the SDK's expected literal value", () => {
    expect(VH_ANCHOR_NATIVE_ID).toBe('__bugsee_view_tree_anchor');
  });

  // `React.memo(...)` returns a plain object (a `MemoExoticComponent`), not a
  // function -- it has no `.name` of its own. A review round found that an
  // earlier `nameOf` (`displayName ?? name ?? 'Anonymous'`-shaped, gated by a
  // `typeof … === 'string'` check) would throw reading `.length` off that
  // missing `.name` under one specific mutation, and more importantly never
  // produced anything better than `'Anonymous'` for a memoized root even
  // un-mutated. `wrap` must not throw for it, and should name it usefully.
  it('does not throw for a memoized root, and names it after the wrapped component', () => {
    function MemoInner(): ReactElement {
      return createElement('root-marker');
    }
    const Memoized = memo(MemoInner) as unknown as ComponentType<RootProps>;

    let Wrapped!: ComponentType<RootProps>;
    expect(() => {
      Wrapped = wrap(Memoized);
    }).not.toThrow();
    expect(Wrapped.displayName).toBe('BugseeRoot(MemoInner)');

    expect(() => render(<Wrapped label="x" />)).not.toThrow();
  });

  // `React.forwardRef(...)` is likewise a plain object, carrying the render
  // function on `.render` rather than `.type` -- `nameOf` must unwrap that
  // too, the same way `walk.ts`'s own composite naming does.
  it('does not throw for a forwardRef root, and names it after the render function', () => {
    function renderInner(): ReactElement {
      return createElement('root-marker');
    }
    const Forwarded = forwardRef(renderInner) as unknown as ComponentType<RootProps>;

    let Wrapped!: ComponentType<RootProps>;
    expect(() => {
      Wrapped = wrap(Forwarded);
    }).not.toThrow();
    expect(Wrapped.displayName).toBe('BugseeRoot(renderInner)');

    expect(() => render(<Wrapped label="x" />)).not.toThrow();
  });

  // Dev-only `<StrictMode>` double-invokes a layout effect's mount to surface
  // missing cleanup: register -> unregister -> register. `wrap`'s own cleanup
  // (`unregisterAnchor`) is exactly what makes that safe -- balanced, and
  // ending registered, rather than leaking a registration or ending
  // unregistered.
  it('stays balanced under StrictMode, ending registered', () => {
    const instance = { marker: 'anchor-instance' };
    const Wrapped = wrap(Root);

    render(createElement(StrictMode, null, createElement(Wrapped, { label: 'x' })), () => instance);

    expect(registerAnchor).toHaveBeenCalledTimes(2);
    expect(unregisterAnchor).toHaveBeenCalledTimes(1);
    const registerCalls = (registerAnchor as jest.Mock).mock.invocationCallOrder;
    const unregisterCalls = (unregisterAnchor as jest.Mock).mock.invocationCallOrder;
    expect(Math.max(...registerCalls)).toBeGreaterThan(Math.max(...unregisterCalls));
  });
});
