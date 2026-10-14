/**
 * `transition.ts` tells a native transition (a stack push or pop, a Modal
 * opening or closing) from a view coming and going in place, by the fiber
 * tree alone, and says where the transition can draw the view.
 */
import { MODAL_SCREEN_HOST_TYPE, SCREEN_HOST_TYPE, ancestryOfFiber, noAncestry } from '../ancestry';
import {
  SECURE_TRANSITION_HOLD_MS,
  WHOLE_SURFACE,
  carriedCover,
  carrierEntering,
  carrierLeaving,
  bounding,
  carriedCovers,
  carriersOf,
  deletionRoot,
  joinStack,
  keyOf,
  noteBirth,
  observeStack,
  screenCover,
  screensOn,
  stackMotionOf,
  stackMoving,
} from '../transition';
import type { StackMotion } from '../transition';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import { composite, fabricHost, fakeRenderer, rect, root, self, selfIn, view } from './fakeAncestors';
import { buildFiberTree } from '../../viewtree/__tests__/fakeFibers';
import type { FiberSpec } from '../../viewtree/__tests__/fakeFibers';
import type { FakeRenderer } from './fakeAncestors';

let renderer: FakeRenderer;
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  getPublicInstanceFromInternalInstanceHandle: (fiber: FiberLike) =>
    renderer.getPublicInstanceFromInternalInstanceHandle(fiber),
}));

beforeEach(() => {
  renderer = fakeRenderer();
});

const SCREEN = rect(0, 0, 400, 800);
const SELF = rect(10, 100, 200, 50);

const onScreen = (container: string, screen = SCREEN_HOST_TYPE): FiberLike =>
  selfIn(root([fabricHost(container, null, {}, [fabricHost(screen, SCREEN, {}, [view([self()])])])]));

const inModal = (props: unknown): FiberLike =>
  selfIn(
    root([
      fabricHost('RCTModalHostView', null, props as Record<string, unknown>, [
        fabricHost('RCTView', rect(0, 0, 400, 800), {}, [fabricHost('RNSScreenContainer', null, {}, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, {}, [self()]),
        ])]),
      ]),
    ]),
  );

const indexOf = (fiber: FiberLike, type: string): number =>
  ancestryOfFiber(fiber).path.findIndex((ancestor) => ancestor.type === type);

describe('carriersOf', () => {
  it('a screen in a stack carries the view', () => {
    const fiber = onScreen('RNSScreenStack');

    expect(carriersOf(ancestryOfFiber(fiber))).toEqual([
      { kind: 'screen', index: indexOf(fiber, SCREEN_HOST_TYPE), stack: indexOf(fiber, 'RNSScreenStack') },
    ]);
  });

  it('so does a modal screen in a stack', () => {
    const fiber = onScreen('RNSScreenStack', MODAL_SCREEN_HOST_TYPE);

    expect(carriersOf(ancestryOfFiber(fiber)).map((carrier) => carrier.kind)).toEqual(['screen']);
  });

  it('every stack screen, nearest first: in nested stacks the one pushed or popped moves', () => {
    const inner = fabricHost('RNSScreenStack', null, {}, [fabricHost(SCREEN_HOST_TYPE, SCREEN, {}, [self()])]);
    const fiber = selfIn(
      root([fabricHost('RNSScreenStack', null, {}, [fabricHost(SCREEN_HOST_TYPE, SCREEN, {}, [inner])])]),
    );

    expect(carriersOf(ancestryOfFiber(fiber))).toEqual([
      { kind: 'screen', index: 0, stack: 1 },
      { kind: 'screen', index: 2, stack: 3 },
    ]);
  });

  it('a screen in a tab container does not; nothing else does either', () => {
    expect(carriersOf(ancestryOfFiber(onScreen('RNSScreenContainer')))).toEqual([]);
  });

  it('a Modal carries a view on a screen that does not', () => {
    const fiber = inModal({});

    expect(carriersOf(ancestryOfFiber(fiber))).toEqual([{ kind: 'modal', index: indexOf(fiber, 'RCTModalHostView') }]);
  });

  it('a stack screen inside a Modal and the Modal both carry it', () => {
    const fiber = selfIn(
      root([
        fabricHost('RCTModalHostView', null, {}, [
          fabricHost('RNSScreenStack', null, {}, [fabricHost(SCREEN_HOST_TYPE, SCREEN, {}, [self()])]),
        ]),
      ]),
    );

    expect(carriersOf(ancestryOfFiber(fiber))).toEqual([
      { kind: 'screen', index: 0, stack: 1 },
      { kind: 'modal', index: 2 },
    ]);
  });

  it('a screen with no host above it carries nothing, without throwing', () => {
    const fiber = selfIn(root([fabricHost(SCREEN_HOST_TYPE, SCREEN, {}, [self()])]));

    expect(carriersOf(ancestryOfFiber(fiber))).toEqual([]);
  });

  it('a Modal right above the view carries it', () => {
    const fiber = selfIn(root([fabricHost('RCTModalHostView', null, {}, [self()])]));

    expect(carriersOf(ancestryOfFiber(fiber))).toEqual([{ kind: 'modal', index: 0 }]);
  });

  it('nothing above the view: nothing carries it', () => {
    expect(carriersOf(noAncestry())).toEqual([]);
  });
});

