/**
 * A review round (fix round 1, I2) found that every other test in this
 * package exercises `isWrapper`/`isSecureBoundary` against HAND-BUILT fake
 * fibers (`requests.test.ts`'s "the real walk env"), with `BugseeSecure`'s
 * identity typed in by hand. That proves the comparison itself is right, but
 * not that the fiber React actually builds for `<BugseeSecure>` -- or for
 * `wrap`'s own `BugseeRoot`/anchor -- still matches it.
 *
 * This file renders a REAL app through the REAL `wrap`, `requests.ts` and
 * `walk.ts`, with only `react-native`, `NativeBugsee` and the renderer's own
 * `RendererProxy` module mocked (the same three seams every other real-render
 * test in this package mocks, e.g. `BugseeSecure.test.tsx`). A change that
 * makes `BugseeSecure` a `forwardRef`, or breaks `wrap`'s own identity
 * marking, would silently ship `testID`/`nativeID` under secure content --
 * this is what would catch it.
 */
import { Fragment, act, createElement } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';

const RENDERER_PROXY_PATH = 'react-native/Libraries/ReactNative/RendererProxy';

jest.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'android' },
  PixelRatio: { get: () => 2 },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { native } from '../../__mocks__/native';
import { BugseeSecure } from '../../secure/BugseeSecure';
import { VH_ANCHOR_NATIVE_ID } from '../constants';
import { wrap } from '../anchor';

const View = 'View';

// See BugseeSecure.test.tsx for why these two flags are set here: they gate
// react-test-renderer's own deprecation message and enable `act()` under a
// concurrent ("Fabric-like") root, without muting anything else.
(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Measures a host fiber from a map keyed by its own `testID`, the way the brief's fix asks -- not by identity, since these are REAL fibers this file does not build by hand. */
function mockMeasuringByTestID(rects: Record<string, Rect>): void {
  jest.doMock(RENDERER_PROXY_PATH, () => ({
    getPublicInstanceFromInternalInstanceHandle: (fiber: { memoizedProps?: { testID?: unknown } }) => ({
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
        const testID = fiber.memoizedProps?.testID;
        const rect = typeof testID === 'string' ? rects[testID] : undefined;
        if (rect !== undefined) {
          callback(rect.x, rect.y, rect.width, rect.height);
        }
        // No matching rect: no callback at all, matching measureHostFiber's
        // "delivered === false" -> unmeasurable contract for the anchor and
        // any other node this fixture does not care to measure.
      },
    }),
  }));
}

interface ManagedNode {
  id: string;
  class_name: string;
  bounds: number[];
  options: {
    kind: string;
    secure?: true;
    tag?: string;
    native_id?: string;
  };
  subitems?: ManagedNode[];
}

/** Every node anywhere in the tree, flattened. */
function flatten(node: ManagedNode): ManagedNode[] {
  return [node, ...(node.subitems ?? []).flatMap(flatten)];
}

let mounted: ReactTestRenderer[] = [];

function renderApp(element: ReactElement, createNodeMock: () => unknown): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, {
      createNodeMock,
      unstable_isConcurrent: true,
    } as Parameters<typeof create>[1]);
  });
  mounted.push(renderer as ReactTestRenderer);
  return renderer as ReactTestRenderer;
}

afterEach(() => {
  act(() => mounted.forEach((renderer) => renderer.unmount()));
  mounted = [];
  jest.dontMock(RENDERER_PROXY_PATH);
  jest.resetModules();
});

describe('a real render through wrap -> requests.ts -> walk.ts', () => {
  it('redacts under a real <BugseeSecure>, keeps the open node tagged, and excludes BugseeRoot(App) and the anchor', () => {
    mockMeasuringByTestID({
      plain: { x: 1, y: 2, width: 10, height: 20 },
      s: { x: 0, y: 0, width: 30, height: 30 },
      inner: { x: 5, y: 5, width: 10, height: 10 },
    });
    native.reset();

    function App(): ReactElement {
      return createElement(
        Fragment,
        null,
        createElement(View, { testID: 'plain' }),
        createElement(
          BugseeSecure,
          { testID: 's', nativeID: 'n' },
          createElement(View, { testID: 'inner', nativeID: 'inner-n' }),
        ),
      );
    }

    const Wrapped = wrap(App);

    // ONE shared instance for every host component in the tree -- including
    // the anchor's own `<View>` -- so that mutating it once, after render,
    // retroactively gives the ALREADY-REGISTERED anchor instance a usable
    // `__internalInstanceHandle`. `registerAnchor` stores the object BY
    // REFERENCE, not a snapshot of it, and `fiberRootOf` is only ever called
    // later, lazily, when a 'vh' request actually arrives.
    const sharedInstance: { measureInWindow: () => void; __internalInstanceHandle?: unknown } = {
      measureInWindow: () => {},
    };
    const renderer = renderApp(createElement(Wrapped), () => sharedInstance);

    const anchorInstance = renderer.root.findByProps({ nativeID: VH_ANCHOR_NATIVE_ID });
    sharedInstance.__internalInstanceHandle = (anchorInstance as unknown as { _fiber: unknown })._fiber;

    native.emitDataRequest({ requestId: 'dr-integration', type: 'vh', originX: 0, originY: 0 });

    const call = (native.replyDataRequest as jest.Mock).mock.calls[0] as [string, string | null];
    expect(call[0]).toBe('dr-integration');
    expect(call[1]).not.toBeNull();
    const tree = JSON.parse(call[1] as string) as ManagedNode;
    const nodes = flatten(tree);

    // The open node keeps its tag.
    const plainNode = nodes.find((n) => n.options.tag === 'plain');
    expect(plainNode).toBeDefined();
    expect(plainNode?.options.secure).toBeUndefined();

    // The BugseeSecure boundary itself (the View it renders, carrying testID
    // "s"/nativeID "n") and the inner host under it are both secure, with
    // neither tag nor native_id -- never "s"/"n"/"inner"/"inner-n" anywhere.
    const secureNodes = nodes.filter((n) => n.options.secure === true);
    expect(secureNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of secureNodes) {
      expect(node.options.tag).toBeUndefined();
      expect(node.options.native_id).toBeUndefined();
    }
    expect(nodes.some((n) => n.options.tag === 's' || n.options.tag === 'inner')).toBe(false);
    expect(nodes.some((n) => n.options.native_id === 'n' || n.options.native_id === 'inner-n')).toBe(false);

    // Neither the wrap component nor its anchor appear at all.
    expect(nodes.some((n) => n.class_name === 'BugseeRoot(App)')).toBe(false);
    expect(nodes.some((n) => n.options.native_id === VH_ANCHOR_NATIVE_ID)).toBe(false);
  });

  // Mutation check (done by hand, per the fix-round instructions, not left as
  // a permanent second test): with `isSecureBoundary` in `requests.ts`
  // temporarily changed to `return false;`, the test above failed as
  // expected, at `expect(secureNodes.length).toBeGreaterThanOrEqual(2)` --
  // `secureNodes.length` was 0 (`isSecureBoundary` never matched, so nothing
  // was marked secure at all). Reverted before commit; see the fix-round
  // report for the recorded run.
});
