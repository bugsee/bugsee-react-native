/**
 * `buildViewTree` turns a fiber tree into the privacy-safe managed view tree
 * the native side eventually serialises. Every test here uses fake fibers
 * (`fakeFibers.ts`), never React or `react-test-renderer`: `walk.ts` is pure,
 * and its contract is entirely about what it does with the `FiberLike` shape
 * and the `WalkEnv` it is given. `realFiberNaming.test.ts` cross-checks the
 * naming-sensitive fixtures (ForwardRef/Memo/SimpleMemo) against real fibers.
 *
 * `react-native` / `NativeBugsee` are mocked only so the one test that pulls
 * `requests.ts`'s real `isWrapper` (RootErrorReporter identity) can load that
 * module; `walk.ts` itself still never touches them.
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PixelRatio: { get: () => 2 },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { FiberTag } from '../fiber';
import type { FiberLike, WindowRect } from '../fiber';
import type { ManagedNode, WalkEnv } from '../walk';
import { VH_MAX_DEPTH, VH_MAX_NODES, VH_TAG_MAX_LENGTH, buildViewTree } from '../walk';
import {
  buildFiberTree,
  classComponent,
  consumer,
  fiberRoot,
  fn,
  forwardRefFiber,
  fragment,
  host,
  legacyHidden,
  memoFiber,
  mode,
  offscreen,
  offscreenWithUnknownState,
  portal,
  provider,
  simpleMemoFiber,
  text,
  trackedProps,
  trackedStateNode,
} from './fakeFibers';
import type { FiberSpec } from './fakeFibers';

const RECT: WindowRect = { x: 0, y: 0, width: 10, height: 10 };

function makeEnv(overrides: Partial<WalkEnv> = {}): WalkEnv {
  return {
    measure: (fiber) => (fiber.stateNode as { rect: WindowRect | null } | null)?.rect ?? null,
    isSecureBoundary: () => false,
    isWrapper: () => false,
    platform: 'ios',
    scale: 1,
    originX: 0,
    originY: 0,
    now: () => 0,
    ...overrides,
  };
}

/** Every ManagedNode in the tree, in the order the output tree carries them (a preorder walk of the OUTPUT, independent of how `walk.ts` built it). */
function flatten(node: ManagedNode): ManagedNode[] {
  return [node, ...(node.subitems ?? []).flatMap(flatten)];
}