describe('carriedCovers and bounding', () => {
  it('joins what each carrier covers, and is null when none covers anything', () => {
    const fiber = selfIn(
      root([
        fabricHost('RCTModalHostView', null, { animationType: 'slide' }, [
          fabricHost('RNSScreenStack', null, {}, [fabricHost(SCREEN_HOST_TYPE, rect(0, 50, 400, 300), {}, [self()])]),
        ]),
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    const carriers = carriersOf(ancestry);

    const joined = { x: 0, y: 50, width: 400, height: WHOLE_SURFACE.height - 50 };
    expect(carriedCovers(ancestry, carriers, SELF)).toEqual(joined);
    expect(carriedCovers(ancestry, [carriers[1] as never], null)).toBeNull();
    expect(carriedCovers(ancestry, [], SELF)).toBeNull();
  });

  it('the bounding box of two rectangles, either way round', () => {
    const a = rect(10, 20, 30, 40);
    const b = rect(0, 30, 100, 5);

    expect(bounding(a, b)).toEqual(rect(0, 20, 100, 40));
    expect(bounding(b, a)).toEqual(rect(0, 20, 100, 40));
    expect(bounding(a, null)).toBe(a);
    expect(bounding(a, undefined)).toBe(a);
  });
});

describe('carrierEntering', () => {
  it('a carrier mounted whole, as an app starts, is not carried in, then or later', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    const carrier = { kind: 'screen' as const, index: 0 };

    // Nothing above it was there.
    expect(carrierEntering(ancestry, carrier, 1000)).toBeUndefined();
    for (const fiber of ancestry.path) {
      fiber.alternate = { ...fiber, alternate: fiber };
    }
    expect(carrierEntering(ancestry, carrier, 1001)).toBeUndefined();
  });

  it('a carrier created by the commit running now is carried in until the hold ends, and stays so', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    const carrier = { kind: 'screen' as const, index: 0 };
    const above = ancestry.path[1] as FiberLike;
    above.alternate = { ...above, alternate: above };

    expect(carrierEntering(ancestry, carrier, 1000)).toBe(1000 + SECURE_TRANSITION_HOLD_MS);
    // Rendered again since, a later view still finds it carried in, from when it was created.
    const screen = ancestry.path[0] as FiberLike;
    screen.alternate = { ...screen, alternate: screen };
    expect(carrierEntering(ancestry, carrier, 1300)).toBe(1000 + SECURE_TRANSITION_HOLD_MS);
    expect(carrierEntering(ancestry, carrier, 1000 + SECURE_TRANSITION_HOLD_MS - 1)).toBe(
      1000 + SECURE_TRANSITION_HOLD_MS,
    );
    expect(carrierEntering(ancestry, carrier, 1000 + SECURE_TRANSITION_HOLD_MS)).toBeUndefined();
  });

  it('N3: a carrier there before, first seen now, is taken as coming now: once', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    for (const fiber of ancestry.path) {
      fiber.alternate = { ...fiber, alternate: fiber };
    }
    const carrier = { kind: 'screen' as const, index: 0 };

    // A screen pushed with a spinner, its secure content mounting a commit later.
    expect(carrierEntering(ancestry, carrier, 5)).toBe(5 + SECURE_TRANSITION_HOLD_MS);
    expect(carrierEntering(ancestry, carrier, 300)).toBe(5 + SECURE_TRANSITION_HOLD_MS);
    expect(carrierEntering(ancestry, carrier, 5000)).toBeUndefined();
  });

  it('N3: a carrier rendered before, with nothing above rendered before, is first seen now too', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    const screen = ancestry.path[0] as FiberLike;
    screen.alternate = { ...screen, alternate: screen };

    expect(carrierEntering(ancestry, { kind: 'screen', index: 0 }, 7)).toBe(7 + SECURE_TRANSITION_HOLD_MS);
  });

  it('N3: a screen seen pushed is carried in from then; a birth known already stands', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    for (const fiber of ancestry.path) {
      fiber.alternate = { ...fiber, alternate: fiber };
    }
    const carrier = { kind: 'screen' as const, index: 0 };
    const key = keyOf(ancestry.path[0] as FiberLike);

    noteBirth(key, 100);
    noteBirth(key, 200);
    expect(carrierEntering(ancestry, carrier, 300)).toBe(100 + SECURE_TRANSITION_HOLD_MS);
  });
});

