/**
 * `buildViewTree` turns a fiber tree into the privacy-safe managed view tree
 * the native side eventually serialises. Every test here uses fake fibers
 * (`fakeFibers.ts`), never React or `react-test-renderer`: `walk.ts` is pure,
 * and its contract is entirely about what it does with the `FiberLike` shape
 * and the `WalkEnv` it is given.
 */
import { FiberTag } from '../fiber';
import type { WindowRect } from '../fiber';
import type { ManagedNode, WalkEnv } from '../walk';
import { VH_MAX_DEPTH, VH_MAX_NODES, VH_TAG_MAX_LENGTH, buildViewTree } from '../walk';
import {
  classComponent,
  consumer,
  fiberRoot,
  fn,
  forwardRefFiber,
  fragment,
  host,
  memoFiber,
  mode,
  offscreen,
  portal,
  provider,
  text,
  trackedProps,
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

  it('no prop other than testID and nativeID is ever read', () => {
    const reads = new Set<string>();
    const props = () =>
      trackedProps(
        { testID: 'tid', nativeID: 'nid', onPress: () => undefined, style: { flex: 1 }, children: 'nope' },
        reads,
      );

    const tree = buildViewTree(
      [
        fiberRoot(
          fn(
            function Composite() {
              return null;
            },
            [host('View', RECT, [], props())],
            props(),
          ),
        ),
      ],
      makeEnv(),
    );

    expect(tree).not.toBeNull();
    expect(reads.size).toBeGreaterThan(0);
    for (const key of reads) {
      expect(['testID', 'nativeID']).toContain(key);
    }
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

  it('a subtree with no measurable host is dropped', () => {
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

  it('a hidden Offscreen subtree is dropped', () => {
    const tree = buildViewTree(
      [
        fiberRoot(
          fragment([offscreen(false, [host('Hidden', RECT)]), host('Visible', RECT)]),
        ),
      ],
      makeEnv(),
    );

    const names = tree?.subitems?.[0]?.subitems?.map((n) => n.class_name);
    expect(names).toEqual(['Visible']);
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

  it('Android bounds are rounded pixels plus the origin', () => {
    const tree = buildViewTree(
      [fiberRoot(host('View', { x: 10.2, y: 20.4, width: 100.1, height: 50.3 }))],
      makeEnv({ platform: 'android', scale: 2.625, originX: 0, originY: 63 }),
    );

    const node = tree?.subitems?.[0]?.subitems?.[0];
    expect(node?.bounds).toEqual([27, 117, 263, 132]);
  });

  it('Android bounds add the X origin, not just the Y one', () => {
    // The brief's own worked example fixes originX at 0, where adding and
    // subtracting the origin happen to look the same. A non-zero originX
    // tells them apart.
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

  it('stops at 2000 nodes and marks truncated on the node and the root', () => {
    const children = Array.from({ length: VH_MAX_NODES + 5 }, (_, i) => host(`Child${i}`, RECT));
    const tree = buildViewTree([fiberRoot(fragment(children))], makeEnv());

    const surface = tree?.subitems?.[0];
    expect(surface?.subitems).toHaveLength(VH_MAX_NODES);
    expect(surface?.truncated).toBe(true);
    expect(tree?.truncated).toBe(true);
  });

  it('stops at depth 64 and marks that node truncated', () => {
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
  });

  it("stops when the 250 ms budget runs out and marks the root truncated", () => {
    // Deterministic clock: `now()` is called once per fiber visited
    // (walkFiber's own entry check). The 5th call (index 4) is the first to
    // report being over budget: call 0 establishes startedAt, call 1 is the
    // Fragment itself, calls 2 and 3 are Child0 and Child1, and call 4 is
    // Child2 — which is what stops the walk.
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
    expect(surface?.truncated).toBeUndefined();
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
    expect(tree?.truncated).toBe(true);
  });

  it('a time-budget cutoff nested behind a transparent Fragment does not mark its composite ancestor', () => {
    // Unlike the node-budget case, a budget cutoff bubbling up through a
    // transparent Fragment must NOT mark the enclosing composite truncated
    // (only the root is, per the "the root, not the node" rule for time)
    // — exercising the ancestor's own fallback `ctx.stopped` check with a
    // reason other than 'nodes', since `result.cutByNodeBudget` alone
    // (always false for a budget stop) cannot signal it.
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
    expect(outer?.truncated).toBeUndefined();
    expect(tree?.truncated).toBe(true);
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

  it('SimpleMemo also unwraps to the inner name', () => {
    function InnerSimpleMemo(): null {
      return null;
    }
    const spec: FiberSpec = {
      tag: FiberTag.SimpleMemo,
      type: { type: InnerSimpleMemo },
      children: [host('View', RECT)],
    };

    const tree = buildViewTree([fiberRoot(spec)], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.[0]?.class_name).toBe('InnerSimpleMemo');
  });

  it('an Offscreen subtree with _visibility set is shown when the visible bit is on', () => {
    const tree = buildViewTree([fiberRoot(offscreen(true, [host('Shown', RECT)]))], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.map((n) => n.class_name)).toEqual(['Shown']);
  });

  it('an Offscreen fiber with no usable _visibility is treated as visible', () => {
    const spec: FiberSpec = { tag: FiberTag.Offscreen, stateNode: null, children: [host('Shown', RECT)] };
    const tree = buildViewTree([fiberRoot(spec)], makeEnv());
    expect(tree?.subitems?.[0]?.subitems?.map((n) => n.class_name)).toEqual(['Shown']);
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

  it('a node-budget cutoff nested inside the last child still marks its ancestor truncated', () => {
    // The many siblings sit behind a Fragment (transparent), not another
    // composite: a composite would absorb the cutoff into its own
    // `truncated` flag, which would hide whether the ancestor's own
    // cutoff-propagation path was exercised at all.
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
});