describe('buildViewTree', () => {
  it('emits a ReactNative root with one ReactSurface per fiber root', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', RECT)), fiberRoot(host('View', { ...RECT, width: 20 }))],
      makeEnv(),
    );

    expect(tree?.class_name).toBe('ReactNative');
    expect(tree?.options.kind).toBe('root');
    expect(tree?.subitems).toHaveLength(2);
    for (const surface of tree?.subitems ?? []) {
      expect(surface.class_name).toBe('ReactSurface');
      expect(surface.options.kind).toBe('surface');
    }
  });

  it("a host node's class_name is its host type", () => {
    const tree = buildViewTree([fiberRoot(host('RCTView', RECT))], makeEnv());
    const hostNode = tree?.subitems?.[0]?.subitems?.[0];
    expect(hostNode?.class_name).toBe('RCTView');
    expect(hostNode?.options.kind).toBe('host');
  });

  it('a non-string host type never runs an arbitrary toString', () => {
    // A malformed/hostile fiber with a non-string `type` — hardening only
    // (real host types are always strings), but a plain `String(x)` would
    // run whatever `toString` the value carries.
    let toStringCalled = false;
    const poisoned = { toString: () => ((toStringCalled = true), 'LEAK') };
    const spec: FiberSpec = { tag: FiberTag.HostComponent, type: poisoned, stateNode: { rect: RECT }, children: [] };

    const tree = buildViewTree([fiberRoot(spec)], makeEnv());

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Unknown');
    expect(toStringCalled).toBe(false);
  });

  it('a throwing .type getter on a host fiber falls back to Unknown instead of losing the node (safeHostClassName)', () => {
    const fiber = buildFiberTree(host('DoesNotMatter', RECT));
    Object.defineProperty(fiber, 'type', {
      get(): never {
        throw new Error('boom');
      },
    });

    const tree = buildViewTree([{ current: fiber }], makeEnv());
    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.class_name).toBe('Unknown');
    // Still measured and emitted (real bounds, not dropped) — the throw is
    // isolated to naming, same as `safeCompositeClassName` for composites.
    expect(node?.bounds).toEqual([0, 0, 10, 10]);
  });

  it("a composite's class_name is displayName, then name, then Anonymous", () => {
    function Named(): null {
      return null;
    }
    const withDisplayName = (): null => null;
    withDisplayName.displayName = 'Fancy';
    const anonymous = {};

    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([
            fn(withDisplayName, [host('View', RECT)]),
            fn(Named, [host('View', RECT)]),
            fn(anonymous, [host('View', RECT)]),
          ]),
        ),
      ],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['Fancy', 'Named', 'Anonymous']);
  });

  it('ForwardRef and Memo unwrap to the inner name', () => {
    function InnerForwardRef(): null {
      return null;
    }
    function InnerMemo(): null {
      return null;
    }

    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([
            forwardRefFiber(InnerForwardRef, [host('View', RECT)]),
            memoFiber(InnerMemo, [host('View', RECT)]),
          ]),
        ),
      ],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['InnerForwardRef', 'InnerMemo']);
  });

  it('SimpleMemo (tag 15) is named from fiber.type directly — the memo wrapper survives only on elementType', () => {
    function InnerSimpleMemo(): null {
      return null;
    }

    const tree = buildViewTree([fiberRoot(simpleMemoFiber(InnerSimpleMemo, [host('View', RECT)]))], makeEnv());

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('InnerSimpleMemo');
  });

  // N6: `compositeClassName`'s SimpleMemo branch calls
  // `preferOuterName(fiber.elementType, fiber.type)`, i.e.
  // `displayNameOf(fiber.elementType) ?? nameOf(fiber.type)`. React never
  // actually builds a SimpleMemo fiber with `elementType: null` (the memo
  // wrapper always survives there) -- but `displayNameOf`'s own
  // `value !== null` guard must still hold at this call site: without it,
  // `typeof null === 'object'` is true, so `displayNameOf` would read
  // `.displayName` off `null` and throw, and `safeCompositeClassName`'s
  // catch would report 'Anonymous' instead of `fiber.type`'s real name.
  it('SimpleMemo still names from fiber.type when elementType is null, a shape React never builds', () => {
    function NamedInner(): null {
      return null;
    }
    const spec: FiberSpec = {
      tag: FiberTag.SimpleMemo,
      type: NamedInner,
      elementType: null,
      children: [host('View', RECT)],
    };

    const tree = buildViewTree([fiberRoot(spec)], makeEnv());

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('NamedInner');
  });

  it("ForwardRef, Memo and SimpleMemo prefer the wrapper's own displayName over the inner name", () => {
    function InnerFR(): null {
      return null;
    }
    function InnerMemo(): null {
      return null;
    }
    function InnerSimple(): null {
      return null;
    }
    const forwardRefWithDisplayName: FiberSpec = {
      tag: FiberTag.ForwardRef,
      type: { render: InnerFR, displayName: 'OuterFR' },
      children: [host('A', RECT)],
    };

    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([
            forwardRefWithDisplayName,
            memoFiber(InnerMemo, [host('B', RECT)], 'OuterMemo'),
            simpleMemoFiber(InnerSimple, [host('C', RECT)], 'OuterSimple'),
          ]),
        ),
      ],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['OuterFR', 'OuterMemo', 'OuterSimple']);
  });

  // N3 (fix round 2): `memo(forwardRef(fn))` is a Memo fiber whose `.type.type`
  // is the ForwardRef *wrapper object* `{ render, displayName? }`, not `fn`
  // itself — a case none of the tests above exercise (they only ever pass a
  // plain function as the Memo's inner type). Each of the four levels a name
  // could come from is tested individually, in priority order, so any one of
  // them winning over another is caught precisely.
  describe('memo(forwardRef(fn)): the Memo fiber unwraps one further level (N3)', () => {
    it('names from the innermost render function when neither wrapper has a displayName', () => {
      function InnermostRender(): null {
        return null;
      }
      const tree = buildViewTree(
        [fiberRoot(memoFiber({ render: InnermostRender }, [host('View', RECT)]))],
        makeEnv(),
      );
      expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('InnermostRender');
    });

    it("the ForwardRef wrapper's own displayName wins over the render function's name (outer Memo wrapper has none)", () => {
      function InnermostRender(): null {
        return null;
      }
      const tree = buildViewTree(
        [fiberRoot(memoFiber({ render: InnermostRender, displayName: 'MiddleFR' }, [host('View', RECT)]))],
        makeEnv(),
      );
      expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('MiddleFR');
    });

    it("the outer Memo wrapper's displayName wins over the ForwardRef wrapper's own displayName — not `??` degrading to `&&`", () => {
      function InnermostRender(): null {
        return null;
      }
      const tree = buildViewTree(
        [
          fiberRoot(
            memoFiber({ render: InnermostRender, displayName: 'MiddleFR' }, [host('View', RECT)], 'OuterMemo'),
          ),
        ],
        makeEnv(),
      );
      // `displayNameOf(fiber.type) ?? displayNameOf(inner) ?? nameOf(render)`:
      // the outer's non-null result must short-circuit the rest outright, not
      // merely be treated as "truthy" and used to select between the other
      // two (which `&&` in place of `??` would do, and would still land on
      // 'MiddleFR' here since 'OuterMemo' is truthy).
      expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('OuterMemo');
    });

    it('an outer displayName wins even when the inner value is not object-shaped at all (falls through to the plain preferOuterName path)', () => {
      const tree = buildViewTree(
        [fiberRoot(memoFiber(null, [host('View', RECT)], 'OuterOnly'))],
        makeEnv(),
      );
      // `inner` (`null`) is not `{ render }`-shaped, so this takes the plain
      // `preferOuterName(fiber.type, inner)` path, not the ForwardRef-unwrap
      // one — proves the `typeof inner === 'object' && inner !== null` guard
      // actually gates entry into that branch, rather than the branch being
      // reached (and only surviving by also landing on 'Anonymous') for a
      // `null` inner too.
      expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('OuterOnly');
    });

    it("an outer displayName wins even when the inner value is a primitive (typeof !== 'object'), not just null — the `typeof inner === 'object'` guard itself is load-bearing", () => {
      // Distinct from the `null` case above: `typeof null === 'object'` is
      // already true on its own (a JS quirk), so that test alone cannot
      // discriminate a mutant that forces the `typeof inner === 'object'`
      // clause specifically to `true`. A string does: `typeof` a string is
      // `'string'`, never `'object'`, so only the *correct* short-circuit
      // (never entering the `'render' in inner` branch, where `in` on a
      // primitive throws) reaches `preferOuterName`'s outer-displayName
      // check at all.
      const tree = buildViewTree(
        [fiberRoot(memoFiber('not-an-object-or-function', [host('View', RECT)], 'OuterWinsOverPrimitive'))],
        makeEnv(),
      );
      expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('OuterWinsOverPrimitive');
    });
  });

  it('an empty wrapper displayName falls through to the inner name, the same as no displayName at all', () => {
    function InnerFR(): null {
      return null;
    }
    const forwardRefWithEmptyDisplayName: FiberSpec = {
      tag: FiberTag.ForwardRef,
      type: { render: InnerFR, displayName: '' },
      children: [host('A', RECT)],
    };

    const tree = buildViewTree([fiberRoot(forwardRefWithEmptyDisplayName)], makeEnv());

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('InnerFR');
  });

  it('a plain FunctionComponent is named from its own type, never from an unrelated elementType', () => {
    // FunctionComponent/ClassComponent are named via `nameOf(fiber.type)`
    // only — `elementType` (SimpleMemo's own unwrap target) must never be
    // consulted for these tags, even when it happens to be a different
    // object with a name of its own.
    const spec: FiberSpec = {
      tag: FiberTag.FunctionComponent,
      type: {},
      elementType: { displayName: 'ShouldNeverBeUsed' },
      children: [host('A', RECT)],
    };

    const tree = buildViewTree([fiberRoot(spec)], makeEnv());

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Anonymous');
  });

  it('fragments, providers, modes and portals are flattened into their parent', () => {
    const tree = buildViewTree(
      [fiberRoot(fragment([provider([consumer([mode([portal([host('View', RECT)])])])])]))],
      makeEnv(),
    );

    const surface = tree?.subitems?.[0];
    expect(surface?.subitems).toHaveLength(1);
    expect(surface?.subitems?.[0]?.class_name).toBe('View');
  });

  it('HostText is never emitted', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', RECT, [text(), host('Inner', RECT)]))],
      makeEnv(),
    );

    const outer = tree?.subitems?.[0]?.subitems?.[0];
    expect(outer?.subitems).toHaveLength(1);
    expect(outer?.subitems?.[0]?.class_name).toBe('Inner');
  });

  it('no prop other than testID and nativeID is ever read off a host fiber', () => {
    const reads = new Set<string>();
    const props = trackedProps(
      { testID: 'tid', nativeID: 'nid', onPress: () => undefined, style: { flex: 1 }, children: 'nope' },
      reads,
    );

    const tree = buildViewTree([fiberRoot(host('View', RECT, [], props))], makeEnv());

    expect(tree).not.toBeNull();
    expect(reads.size).toBeGreaterThan(0);
    for (const key of reads) {
      expect(['testID', 'nativeID']).toContain(key);
    }
  });

  it("a composite's props are never read at all — not even testID/nativeID", () => {
    const reads = new Set<string>();
    const props = trackedProps({ testID: 'composite-tid', nativeID: 'composite-nid', other: 1 }, reads);

    const tree = buildViewTree(
      [fiberRoot(fn(function Composite() { return null; }, [host('Inner', RECT)], props))],
      makeEnv(),
    );

    expect(tree).not.toBeNull();
    expect(reads.size).toBe(0);
  });

  it("a composite's testID/nativeID are never emitted, host nodes only per the plan", () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fn(function Composite() { return null; }, [host('Inner', RECT)], { testID: 'composite-tid', nativeID: 'composite-nid' }),
        ),
      ],
      makeEnv(),
    );

    const composite = tree?.subitems?.[0]?.subitems?.[0];
    expect(composite?.options.kind).toBe('composite');
    expect(composite?.options.tag).toBeUndefined();
    expect(composite?.options.native_id).toBeUndefined();
    expect(Object.keys(composite?.options ?? {})).not.toContain('tag');
    expect(Object.keys(composite?.options ?? {})).not.toContain('native_id');
  });

  it("nothing is read off a host's stateNode beyond what the environment's own measure() touches", () => {
    const reads = new Set<string>();
    const trackedNode = trackedStateNode({ rect: RECT }, reads);
    const spec: FiberSpec = { tag: FiberTag.HostComponent, type: 'View', stateNode: trackedNode, children: [] };

    const tree = buildViewTree([fiberRoot(spec)], makeEnv());

    expect(tree).not.toBeNull();
    expect(reads).toEqual(new Set(['rect']));
  });

  it('nothing is read at all under a secure boundary — not testID, not nativeID, not via has/ownKeys', () => {
    const reads = new Set<string>();
    const SecureBoundary = {};
    const props = trackedProps({ testID: 'x', nativeID: 'y', other: 1 }, reads);

    const tree = buildViewTree(
      [fiberRoot(fn(SecureBoundary, [host('Inner', RECT, [], props)]))],
      makeEnv({ isSecureBoundary: (fiber) => fiber.type === SecureBoundary }),
    );

    expect(tree).not.toBeNull();
    expect(reads.size).toBe(0);
  });

  it('testID becomes options.tag and nativeID options.native_id', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', RECT, [], { testID: 'abc', nativeID: 'def' }))],
      makeEnv(),
    );

    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.options.tag).toBe('abc');
    expect(node?.options.native_id).toBe('def');
  });

  it('a testID of 100 characters is withheld, and one of exactly 99 is kept', () => {
    const kept = 'a'.repeat(VH_TAG_MAX_LENGTH);
    const withheld = 'a'.repeat(VH_TAG_MAX_LENGTH + 1);

    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([
            host('KeptView', RECT, [], { testID: kept, nativeID: kept }),
            host('WithheldView', RECT, [], { testID: withheld, nativeID: withheld }),
          ]),
        ),
      ],
      makeEnv(),
    );

    const [keptNode, withheldNode] = tree?.subitems?.[0]?.subitems ?? [];
    expect(keptNode?.options.tag).toBe(kept);
    expect(keptNode?.options.native_id).toBe(kept);
    expect(withheldNode?.options.tag).toBeUndefined();
    expect(withheldNode?.options.native_id).toBeUndefined();
  });

  it('a throwing testID getter withholds the tag instead of crashing the walk', () => {
    const props: { testID?: string } = {};
    Object.defineProperty(props, 'testID', {
      get(): string {
        throw new Error('boom');
      },
    });

    const tree = buildViewTree([fiberRoot(host('View', RECT, [], props))], makeEnv());

    // Not just "no tag" — the host itself must still be there. A tagOptions
    // that returned `undefined` instead of `{}` on the throw would make the
    // host vanish entirely instead of merely losing its tag, and `undefined`
    // would satisfy `.options.tag === undefined` just as well.
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('View');
    expect(tree?.subitems?.[0]?.subitems?.[0]?.options.tag).toBeUndefined();
  });

  it('a throwing env.measure treats the host as unmeasurable (dropped/promoted), not as measured', () => {
    const tree = buildViewTree(
      [fiberRoot(host('Outer', RECT, [host('InnerShown', RECT)]))],
      makeEnv({
        measure: (fiber) =>
          fiber.type === 'Outer' ? (() => { throw new Error('boom'); })() : RECT,
      }),
    );

    // "Outer" itself never appears (unmeasurable), but its child is promoted
    // and still shown — the same as a `measure` that plainly returned null.
    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['InnerShown']);
  });

  it('a throwing env.isSecureBoundary fails CLOSED — treated as "secure", not as "not secure" (N2)', () => {
    // The opposite failure direction from every other guarded `env` call:
    // this one withholds data on failure (privacy over completeness)
    // instead of degrading to a smaller-but-still-shown payload. See
    // `safeIsSecureBoundary`'s doc comment in walk.ts. A real `testID` is
    // given here specifically so this test can prove it is actually
    // withheld, not merely that `secure` reads `true` on a node with
    // nothing to withhold in the first place.
    const tree = buildViewTree(
      [fiberRoot(host('View', RECT, [], { testID: 'would-leak' }))],
      makeEnv({
        isSecureBoundary: () => {
          throw new Error('boom');
        },
      }),
    );

    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.options.secure).toBe(true);
    expect(node?.options.tag).toBeUndefined();
    expect(node?.options.native_id).toBeUndefined();
  });

  it('a throwing env.isWrapper is treated as "not the wrapper", not as "is the wrapper" (the fiber is still emitted)', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', RECT))],
      makeEnv({
        isWrapper: () => {
          throw new Error('boom');
        },
      }),
    );

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('View');
  });

  it('a non-finite or non-number env.now() is treated as 0, and the walk proceeds normally', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', RECT))],
      makeEnv({ now: () => 'not-a-number' as unknown as number }),
    );

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('View');
    expect(tree?.truncated).toBeUndefined();
  });

  it('a throwing env.now() is treated as 0, the same as a non-finite reading, not as a crash', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', RECT))],
      makeEnv({
        now: () => {
          throw new Error('boom');
        },
      }),
    );

    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('View');
    expect(tree?.truncated).toBeUndefined();
  });

  it('env.now() throwing on its first call only still lets the time budget trip on a later, valid reading', () => {
    // Mirrors "a clock that is corrupted only on its first call..." above,
    // but via a genuine throw (exercising `safeNow`'s `catch`) rather than a
    // non-finite return value (its `Number.isFinite` ternary) — a `catch`
    // that swallowed the error without falling back to `0` would leave
    // `ctx.startedAt` as `undefined`, making every later `now() - startedAt`
    // a `NaN`, which is never `> budget`, so the walk would never stop.
    let calls = 0;
    const now = (): number => {
      calls += 1;
      if (calls === 1) {
        throw new Error('boom');
      }
      return 100_000;
    };

    const tree = buildViewTree([fiberRoot(fragment([host('A', RECT), host('B', RECT)]))], makeEnv({ now }));

    expect(tree).toBeNull();
  });

  it('everything under BugseeSecure is secure and carries no tag or native_id', () => {
    const SecureBoundary = {};

    const tree = buildViewTree(
      [
        fiberRoot(
          fn(
            SecureBoundary,
            [host('Inner', RECT, [], { testID: 'nested' })],
            { testID: 'boundary' },
          ),
        ),
      ],
      makeEnv({ isSecureBoundary: (fiber) => fiber.type === SecureBoundary }),
    );

    const boundaryNode = tree?.subitems?.[0]?.subitems?.[0];
    const innerNode = boundaryNode?.subitems?.[0];

    expect(boundaryNode?.options.secure).toBe(true);
    expect(boundaryNode?.options.tag).toBeUndefined();
    expect(innerNode?.options.secure).toBe(true);
    expect(innerNode?.options.tag).toBeUndefined();
    expect(innerNode?.options.native_id).toBeUndefined();
  });

  it("a composite's bounds are the union of its emitted children", () => {
    // Non-zero origin on purpose: with a union anchored at (0, 0), computing
    // width/height by adding instead of subtracting the min from the max
    // happens to give the same answer, which would hide that bug.
    const tree = buildViewTree(
      [
        fiberRoot(
          fn(function Composite() {
            return null;
          }, [
            host('A', { x: 5, y: 5, width: 10, height: 10 }),
            host('B', { x: 20, y: 20, width: 5, height: 5 }),
          ]),
        ),
      ],
      makeEnv(),
    );

    const composite = tree?.subitems?.[0]?.subitems?.[0];
    expect(composite?.options.kind).toBe('composite');
    expect(composite?.bounds).toEqual([5, 5, 20, 20]);
    // Nothing here was cut off — a composite recursing normally must start
    // from "not truncated", not carry a stale truncated flag into a subtree
    // that never needed one.
    expect(composite?.truncated).toBeUndefined();
    expect(tree?.truncated).toBeUndefined();
  });

  it('a union of iOS bounds is rounded again, cleaning up floating-point drift from the union arithmetic', () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fn(function Composite() {
            return null;
          }, [
            host('A', { x: 0.1, y: 0, width: 10, height: 10 }),
            host('B', { x: 20.2, y: 0, width: 5, height: 5 }),
          ]),
        ),
      ],
      makeEnv({ platform: 'ios' }),
    );

    const composite = tree?.subitems?.[0]?.subitems?.[0];
    // Unrounded, `(20.2 + 5) - 0.1` is 25.099999999999998 in floating point.
    expect(composite?.bounds).toEqual([0.1, 0, 25.1, 10]);
  });

  it('a subtree with no measurable host anywhere in it is dropped', () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fn(function Composite() {
            return null;
          }, [host('Unmeasurable', null)]),
        ),
      ],
      makeEnv(),
    );

    expect(tree).toBeNull();
  });

  it('an unmeasurable host promotes its children instead of dropping the whole subtree', () => {
    const tree = buildViewTree(
      [fiberRoot(host('Unmeasurable', null, [host('StillShown', RECT)]))],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['StillShown']);
  });

  it('a hidden Offscreen subtree (memoizedState holding baseLanes/cachePool) is dropped', () => {
    const tree = buildViewTree(
      [fiberRoot(fragment([offscreen(false, [host('Hidden', RECT)]), host('Visible', RECT)]))],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['Visible']);
  });

  it('a visible Offscreen subtree (memoizedState null) is shown', () => {
    const tree = buildViewTree([fiberRoot(offscreen(true, [host('Shown', RECT)]))], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.map((n) => n.class_name)).toEqual(['Shown']);
  });

  it('an Offscreen fiber with an unrecognised memoizedState shape fails closed (dropped, not shown)', () => {
    const tree = buildViewTree(
      [fiberRoot(offscreenWithUnknownState('some-future-shape', [host('Shown', RECT)]))],
      makeEnv(),
    );

    expect(tree).toBeNull();
  });

  it('LegacyHidden is always dropped — no verified visible signal for an unstable, unexposed tag', () => {
    const tree = buildViewTree([fiberRoot(legacyHidden([host('NeverShown', RECT)]))], makeEnv());
    expect(tree).toBeNull();
  });

  it('the wrap component and the anchor are not emitted', () => {
    const Wrap = {};
    const Anchor = {};

    const tree = buildViewTree(
      [fiberRoot(fn(Wrap, [host(Anchor as unknown as string, null), host('RealApp', RECT)]))],
      makeEnv({ isWrapper: (fiber) => fiber.type === Wrap || fiber.type === Anchor }),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['RealApp']);
  });

  it('the root reporter is not emitted, and its children are', () => {
    // Uses requests.ts's real isWrapper (exported for this assertion, like
    // monotonicNow). Dropping RootErrorReporter from that predicate must fail
    // this test (manual mutate 3).
    const { RootErrorReporter } = require('../../exceptions/RootErrorReporter') as {
      RootErrorReporter: unknown;
    };
    const { isWrapper } = require('../requests') as {
      isWrapper: (fiber: FiberLike) => boolean;
    };

    const tree = buildViewTree(
      [fiberRoot(classComponent(RootErrorReporter, [host('RealApp', RECT)]))],
      makeEnv({ isWrapper }),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['RealApp']);
  });

  it('Android bounds are rounded pixels plus the origin', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', { x: 10.2, y: 20.4, width: 100.1, height: 50.3 }))],
      makeEnv({ platform: 'android', scale: 2.625, originX: 0, originY: 63 }),
    );

    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.bounds).toEqual([27, 117, 263, 132]);
  });

  it('Android bounds add the X origin, not just the Y one', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', { x: 10, y: 0, width: 5, height: 5 }))],
      makeEnv({ platform: 'android', scale: 1, originX: 7, originY: 0 }),
    );

    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.bounds).toEqual([17, 0, 5, 5]);
  });

  it('iOS bounds are points to two decimals plus the origin', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', { x: 10.126, y: 20.674, width: 5.555, height: 6.445 }))],
      makeEnv({ platform: 'ios', originX: 1, originY: 2 }),
    );

    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.bounds).toEqual([11.13, 22.67, 5.56, 6.45]);
  });

  // A <Modal> is its own React root (an Android Dialog): measureInWindow is
  // relative to it, so its nodes take that root's origin, not the request's.
  describe('a node on another React surface', () => {
    const tagged = (tag: number) => (fiber: FiberLike): number | null =>
      (fiber.memoizedProps as { tag?: number } | null)?.tag === tag ? tag : null;
    const sheet = (): FiberSpec => host('Sheet', { x: 10, y: 20, width: 5, height: 5 }, [], { tag: 77 });

    it('Android: takes the origin native resolves for its tag', () => {
      const originForNativeTag = jest.fn((tag: number) => (tag === 77 ? { x: 40, y: 200 } : null));
      const tree = buildViewTree(
        [fiberRoot(fragment([host('Main', { x: 10, y: 20, width: 5, height: 5 }), sheet()]))],
        makeEnv({ platform: 'android', scale: 2, originX: 0, originY: 63, nativeTagOf: tagged(77), originForNativeTag }),
      );

      const [main, modal] = tree?.subitems?.[0]?.subitems ?? [];
      expect(main?.bounds).toEqual([20, 103, 10, 10]);
      expect(modal?.bounds).toEqual([60, 240, 10, 10]);
      expect(originForNativeTag).toHaveBeenCalledTimes(1);
      expect(originForNativeTag).toHaveBeenCalledWith(77);
    });

    it('iOS: takes the origin native resolves for its tag', () => {
      const tree = buildViewTree(
        [fiberRoot(sheet())],
        makeEnv({ platform: 'ios', originX: 1, originY: 2, nativeTagOf: tagged(77), originForNativeTag: () => ({ x: 3.5, y: 4 }) }),
      );

      expect(tree?.subitems?.[0]?.subitems?.[0]?.bounds).toEqual([13.5, 24, 5, 5]);
    });

    it('falls back to the request origin when native knows no origin for the tag', () => {
      const tree = buildViewTree(
        [fiberRoot(sheet())],
        makeEnv({ platform: 'android', scale: 1, originX: 7, originY: 9, nativeTagOf: tagged(77), originForNativeTag: () => null }),
      );

      expect(tree?.subitems?.[0]?.subitems?.[0]?.bounds).toEqual([17, 29, 5, 5]);
    });

    it('asks nothing for a node without a tag', () => {
      const originForNativeTag = jest.fn(() => ({ x: 40, y: 200 }));
      const tree = buildViewTree(
        [fiberRoot(sheet())],
        makeEnv({ platform: 'android', scale: 1, originX: 7, originY: 9, nativeTagOf: () => null, originForNativeTag }),
      );

      expect(tree?.subitems?.[0]?.subitems?.[0]?.bounds).toEqual([17, 29, 5, 5]);
      expect(originForNativeTag).not.toHaveBeenCalled();
    });

    it('uses the request origin when the env has no tag reader', () => {
      const originForNativeTag = jest.fn(() => ({ x: 40, y: 200 }));
      const tree = buildViewTree(
        [fiberRoot(sheet())],
        makeEnv({ platform: 'android', scale: 1, originX: 7, originY: 9, originForNativeTag }),
      );

      expect(tree?.subitems?.[0]?.subitems?.[0]?.bounds).toEqual([17, 29, 5, 5]);
      expect(originForNativeTag).not.toHaveBeenCalled();
    });

    it('uses the request origin when the env has no origin resolver', () => {
      const tree = buildViewTree(
        [fiberRoot(sheet())],
        makeEnv({ platform: 'android', scale: 1, originX: 7, originY: 9, nativeTagOf: tagged(77) }),
      );

      expect(tree?.subitems?.[0]?.subitems?.[0]?.bounds).toEqual([17, 29, 5, 5]);
    });
  });

  it('stops at exactly VH_MAX_NODES nodes emitted in total — root and surface reserved up front, not overshot', () => {
    const children = Array.from({ length: VH_MAX_NODES + 5 }, (_, i) => host(`Child${i}`, RECT));
    const tree = buildViewTree([fiberRoot(fragment(children))], makeEnv());

    expect(tree).not.toBeNull();
    const all = flatten(tree as ManagedNode);
    expect(all).toHaveLength(VH_MAX_NODES);

    const surface = tree?.subitems?.[0];
    // Root (1) + surface (1) reserved up front leaves VH_MAX_NODES - 2 hosts.
    expect(surface?.subitems).toHaveLength(VH_MAX_NODES - 2);
    expect(surface?.truncated).toBe(true);
    expect(tree?.truncated).toBe(true);
  });

  it('ids stay gap-free (a strict preorder 0..n-1) even when a candidate fiber is dropped along the way', () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([
            host('A', RECT),
            fn(function DroppedComposite() {
              return null;
            }, [host('Unmeasurable', null)]),
            host('B', RECT),
          ]),
        ),
      ],
      makeEnv(),
    );

    expect(tree).not.toBeNull();
    const all = flatten(tree as ManagedNode);
    const ids = all.map((n) => Number(n.id)).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i));
  });

  it('stops at depth 64 and marks that node — and the root — truncated', () => {
    let deepest = host('Bottom', RECT);
    for (let i = 0; i < VH_MAX_DEPTH + 10; i += 1) {
      deepest = host(`Level${i}`, RECT, [deepest]);
    }

    const tree = buildViewTree([fiberRoot(deepest)], makeEnv());

    let node = tree?.subitems?.[0]?.subitems?.[0];
    let depth = 0;
    while (node?.subitems && node.subitems.length > 0) {
      node = node.subitems[0];
      depth += 1;
    }

    expect(depth).toBe(VH_MAX_DEPTH - 1);
    expect(node?.truncated).toBe(true);
    expect(node?.subitems).toBeUndefined();
    // Per the plan, only the node where the cut happened and the root need
    // to carry `truncated` — an intermediate ancestor (the surface here)
    // that fully absorbed and re-emitted its child is not itself missing
    // anything of its own.
    expect(tree?.truncated).toBe(true);
  });

  it('a depth cut landing on a composite still marks the nearest emitted (host) ancestor and the root', () => {
    // 63 nested hosts wrapping a composite whose own child (a host) sits one
    // level too deep. The composite is dropped (nothing measurable of its
    // own), but the innermost host — its nearest emitted ancestor — and the
    // root must both carry `truncated: true`.
    let deepest: FiberSpec = fn(function TooDeep() {
      return null;
    }, [host('NeverShown', RECT)]);
    for (let i = 0; i < 63; i += 1) {
      deepest = host(`Level${i}`, RECT, [deepest]);
    }

    const tree = buildViewTree([fiberRoot(deepest)], makeEnv());

    let node = tree?.subitems?.[0]?.subitems?.[0];
    let count = 0;
    let innermost: ManagedNode | undefined;
    while (node) {
      innermost = node;
      count += 1;
      node = node.subitems?.[0];
    }

    expect(count).toBe(63);
    expect(innermost?.class_name).not.toBe('TooDeep');
    expect(innermost?.truncated).toBe(true);
    expect(tree?.truncated).toBe(true);
  });

  it('a host at the depth limit whose only child is HostText is not marked truncated (nothing was ever going to show)', () => {
    let deepest: FiberSpec = host('TextOnly', RECT, [text()]);
    for (let i = 0; i < VH_MAX_DEPTH - 1; i += 1) {
      deepest = host(`Level${i}`, RECT, [deepest]);
    }

    const tree = buildViewTree([fiberRoot(deepest)], makeEnv());

    let node = tree?.subitems?.[0]?.subitems?.[0];
    let innermost: ManagedNode | undefined;
    while (node) {
      innermost = node;
      node = node.subitems?.[0];
    }

    expect(innermost?.class_name).toBe('TextOnly');
    expect(innermost?.truncated).toBeUndefined();
    expect(tree?.truncated).toBeUndefined();
  });

  it('a composite at the depth limit whose only child is HostText is not marked truncated', () => {
    let deepest: FiberSpec = fn(function TextOnly() {
      return null;
    }, [text()]);
    for (let i = 0; i < VH_MAX_DEPTH - 1; i += 1) {
      deepest = host(`Level${i}`, RECT, [deepest]);
    }

    // The composite has nothing measurable (its only child is HostText, and
    // HostText is never emitted) — dropped regardless, per "no measurable
    // host". The point here is that dropping it must NOT taint the root,
    // since nothing was actually cut off.
    const tree = buildViewTree([fiberRoot(deepest)], makeEnv());
    expect(tree?.truncated).toBeUndefined();
  });

  it('an empty leaf composite (no children at all) does not taint its ancestor when dropped', () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([
            fn(function EmptyLeaf() {
              return null;
            }),
            host('Shown', RECT),
          ]),
        ),
      ],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['Shown']);
    expect(tree?.truncated).toBeUndefined();
  });

  it('a node-budget cap applies to composites too, and stops at exactly VH_MAX_NODES total', () => {
    const manyComposites = Array.from({ length: VH_MAX_NODES + 5 }, (_, i) =>
      fn(function () {
        return null;
      }, [host(`Inner${i}`, RECT)]),
    );

    const tree = buildViewTree([fiberRoot(fragment(manyComposites))], makeEnv());

    expect(tree).not.toBeNull();
    expect(flatten(tree as ManagedNode)).toHaveLength(VH_MAX_NODES);
    expect(tree?.truncated).toBe(true);
  });

  it('a root that emits nothing but is truncated (a local cycle) still marks the final root truncated, via another root that succeeds', () => {
    // root1: an unmeasurable host that is its own sibling. It contributes
    // nothing (unmeasurable, no children), but the self-reference is still
    // caught as a cycle on the second (self) visit, marking root1's own
    // frame truncated — via the *local* visited-set, not the global stop
    // flag a budget/node-cap trip would set (which would also cut off
    // every other root, defeating this test's point).
    const a = buildFiberTree(host('Unmeasurable', null));
    a.sibling = a;

    const tree = buildViewTree([{ current: a }, fiberRoot(host('Shown', RECT))], makeEnv());

    expect(tree).not.toBeNull();
    expect(tree?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Shown');
    expect(tree?.truncated).toBe(true);
  });

  it('a true leaf sitting exactly at the depth limit is not marked truncated', () => {
    // Exactly VH_MAX_DEPTH levels, with a genuine leaf (no child at all) at
    // the bottom — nothing was ever cut off, so nothing should say so.
    let deepest = host('Bottom', RECT);
    for (let i = 0; i < VH_MAX_DEPTH - 1; i += 1) {
      deepest = host(`Level${i}`, RECT, [deepest]);
    }

    const tree = buildViewTree([fiberRoot(deepest)], makeEnv());

    let node = tree?.subitems?.[0]?.subitems?.[0];
    let count = 1;
    while (node?.subitems && node.subitems.length > 0) {
      node = node.subitems[0];
      count += 1;
    }

    expect(count).toBe(VH_MAX_DEPTH);
    expect(node?.class_name).toBe('Bottom');
    expect(node?.truncated).toBeUndefined();
    expect(tree?.truncated).toBeUndefined();
  });

  it('stops when the 250 ms budget runs out and marks both the nearest node and the root truncated', () => {
    // Deterministic clock: `now()` is called once per fiber visited. The 5th
    // call (index 4) is the first to report being over budget: call 0
    // establishes startedAt, call 1 is the Fragment itself, calls 2 and 3
    // are Child0 and Child1, and call 4 is Child2 — which is what stops the
    // walk.
    let calls = 0;
    const now = (): number => {
      const value = calls >= 4 ? 1000 : 0;
      calls += 1;
      return value;
    };

    const children = Array.from({ length: 10 }, (_, i) => host(`Child${i}`, RECT));
    const tree = buildViewTree([fiberRoot(fragment(children))], makeEnv({ now }));

    expect(tree?.truncated).toBe(true);
    const surface = tree?.subitems?.[0];
    expect(surface?.subitems).toHaveLength(2);
    expect(surface?.subitems?.map((n) => n.class_name)).toEqual(['Child0', 'Child1']);
    // Per the plan's payload contract, `truncated` marks wherever children
    // went unvisited regardless of *why* (depth, node cap or time budget) —
    // there is no "the root, not the node" carve-out for the time budget.
    expect(surface?.truncated).toBe(true);
  });

  it('the time budget trips strictly after VH_WALK_BUDGET_MS, not at or before it', () => {
    // A non-zero startedAt (BASE) so that `now() - startedAt` and
    // `now() + startedAt` (an arithmetic-operator mutant) diverge sharply —
    // the mutant would trip on the very first check instead of never
    // tripping early. One check reports exactly the budget's own value (250)
    // without tripping — proving the comparison is `>`, not `>=` — before
    // the next reports one past it.
    const BASE = 5_000;
    const elapsed = [0, 250, 250, 251];
    let call = 0;
    const now = (): number => {
      const value = BASE + (elapsed[call] ?? 251);
      call += 1;
      return value;
    };

    const tree = buildViewTree(
      [fiberRoot(fragment([host('AtBudget', RECT), host('PastBudget', RECT)]))],
      makeEnv({ now }),
    );

    expect(tree?.subitems?.[0]?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('AtBudget');
    expect(tree?.subitems?.[0]?.truncated).toBe(true);
    expect(tree?.truncated).toBe(true);
  });

  it('a time-budget cutoff nested behind a transparent Fragment marks its composite ancestor too', () => {
    // Per the plan's payload contract there is no special case for *why* the
    // walk stopped: a budget cutoff bubbling up through a transparent
    // Fragment must mark the enclosing composite `truncated`, the same as a
    // node-budget or depth cutoff would.
    let calls = 0;
    const now = (): number => {
      const value = calls >= 6 ? 1000 : 0;
      calls += 1;
      return value;
    };

    const manySiblings = Array.from({ length: 5 }, (_, i) => host(`Deep${i}`, RECT));
    const tree = buildViewTree(
      [
        fiberRoot(
          fn(function Outer() {
            return null;
          }, [host('First', RECT), fragment(manySiblings)]),
        ),
      ],
      makeEnv({ now }),
    );

    const outer = tree?.subitems?.[0]?.subitems?.[0];
    expect(outer?.class_name).toBe('Outer');
    expect(outer?.subitems?.map((n) => n.class_name)).toEqual(['First', 'Deep0', 'Deep1']);
    expect(outer?.truncated).toBe(true);
    expect(tree?.truncated).toBe(true);
  });

  it('a node-budget cutoff nested inside the last child still marks its ancestor truncated', () => {
    const manySiblings = Array.from({ length: VH_MAX_NODES + 5 }, (_, i) => host(`Deep${i}`, RECT));

    const tree = buildViewTree(
      [
        fiberRoot(
          fn(function Outer() {
            return null;
          }, [host('First', RECT), fragment(manySiblings)]),
        ),
      ],
      makeEnv(),
    );

    const outer = tree?.subitems?.[0]?.subitems?.[0];
    expect(outer?.class_name).toBe('Outer');
    expect(outer?.truncated).toBe(true);
    expect(tree?.truncated).toBe(true);
  });

  it('a chain of 5000 Fragments returns a tree without throwing (no stack growth, iterative walk)', () => {
    let deepest: FiberSpec = host('Bottom', RECT);
    for (let i = 0; i < 5000; i += 1) {
      deepest = fragment([deepest]);
    }

    expect(() => buildViewTree([fiberRoot(deepest)], makeEnv())).not.toThrow();
    const tree = buildViewTree([fiberRoot(deepest)], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.map((n) => n.class_name)).toEqual(['Bottom']);
  });

  it('a child cycle does not hang and does not throw, and is reported truncated', () => {
    const a = buildFiberTree(host('A', RECT));
    a.child = a; // a is its own child

    expect(() => buildViewTree([{ current: a }], makeEnv())).not.toThrow();
    const tree = buildViewTree([{ current: a }], makeEnv());
    expect(tree).not.toBeNull();
    expect(tree?.truncated).toBe(true);
  });

  it('a sibling cycle does not hang and does not throw, and is reported truncated', () => {
    const parent = buildFiberTree(fragment([]));
    const a = buildFiberTree(host('A', RECT));
    const b = buildFiberTree(host('B', RECT));
    a.return = parent;
    b.return = parent;
    a.sibling = b;
    b.sibling = a; // a <-> b cycle
    parent.child = a;

    expect(() => buildViewTree([{ current: parent }], makeEnv())).not.toThrow();
    const tree = buildViewTree([{ current: parent }], makeEnv());
    expect(tree).not.toBeNull();
    // At least the first sibling in the cycle is emitted before it is caught.
    expect(tree?.subitems?.[0]?.subitems?.map((n) => n.class_name)).toContain('A');
    expect(tree?.truncated).toBe(true);
  });

  it('a transparent wrapper around ordinary content is not itself marked truncated', () => {
    // A control for the cycle/cutoff-propagation tests above: an ordinary
    // Fragment over ordinary content must NOT taint its parent, proving the
    // propagation is conditional (`||`), not unconditional.
    const tree = buildViewTree([fiberRoot(fragment([host('View', RECT)]))], makeEnv());

    expect(tree?.truncated).toBeUndefined();
    expect(tree?.subitems?.[0]?.truncated).toBeUndefined();
  });

  it('a huge purely-transparent run before a single trailing host stops before ever reaching it, via the fiber-visit budget alone', () => {
    // 20,000 empty Fragments (never emitted, so `emittedCount` never grows —
    // the node cap cannot be what stops this) followed by one real host.
    // Correct behaviour never reaches the host at all (the fiber-visit
    // budget trips first); without that budget, the walk would eventually
    // get there (nothing else bounds a merely wide, non-cyclic, finite
    // fan-out) and emit it.
    const manyEmptyFragments = Array.from({ length: 20_000 }, () => fragment([]));
    const tree = buildViewTree(
      [fiberRoot(fragment([...manyEmptyFragments, host('NeverReached', RECT)]))],
      makeEnv(),
    );

    expect(tree).toBeNull();
  });

  it('the fiber-visit budget allows exactly its own count of visits, not one more or one fewer', () => {
    // Mirrors walk.ts's own VH_FIBER_VISIT_BUDGET (VH_MAX_NODES * 8): sized
    // so the trailing host is visited exactly on the budget-th visit — the
    // fragment itself is visit 1, each of the N empty fragments is one more
    // visit, and the host is the last. `> BUDGET` (correct) lets exactly
    // BUDGET visits through; `>= BUDGET` (an off-by-one mutant) would not.
    const fiberVisitBudget = VH_MAX_NODES * 8;
    const emptyFragmentCount = fiberVisitBudget - 2;
    const manyEmptyFragments = Array.from({ length: emptyFragmentCount }, () => fragment([]));

    const tree = buildViewTree(
      [fiberRoot(fragment([...manyEmptyFragments, host('LastOneIn', RECT)]))],
      makeEnv(),
    );

    expect(tree?.subitems?.[0]?.subitems?.map((n) => n.class_name)).toEqual(['LastOneIn']);
  });

  it('a depth-cut check on a cyclic sibling chain conservatively assumes there might be content', () => {
    let deepest: FiberSpec = host('AtLimit', RECT);
    for (let i = 0; i < VH_MAX_DEPTH - 1; i += 1) {
      deepest = host(`Level${i}`, RECT, [deepest]);
    }
    const root = buildFiberTree(deepest);

    let innermost = root;
    while (innermost.child !== null) {
      innermost = innermost.child;
    }
    const textFiber = buildFiberTree(text());
    textFiber.sibling = textFiber; // a HostText that is its own sibling
    textFiber.return = innermost;
    innermost.child = textFiber;

    const tree = buildViewTree([{ current: root }], makeEnv());

    let node = tree?.subitems?.[0]?.subitems?.[0];
    let last: ManagedNode | undefined;
    while (node) {
      last = node;
      node = node.subitems?.[0];
    }

    expect(last?.class_name).toBe('AtLimit');
    expect(last?.truncated).toBe(true);
  });

  it('a depth-cut check gives up after SIBLING_PEEK_CAP siblings and conservatively assumes there might be content', () => {
    // All 10,005 children really are HostText (nothing would ever have been
    // shown), but giving up the scan after the cap must still report
    // "might have content" rather than silently swallowing a truncation
    // that could have been genuine.
    const manyTextSiblings = Array.from({ length: 10_005 }, () => text());
    let deepest: FiberSpec = host('AtLimit', RECT, manyTextSiblings);
    for (let i = 0; i < VH_MAX_DEPTH - 1; i += 1) {
      deepest = host(`Level${i}`, RECT, [deepest]);
    }

    const tree = buildViewTree([fiberRoot(deepest)], makeEnv());

    let node = tree?.subitems?.[0]?.subitems?.[0];
    let last: ManagedNode | undefined;
    while (node) {
      last = node;
      node = node.subitems?.[0];
    }

    expect(last?.class_name).toBe('AtLimit');
    expect(last?.truncated).toBe(true);
  });

  it('the depth-cut sibling scan allows exactly SIBLING_PEEK_CAP siblings before giving up, not one more or one fewer', () => {
    // Mirrors walk.ts's own SIBLING_PEEK_CAP (10,000). Exactly that many
    // HostText siblings are fully scanned (the chain ends exactly as the
    // budget would have run out) and correctly found to hold nothing real;
    // one more forces giving up before the scan finishes, which
    // conservatively reports "might have content" instead.
    const siblingPeekCap = 10_000;

    const exactlyAtCap = Array.from({ length: siblingPeekCap }, () => text());
    let atCapChain: FiberSpec = host('AtLimit', RECT, exactlyAtCap);
    for (let i = 0; i < VH_MAX_DEPTH - 1; i += 1) {
      atCapChain = host(`Level${i}`, RECT, [atCapChain]);
    }
    const atCapTree = buildViewTree([fiberRoot(atCapChain)], makeEnv());
    let atCapNode = atCapTree?.subitems?.[0]?.subitems?.[0];
    let atCapLast: ManagedNode | undefined;
    while (atCapNode) {
      atCapLast = atCapNode;
      atCapNode = atCapNode.subitems?.[0];
    }
    expect(atCapLast?.class_name).toBe('AtLimit');
    expect(atCapLast?.truncated).toBeUndefined();

    const oneOverCap = Array.from({ length: siblingPeekCap + 1 }, () => text());
    let overCapChain: FiberSpec = host('AtLimit', RECT, oneOverCap);
    for (let i = 0; i < VH_MAX_DEPTH - 1; i += 1) {
      overCapChain = host(`Level${i}`, RECT, [overCapChain]);
    }
    const overCapTree = buildViewTree([fiberRoot(overCapChain)], makeEnv());
    let overCapNode = overCapTree?.subitems?.[0]?.subitems?.[0];
    let overCapLast: ManagedNode | undefined;
    while (overCapNode) {
      overCapLast = overCapNode;
      overCapNode = overCapNode.subitems?.[0];
    }
    expect(overCapLast?.class_name).toBe('AtLimit');
    expect(overCapLast?.truncated).toBe(true);
  });

  it('a clock that is corrupted only on its first call still lets the time budget trip on a later, valid reading', () => {
    // safeNow() falling back to 0 for a bad first reading must not corrupt
    // ctx.startedAt into something a later *valid* reading can no longer be
    // compared against (e.g. a mutant that let a non-number through would
    // make every later `now() - startedAt` a NaN, which is never `> budget`).
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls === 1 ? ('garbage' as unknown as number) : 100_000;
    };

    const tree = buildViewTree(
      [fiberRoot(fragment([host('A', RECT), host('B', RECT)]))],
      makeEnv({ now }),
    );

    // The budget trips on the very next check (a huge, valid elapsed time),
    // before either host is ever visited — nothing is emitted at all. A
    // corrupted `startedAt` that later comparisons can't subtract from
    // (NaN, never `> budget`) would instead let both hosts through.
    expect(tree).toBeNull();
  });

  it('undefined child/sibling links are tolerated the same as null', () => {
    const a = buildFiberTree(host('A', RECT));
    (a as unknown as { child: undefined }).child = undefined;
    (a as unknown as { sibling: undefined }).sibling = undefined;

    expect(() => buildViewTree([{ current: a }], makeEnv())).not.toThrow();
    const tree = buildViewTree([{ current: a }], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.map((n) => n.class_name)).toEqual(['A']);
  });

  it('a frozen clock with a very wide fan-out still stops, via the fiber-visit budget rather than the clock', () => {
    const manySiblings = Array.from({ length: 20_000 }, (_, i) => host(`S${i}`, RECT));
    const tree = buildViewTree([fiberRoot(fragment(manySiblings))], makeEnv({ now: () => 0 }));

    expect(tree).not.toBeNull();
    expect(tree?.truncated).toBe(true);
    expect(tree?.subitems?.[0]?.subitems?.length ?? 0).toBeLessThan(20_000);
  });

  it('ids are preorder and unique', () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fn(function A() {
            return null;
          }, [
            host('B', RECT, [host('C', RECT)]),
            host('D', RECT),
          ]),
        ),
      ],
      makeEnv(),
    );

    expect(tree).not.toBeNull();
    const all = flatten(tree as ManagedNode);
    const ids = all.map((n) => Number(n.id));

    expect(new Set(ids).size).toBe(ids.length);

    function assertChildrenAfter(node: ManagedNode): void {
      for (const child of node.subitems ?? []) {
        expect(Number(child.id)).toBeGreaterThan(Number(node.id));
        assertChildrenAfter(child);
      }
    }
    assertChildrenAfter(tree as ManagedNode);
  });

  it('keys serialise in the documented order', () => {
    const tree = buildViewTree([fiberRoot(host('View', RECT))], makeEnv());

    const expected = {
      id: '0',
      class_name: 'ReactNative',
      bounds: [0, 0, 10, 10],
      options: { kind: 'root' },
      subitems: [
        {
          id: '1',
          class_name: 'ReactSurface',
          bounds: [0, 0, 10, 10],
          options: { kind: 'surface' },
          subitems: [
            {
              id: '2',
              class_name: 'View',
              bounds: [0, 0, 10, 10],
              options: { kind: 'host' },
            },
          ],
        },
      ],
    };

    expect(JSON.stringify(tree)).toBe(JSON.stringify(expected));
  });

  it('returns null when nothing is emitted', () => {
    expect(buildViewTree([], makeEnv())).toBeNull();
    expect(buildViewTree([fiberRoot(fragment([]))], makeEnv())).toBeNull();
  });

  it('a malformed root ({ current: null }) is silently skipped, not treated as truncated', () => {
    const tree = buildViewTree(
      [{ current: null as unknown as never }, fiberRoot(host('Shown', RECT))],
      makeEnv(),
    );

    expect(tree?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Shown');
    expect(tree?.truncated).toBeUndefined();
  });

  it('a root that legitimately has nothing to show is not treated as truncated', () => {
    const tree = buildViewTree(
      [fiberRoot(fragment([])), fiberRoot(host('Shown', RECT))],
      makeEnv(),
    );

    expect(tree?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Shown');
    expect(tree?.truncated).toBeUndefined();
  });

  it('a non-object root is silently skipped, not treated as truncated', () => {
    const tree = buildViewTree(
      [42 as unknown as { current: never }, fiberRoot(host('Shown', RECT))],
      makeEnv(),
    );

    expect(tree?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Shown');
    expect(tree?.truncated).toBeUndefined();
  });

  it('a null root entry does not throw (isObject(null) is false, not true), and is silently skipped, not treated as truncated', () => {
    // `null` specifically, not `{ current: null }`: `typeof null === 'object'`
    // is a JS quirk `isObject` must not be fooled by, or this root would be
    // treated as an object and `(null).current` would throw — caught by
    // `buildViewTree`'s own `try` (so `.not.toThrow()` alone would not catch
    // a broken `isObject`), but wrongly marking the whole tree `truncated`
    // for a root that was never legitimately there in the first place. The
    // `truncated` assertion below is what actually discriminates that from
    // "correctly skipped before ever entering the `try`".
    expect(() =>
      buildViewTree([null as unknown as { current: never }, fiberRoot(host('Shown', RECT))], makeEnv()),
    ).not.toThrow();

    const tree = buildViewTree(
      [null as unknown as { current: never }, fiberRoot(host('Shown', RECT))],
      makeEnv(),
    );
    expect(tree?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Shown');
    expect(tree?.truncated).toBeUndefined();
  });

  // N5/I6(a) (fix round 2): `root.current` is read inside `buildViewTree`'s
  // own `try`, not before it — a throwing getter, or `root` itself being a
  // revoked Proxy, used to escape uncaught.
  it('a throwing root.current getter does not throw out of buildViewTree, and marks the root truncated via a second, healthy root', () => {
    const throwingRoot: { current: never } = {
      get current(): never {
        throw new Error('boom');
      },
    };

    expect(() => buildViewTree([throwingRoot, fiberRoot(host('Shown', RECT))], makeEnv())).not.toThrow();

    const tree = buildViewTree([throwingRoot, fiberRoot(host('Shown', RECT))], makeEnv());
    expect(tree?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Shown');
    expect(tree?.truncated).toBe(true);
  });

  it('a revoked Proxy as a root entry does not throw out of buildViewTree', () => {
    const { proxy, revoke } = Proxy.revocable<{ current: never }>({ current: undefined as never }, {});
    revoke();

    expect(() => buildViewTree([proxy, fiberRoot(host('Shown', RECT))], makeEnv())).not.toThrow();

    const tree = buildViewTree([proxy, fiberRoot(host('Shown', RECT))], makeEnv());
    expect(tree?.subitems).toHaveLength(1);
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Shown');
    expect(tree?.truncated).toBe(true);
  });

  // N5/I6(b): the per-fiber `try` inside `runWalk` is narrow — a throw deep
  // in one fiber's own read (here, `displayName`) drops only that fiber's
  // contribution (or, for a class-name computation specifically, falls back
  // to 'Anonymous' rather than dropping even that much — see
  // `safeCompositeClassName`), never the rest of the tree around it.
  it('a throwing displayName getter, several levels deep in a tree, falls back to Anonymous — the rest of the tree (siblings, ancestor, other roots) is still emitted', () => {
    const throwingType: { displayName: unknown } = {
      get displayName(): unknown {
        throw new Error('boom');
      },
    };
    const broken: FiberSpec = { tag: FiberTag.FunctionComponent, type: throwingType, children: [host('DeepHost', RECT)] };

    const tree = buildViewTree(
      [
        fiberRoot(
          host('Outer', RECT, [
            fn(function BeforeSibling() {
              return null;
            }, [host('BeforeHost', RECT)]),
            broken,
            fn(function AfterSibling() {
              return null;
            }, [host('AfterHost', RECT)]),
          ]),
        ),
        fiberRoot(host('OtherRoot', RECT)),
      ],
      makeEnv(),
    );

    const outerHost = tree?.subitems?.[0]?.subitems?.[0];
    const compositeNames = outerHost?.subitems?.map((n) => n.class_name);
    // The broken composite is still there — named 'Anonymous', not dropped —
    // flanked by both of its untouched siblings.
    expect(compositeNames).toEqual(['BeforeSibling', 'Anonymous', 'AfterSibling']);
    // Its own child host, unaffected by the throw in its ancestor's naming,
    // still made it into the tree.
    const brokenComposite = outerHost?.subitems?.[1];
    expect(brokenComposite?.subitems?.[0]?.class_name).toBe('DeepHost');
    // The second, unrelated root is also untouched.
    expect(tree?.subitems?.[1]?.subitems?.[0]?.class_name).toBe('OtherRoot');
  });

  it("a throwing .child getter (not just a naming getter) drops only that one fiber's own node, and marks its host ancestor truncated — siblings and other roots are untouched", () => {
    const root = buildFiberTree(
      host('Outer', RECT, [
        fn(function Before() {
          return null;
        }, [host('BeforeHost', RECT)]),
        fn(function Broken() {
          return null;
        }, [host('DeepHost', RECT)]),
        fn(function After() {
          return null;
        }, [host('AfterHost', RECT)]),
      ]),
    );

    // Redefined after building, not built throwing from the start: the
    // sibling chain (`Before` -> `Broken` -> `After`) is read and pushed
    // onto the walk's stack *before* `Broken`'s own `.child` is ever
    // touched, so making only `.child` throw (not `.sibling` or `.tag`)
    // isolates exactly the read this test means to probe.
    const before = root.child as FiberLike;
    const broken = before.sibling as FiberLike;
    Object.defineProperty(broken, 'child', {
      get(): never {
        throw new Error('boom');
      },
    });

    const tree = buildViewTree([{ current: root }, fiberRoot(host('OtherRoot', RECT))], makeEnv());
    const outerHost = tree?.subitems?.[0]?.subitems?.[0];
    const names = outerHost?.subitems?.map((n) => n.class_name);

    // `Broken` contributes no node at all (unlike a naming-only failure,
    // reading `.child` throws before any node for it could be built) — but
    // `Before` and `After`, its siblings, are unaffected.
    expect(names).toEqual(['Before', 'After']);
    // The cut bubbles to `Outer`, the nearest ancestor that IS emitted (I1),
    // and from there to the root — but the second, unrelated root still
    // comes through untouched.
    expect(outerHost?.truncated).toBe(true);
    expect(tree?.subitems?.[1]?.subitems?.[0]?.class_name).toBe('OtherRoot');
    expect(tree?.subitems?.[1]?.truncated).toBeUndefined();
    expect(tree?.truncated).toBe(true);
  });

  it("a class component's class_name is its name", () => {
    class MyClass {}
    const tree = buildViewTree([fiberRoot(classComponent(MyClass, [host('View', RECT)]))], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('MyClass');
  });

  it('a composite with no type at all is Anonymous, not a crash', () => {
    const tree = buildViewTree([fiberRoot(fn(null, [host('View', RECT)]))], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Anonymous');
  });

  it('a non-null, non-function object type is named from its own displayName', () => {
    // An exotic (non-function) `type` — unusual in real React, but this
    // proves the object branch is actually entered and read, rather than
    // every object type happening to fall through to Anonymous the same way
    // `null` and `{}` do.
    const tree = buildViewTree([fiberRoot(fn({ displayName: 'Boxed' }, [host('View', RECT)]))], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Boxed');
  });

  it('an empty displayName falls through to name, and an empty name falls through to Anonymous', () => {
    const emptyDisplayName = function Real() {
      return null;
    };
    emptyDisplayName.displayName = '';

    const emptyName = function empty() {
      return null;
    };
    Object.defineProperty(emptyName, 'name', { value: '' });

    const tree = buildViewTree(
      [fiberRoot(fragment([fn(emptyDisplayName, [host('A', RECT)]), fn(emptyName, [host('B', RECT)])]))],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['Real', 'Anonymous']);
  });

  it('a non-string displayName is ignored in favour of name', () => {
    const weird = function Real() {
      return null;
    };
    (weird as unknown as { displayName: number }).displayName = 42;

    const tree = buildViewTree([fiberRoot(fn(weird, [host('View', RECT)]))], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('Real');
  });

  it('ForwardRef and Memo with no inner type at all are Anonymous, not a crash', () => {
    const tree = buildViewTree(
      [fiberRoot(fragment([forwardRefFiber(null, [host('A', RECT)]), memoFiber(null, [host('B', RECT)])]))],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['Anonymous', 'Anonymous']);
  });

  it('ForwardRef and Memo fibers whose own `type` is null are Anonymous, not a crash', () => {
    // Unlike forwardRefFiber(null, ...)/memoFiber(null, ...), which still
    // wrap it in `{ render: null }`/`{ type: null }`, this is the fiber's
    // `type` itself being null — the case the optional chaining on
    // `fiber.type` (not on its `.render`/`.type` property) guards against.
    const forwardRefWithNullType: FiberSpec = { tag: FiberTag.ForwardRef, type: null, children: [host('A', RECT)] };
    const memoWithNullType: FiberSpec = { tag: FiberTag.Memo, type: null, children: [host('B', RECT)] };

    const tree = buildViewTree(
      [fiberRoot(fragment([forwardRefWithNullType, memoWithNullType]))],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['Anonymous', 'Anonymous']);
  });

  it('a null memoizedProps never crashes and withholds tag/native_id', () => {
    const root = fiberRoot(host('View', RECT));
    root.current.memoizedProps = null;

    const tree = buildViewTree([root], makeEnv());
    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.options.tag).toBeUndefined();
    expect(node?.options.native_id).toBeUndefined();
  });

  it('testID and nativeID are withheld independently of one another', () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([host('OnlyTag', RECT, [], { testID: 'tag-only' }), host('OnlyNativeId', RECT, [], { nativeID: 'native-only' })]),
        ),
      ],
      makeEnv(),
    );

    const [onlyTag, onlyNativeId] = tree?.subitems?.[0]?.subitems ?? [];
    expect(onlyTag?.options.tag).toBe('tag-only');
    expect(onlyTag?.options.native_id).toBeUndefined();
    // Not just `undefined` as a value — the key itself must be absent, since
    // the code sets it conditionally rather than assigning `undefined` to it.
    expect(Object.keys(onlyTag?.options ?? {})).not.toContain('native_id');
    expect(onlyNativeId?.options.tag).toBeUndefined();
    expect(Object.keys(onlyNativeId?.options ?? {})).not.toContain('tag');
    expect(onlyNativeId?.options.native_id).toBe('native-only');
  });

  it('depth truncation on an all-composite chain drops content well past VH_MAX_DEPTH', () => {
    // A host only past the depth limit: correct behaviour never reaches it
    // (nothing measurable, tree is null); a broken depth check would reach it.
    let deepest: FiberSpec = host('Bottom', RECT);
    for (let i = 0; i < VH_MAX_DEPTH + 10; i += 1) {
      deepest = fn(function Wrapper() {
        return null;
      }, [deepest]);
    }

    expect(buildViewTree([fiberRoot(deepest)], makeEnv())).toBeNull();
  });

  it('an all-composite chain of exactly VH_MAX_DEPTH does not recurse one level further', () => {
    // The host sits exactly one level past the boundary: `depthRemaining > 1`
    // (correct) never reaches it (tree is null); `depthRemaining >= 1` (an
    // off-by-one mutant) would reach it one level "too deep" and the whole
    // chain would survive instead.
    let deepest: FiberSpec = host('OneLevelTooDeep', RECT);
    for (let i = 0; i < VH_MAX_DEPTH; i += 1) {
      deepest = fn(function Wrapper() {
        return null;
      }, [deepest]);
    }

    expect(buildViewTree([fiberRoot(deepest)], makeEnv())).toBeNull();
  });
});