describe('deletionRoot and carrierLeaving', () => {
  const deleting = (parent: FiberLike, child: unknown): void => {
    (parent as FiberLike & { deletions?: unknown }).deletions = child;
  };

  it('finds nothing when nothing on the way up is deleted', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    deleting(ancestry.path[1] as FiberLike, 'not a list');

    expect(deletionRoot(ancestry)).toBeUndefined();
    expect(carrierLeaving(ancestry, { kind: 'screen', index: 0 })).toBe(false);
  });

  it('the view itself deleted is -1, below any carrier', () => {
    const fiber = onScreen('RNSScreenStack');
    const ancestry = ancestryOfFiber(fiber);
    deleting(ancestry.path[0] as FiberLike, [fiber]);

    expect(deletionRoot(ancestry)).toBe(-1);
    expect(carrierLeaving(ancestry, { kind: 'screen', index: 1 })).toBe(false);
  });

  it('finds the other fiber of a deleted pair, listed on the other fiber of its parent', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    const screen = ancestry.path[1] as FiberLike;
    const stack = ancestry.path[2] as FiberLike;
    screen.alternate = { ...screen, alternate: screen };
    stack.alternate = { ...stack, alternate: stack };
    deleting(stack.alternate, [screen.alternate]);

    expect(deletionRoot(ancestry)).toBe(1);
    expect(carrierLeaving(ancestry, { kind: 'screen', index: 1 })).toBe(true);
    expect(carrierLeaving(ancestry, { kind: 'screen', index: 2 })).toBe(false);
  });

  it('a deletions list left from an earlier commit, naming other fibers, deletes nothing here', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    deleting(ancestry.path[2] as FiberLike, [{ ...(ancestry.path[1] as FiberLike) }]);

    expect(deletionRoot(ancestry)).toBeUndefined();
  });

  it('a view with no fiber has nothing deleted', () => {
    expect(deletionRoot(noAncestry())).toBeUndefined();
  });
});

