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
  screenCover,
  stackMotionOf,
  stackMoving,
} from '../transition';
import type { StackMotion } from '../transition';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import { fabricHost, fakeRenderer, rect, root, self, selfIn, view } from './fakeAncestors';
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
  it('a carrier created by the commit running now is carried in until the hold ends, and stays so', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    const carrier = { kind: 'screen' as const, index: 0 };

    // Mounted whole, as an app starts: nothing above it was there.
    expect(carrierEntering(ancestry, carrier, 1000)).toBeUndefined();
    const above = ancestry.path[1] as FiberLike;
    above.alternate = { ...above, alternate: above };
    expect(carrierEntering(ancestry, carrier, 1000)).toBe(1000 + SECURE_TRANSITION_HOLD_MS);
    // Rendered again since, a later view still finds it carried in, from when it was created.
    const screen = ancestry.path[0] as FiberLike;
    screen.alternate = { ...screen, alternate: screen };
    expect(carrierEntering(ancestry, carrier, 1300)).toBe(1000 + SECURE_TRANSITION_HOLD_MS);
    expect(carrierEntering(ancestry, carrier, 1000 + SECURE_TRANSITION_HOLD_MS)).toBeUndefined();
  });

  it('a carrier there before, never seen created, is not carried in', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    for (const fiber of ancestry.path) {
      fiber.alternate = { ...fiber, alternate: fiber };
    }

    expect(carrierEntering(ancestry, { kind: 'screen', index: 0 }, 5)).toBeUndefined();
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

  it('tells every view joined on a stack, until it leaves; a stack nobody joined tells nobody', () => {
    const stack = {};
    const told = jest.fn();
    const leave = joinStack(stack, told);
    stackMoving(stack, 'sideways', 5, {});
    leave();
    stackMoving(stack, 'sideways', 5, {});
    stackMoving({}, 'any', 5, {});

    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalledWith('sideways', 5, {});
  });

  it('keys a host by its shared canonical, or else the fiber itself', () => {
    const canonical = {};

    expect(keyOf({ stateNode: { canonical } } as never)).toBe(canonical);
    const bare = { stateNode: null } as never;
    expect(keyOf(bare)).toBe(bare);
    const nullCanonical = { stateNode: { canonical: null } } as never;
    expect(keyOf(nullCanonical)).toBe(nullCanonical);
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
