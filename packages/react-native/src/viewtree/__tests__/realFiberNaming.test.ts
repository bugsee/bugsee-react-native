/**
 * `fakeFibers.ts`'s ForwardRef/Memo/SimpleMemo fixtures (`forwardRefFiber`,
 * `memoFiber`, `simpleMemoFiber`) are hand-built to mirror what React's own
 * reconciler puts on a fiber — this test cross-checks that claim against a
 * *real* fiber tree instead of trusting the fixtures on their own word. It
 * is the only file in `viewtree/` that imports `react`/`react-test-renderer`;
 * `walk.ts` and `fiber.ts` stay free of both.
 *
 * `react-test-renderer` is deprecated upstream; React Native's own jest setup
 * sets `IS_REACT_NATIVE_TEST_ENVIRONMENT` to silence the one warning that
 * gates on it (checked when `.create()` runs, so setting it right before is
 * enough) — nothing else here is muted.
 */
(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { createElement, forwardRef, memo } from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { WindowRect } from '../fiber';
import type { WalkEnv } from '../walk';
import { buildViewTree } from '../walk';

const RECT: WindowRect = { x: 0, y: 0, width: 10, height: 10 };

function makeEnv(): WalkEnv {
  return {
    // Every host fiber built by react-test-renderer measures the same,
    // fixed rect — real measurement is `fiber.ts`'s concern, not `walk.ts`'s.
    measure: () => RECT,
    isSecureBoundary: () => false,
    isWrapper: () => false,
    platform: 'ios',
    scale: 1,
    originX: 0,
    originY: 0,
    now: () => 0,
  };
}

describe('compositeClassName against a real fiber tree', () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('names memo(fn), memo(forwardRef(fn)), forwardRef(fn) and a displayName’d component from their real fibers', () => {
    function PlainInner() {
      return createElement('View', { testID: 'plain-inner' });
    }
    const Memoized = memo(PlainInner);

    const ForwardRefComp = forwardRef(function InnerFR() {
      return createElement('View', { testID: 'fr-inner' });
    });
    const MemoizedForwardRef = memo(ForwardRefComp);

    function WithDisplayName() {
      return createElement('View', { testID: 'display-name-inner' });
    }
    WithDisplayName.displayName = 'CustomName';

    act(() => {
      renderer = create(
        createElement(
          'View',
          null,
          createElement(Memoized, { key: 'memo' }),
          createElement(MemoizedForwardRef, { key: 'memo-fr' }),
          createElement(ForwardRefComp, { key: 'fr' }),
          createElement(WithDisplayName, { key: 'dn' }),
        ),
      );
    });

    // react-test-renderer's `TestInstance` (`.root`) carries the real Fiber
    // on `_fiber` — an internal, but the only way to reach one from outside
    // the renderer, and exactly what `fiberRootOf` (`fiber.ts`) would reach
    // via `__internalInstanceHandle` in a real app.
    const fiber = (renderer?.root as unknown as { _fiber: unknown })._fiber;
    expect(fiber).toBeDefined();

    const tree = buildViewTree([{ current: fiber as never }], makeEnv());
    // `fiber` is the outer `<View>`'s own fiber (react-test-renderer's
    // `TestInstance` corresponds to the element passed to `create()`), so it
    // is itself the surface's one host child; its composite children are one
    // level deeper.
    const outerView = tree?.subitems?.[0]?.subitems?.[0];
    expect(outerView?.class_name).toBe('View');
    const topLevelNames = outerView?.subitems?.map((n) => n.class_name);

    // `Memoized` (a plain function, no compare, no defaultProps) downgrades
    // to SimpleMemo on React's own first render and is named directly.
    // `MemoizedForwardRef` does NOT downgrade (its wrapped type is not a
    // plain function): the Memo fiber itself has no useful name of its own
    // (nothing sets a displayName on the memo() result), so it is
    // "Anonymous" — its child, a separate ForwardRef fiber, is named
    // "InnerFR" in its own right and is what actually carries the content.
    expect(topLevelNames).toEqual(['PlainInner', 'Anonymous', 'InnerFR', 'CustomName']);

    const memoizedForwardRefNode = outerView?.subitems?.[1];
    expect(memoizedForwardRefNode?.options.kind).toBe('composite');
    expect(memoizedForwardRefNode?.subitems?.[0]?.class_name).toBe('InnerFR');
  });
});