describe('carriedCover', () => {
  it('a screen covers its own rectangle', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));

    expect(carriedCover(ancestry, { kind: 'screen', index: 1 }, SELF)).toEqual(SCREEN);
  });

  it('a screen that cannot be measured, or throws, covers the whole surface', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    ((ancestry.path[1] as FiberLike).stateNode as { rect: unknown }).rect = null;
    expect(carriedCover(ancestry, { kind: 'screen', index: 1 }, SELF)).toEqual(WHOLE_SURFACE);

    renderer.getPublicInstanceFromInternalInstanceHandle = () => {
      throw new Error('gone');
    };
    const fresh = ancestryOfFiber(onScreen('RNSScreenStack'));
    expect(carriedCover(fresh, { kind: 'screen', index: 1 }, SELF)).toEqual(WHOLE_SURFACE);
  });

  it('a Modal view never measured covers nothing more', () => {
    const fiber = inModal({ animationType: 'slide' });
    const carrier = { kind: 'modal' as const, index: indexOf(fiber, 'RCTModalHostView') };

    expect(carriedCover(ancestryOfFiber(fiber), carrier, null)).toBeNull();
  });

  it.each([
    ['slides', { animationType: 'slide' }, { ...SELF, height: WHOLE_SURFACE.height - SELF.y }],
    ['fades', { animationType: 'fade' }, null],
    ['has no animation', { animationType: 'none' }, null],
    ['has no props', null, null],
  ])('a Modal that %s', (_, props, expected) => {
    const fiber = inModal(props);
    const ancestry = ancestryOfFiber(fiber);
    (ancestry.path[indexOf(fiber, 'RCTModalHostView')] as FiberLike).memoizedProps = props;

    const carrier = { kind: 'modal' as const, index: indexOf(fiber, 'RCTModalHostView') };
    expect(carriedCover(ancestry, carrier, SELF)).toEqual(expected);
  });
});

describe('stack motion and covers', () => {
  it.each<[unknown, unknown, StackMotion]>([
    ['slide_from_right', undefined, 'sideways'],
    ['slide_from_left', undefined, 'sideways'],
    ['ios_from_right', undefined, 'sideways'],
    ['ios_from_left', undefined, 'sideways'],
    ['slide_from_bottom', undefined, 'upwards'],
    ['fade', undefined, 'still'],
    ['simple_push', 'push', 'sideways'],
    ['fade_from_bottom', undefined, 'upwards'],
    ['none', undefined, 'still'],
    ['default', 'modal', 'any'],
    [undefined, undefined, 'any'],
    ['flip', undefined, 'any'],
  ])('%s, presented %s: %s', (stackAnimation, stackPresentation, expected) => {
    expect(stackMotionOf({ stackAnimation, stackPresentation })).toBe(expected);
  });

  it('props that are not there: any motion', () => {
    expect(stackMotionOf(null)).toBe('any');
  });

  it.each<[StackMotion, boolean, WindowRect]>([
    ['sideways', true, rect(0, 100, 400, 50)],
    ['sideways', false, rect(0, 100, 400, 50)],
    ['upwards', true, rect(10, 100, 200, 700)],
    ['upwards', false, SELF],
    ['still', true, SELF],
    ['any', false, SCREEN],
  ])('%s, the screen moving %s', (motion, moving, expected) => {
    expect(screenCover(motion, SCREEN, SELF, moving)).toEqual(expected);
  });

  it('a view below the screen\'s bottom still has a column of its own height', () => {
    expect(screenCover('upwards', rect(0, 0, 400, 100), SELF, true)).toEqual(SELF);
  });

  it('a view not on screen is covered nowhere, whatever the motion', () => {
    expect(screenCover('any', SCREEN, null, true)).toBeNull();
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    expect(carriedCover(ancestry, { kind: 'screen', index: 1 }, null)).toBeNull();
    expect(carriedCover(ancestry, { kind: 'screen', index: 1 }, undefined)).toEqual(SCREEN);
  });

  it('finds a stack\'s screens below wrapper components, not below hosts or inside screens', () => {
    const screen = (name: string): FiberSpec => fabricHost(SCREEN_HOST_TYPE, SCREEN, { name }, [
      fabricHost(SCREEN_HOST_TYPE, SCREEN, { name: 'inside' }, []),
    ]);
    const stack = buildFiberTree(
      fabricHost('RNSScreenStack', null, {}, [
        screen('a'),
        composite([screen('b')]),
        fabricHost('RCTView', null, {}, [screen('c')]),
      ]),
    );

    const names = [...screensOn(stack).values()].map((props) => (props as { name: string }).name);
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('looks for screens 16 wrappers deep, and no deeper', () => {
    const wrapped = (depth: number, name: string): FiberSpec => {
      let spec: FiberSpec = fabricHost(SCREEN_HOST_TYPE, SCREEN, { name }, []);
      for (let level = 0; level < depth; level += 1) {
        spec = composite([spec]);
      }
      return spec;
    };
    const stack = buildFiberTree(fabricHost('RNSScreenStack', null, {}, [wrapped(16, 'deep'), wrapped(17, 'deeper')]));

    expect([...screensOn(stack).values()].map((props) => (props as { name: string }).name)).toEqual(['deep']);
  });

  it('tells every view joined on a stack, until it leaves; a stack nobody joined tells nobody', () => {
    const stack = {};
    const told = jest.fn();
    const leave = joinStack(stack, told);
    const change = { motion: 'sideways' as const, until: 5, moving: {}, below: undefined };
    stackMoving(stack, change, true);
    leave();
    stackMoving(stack, { ...change }, true);
    stackMoving({}, { ...change, motion: 'any' }, true);

    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalledWith(change);
  });

  describe('R3-3: what a stack keeps of its recent changes', () => {
    const screen = (name: string, props: Record<string, unknown> = {}): FiberSpec =>
      fabricHost(SCREEN_HOST_TYPE, SCREEN, { name, ...props }, []);
    /** A committed stack of `screens`; `before`: its render before, as its other fiber. */
    function stackOf(screens: FiberSpec[], before?: FiberSpec[]): FiberLike {
      const stack = buildFiberTree(fabricHost('RNSScreenStack', null, {}, screens));
      if (before !== undefined) {
        stack.alternate = { ...buildFiberTree(fabricHost('RNSScreenStack', null, {}, before)), alternate: stack };
        // The same hosts in both renders: the same keys.
        let from = stack.alternate.child;
        for (let to = stack.child; to !== null && from !== null; to = to.sibling, from = from.sibling) {
          from.stateNode = to.stateNode;
        }
      }
      return stack;
    }
    const keys = (stack: FiberLike): object[] => [...screensOn(stack).keys()];

    it('read first, is compared with its render before: a pop no view saw is recorded from now', () => {
      const stack = stackOf([screen('a')], [screen('a'), screen('b', { stackAnimation: 'slide_from_left' })]);
      const [, bKey] = keys(stack.alternate as FiberLike);

      const changes = observeStack(stack, screensOn(stack), 1000);

      expect(changes).toEqual([
        { motion: 'sideways', until: 1000 + SECURE_TRANSITION_HOLD_MS, moving: bKey, below: keys(stack)[0] },
      ]);
      // Read again: nothing new, the change kept within its hold, and dropped once it is over.
      expect(observeStack(stack, screensOn(stack), 1500)).toEqual(changes);
      expect(observeStack(stack, screensOn(stack), 1000 + SECURE_TRANSITION_HOLD_MS)).toEqual([]);
    });

    it('read first with no render before (mounted whole), records nothing', () => {
      const stack = stackOf([screen('a'), screen('b')]);

      expect(observeStack(stack, screensOn(stack), 0)).toEqual([]);
    });

    it('a push since the last read: the screen it covers is the top before; its birth is noted', () => {
      const stack = stackOf([screen('a')]);
      const [aKey] = keys(stack);
      observeStack(stack, screensOn(stack), 0);
      (stack.child as FiberLike).sibling = { ...buildFiberTree(screen('c')), return: stack };
      const [, cKey] = keys(stack);

      expect(observeStack(stack, screensOn(stack), 100)).toEqual([
        { motion: 'any', until: 100 + SECURE_TRANSITION_HOLD_MS, moving: cKey, below: aKey },
      ]);
      // Born at the push.
      const anyFiber = { stateNode: { canonical: cKey } } as never;
      expect(carrierEntering({ path: [anyFiber] } as never, { kind: 'screen', index: 0 }, 300)).toBe(
        100 + SECURE_TRANSITION_HOLD_MS,
      );
    });

    it('a change recorded by the moving screen\'s view is not recorded again; its screens are updated', () => {
      const stack = stackOf([screen('a'), screen('b')]);
      const [aKey, bKey] = keys(stack);
      const key = keyOf(stack);
      observeStack(stack, screensOn(stack), 0);
      const popped = { motion: 'any' as const, until: 900, moving: bKey as object, below: undefined };
      stackMoving(key, popped, true);
      (stack.child as FiberLike).sibling = null;

      // B's own view saw it leave: the screens read now match, and its change is the one kept.
      expect(observeStack(stack, screensOn(stack), 200)).toEqual([popped]);
      const pushed = { motion: 'still' as const, until: 1100, moving: bKey as object, below: undefined };
      stackMoving(key, pushed, false);
      (stack.child as FiberLike).sibling = { ...buildFiberTree(screen('b')), stateNode: { canonical: bKey } };
      expect(observeStack(stack, screensOn(stack), 300)).toEqual([popped, pushed]);
      expect(keys(stack)).toEqual([aKey, bKey]);
    });

    it('a screen told leaving is not found popped again once its hold is over', () => {
      const stack = stackOf([screen('a'), screen('b')]);
      const [, bKey] = keys(stack);
      observeStack(stack, screensOn(stack), 0);
      stackMoving(keyOf(stack), { motion: 'any', until: 800, moving: bKey as object, below: undefined }, true);
      (stack.child as FiberLike).sibling = null;

      expect(observeStack(stack, screensOn(stack), 900)).toEqual([]);
    });

    it('a pop told before any view read the stack is not recorded again from its render before', () => {
      const stack = stackOf([screen('a')], [screen('a'), screen('b')]);
      const [, bKey] = keys(stack.alternate as FiberLike);
      const change = { motion: 'any' as const, until: 800, moving: bKey as object, below: undefined };
      stackMoving(keyOf(stack), change, true);

      expect(observeStack(stack, screensOn(stack), 100)).toEqual([change]);
    });

    it('a change told before any view read the stack is kept for the first that does', () => {
      const stack = stackOf([screen('a')]);
      const change = { motion: 'any' as const, until: 800, moving: {}, below: undefined };
      stackMoving(keyOf(stack), change, true);

      expect(observeStack(stack, screensOn(stack), 100)).toEqual([change]);
      expect(observeStack(stack, screensOn(stack), 800)).toEqual([]);
    });
  });

  it('keys a host by its shared canonical, on Paper by its shared instance, or else the fiber itself', () => {
    const canonical = {};

    expect(keyOf({ stateNode: { canonical } } as never)).toBe(canonical);
    const bare = { stateNode: null } as never;
    expect(keyOf(bare)).toBe(bare);
    const notAnObject = { stateNode: 7 } as never;
    expect(keyOf(notAnObject)).toBe(notAnObject);
    // P3-e: Paper's host instance is shared by both fibers of the pair.
    const instance = { canonical: null };
    expect(keyOf({ stateNode: instance } as never)).toBe(instance);
    expect(keyOf({ stateNode: { canonical: 'x' } } as never)).toEqual({ canonical: 'x' });
  });

  it('a screen moving sideways, its view never measured, covers the whole screen', () => {
    const fiber = selfIn(
      root([
        fabricHost('RNSScreenStack', null, {}, [
          fabricHost(SCREEN_HOST_TYPE, SCREEN, { stackAnimation: 'slide_from_right' }, [view([self()])]),
        ]),
      ]),
    );

    expect(carriedCover(ancestryOfFiber(fiber), { kind: 'screen', index: 1 }, undefined)).toEqual(SCREEN);
  });
});
