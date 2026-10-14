/**
 * `transition.ts` tells a native transition (a stack push or pop, a Modal
 * opening or closing) from a view coming and going in place, by the fiber
 * tree alone, and says where the transition can draw the view.
 */
import { MODAL_SCREEN_HOST_TYPE, SCREEN_HOST_TYPE, ancestryOfFiber, noAncestry } from '../ancestry';
import {
  WHOLE_SURFACE,
  carriedCover,
  carrierEntering,
  carrierLeaving,
  carrierOf,
  deletionRoot,
} from '../transition';
import type { FiberLike } from '../../viewtree/fiber';
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

describe('carrierOf', () => {
  it('a screen in a stack carries the view', () => {
    const fiber = onScreen('RNSScreenStack');

    expect(carrierOf(ancestryOfFiber(fiber))).toEqual({ kind: 'screen', index: indexOf(fiber, SCREEN_HOST_TYPE) });
  });

  it('so does a modal screen in a stack', () => {
    const fiber = onScreen('RNSScreenStack', MODAL_SCREEN_HOST_TYPE);

    expect(carrierOf(ancestryOfFiber(fiber))?.kind).toBe('screen');
  });

  it('a screen in a tab container does not; nothing else does either', () => {
    expect(carrierOf(ancestryOfFiber(onScreen('RNSScreenContainer')))).toBeNull();
  });

  it('a Modal carries a view on a screen that does not', () => {
    const fiber = inModal({});

    expect(carrierOf(ancestryOfFiber(fiber))).toEqual({ kind: 'modal', index: indexOf(fiber, 'RCTModalHostView') });
  });

  it('nothing above the view: nothing carries it', () => {
    expect(carrierOf(noAncestry())).toBeNull();
  });
});

describe('carrierEntering', () => {
  it('a carrier with no alternate was created by the commit running now', () => {
    const ancestry = ancestryOfFiber(onScreen('RNSScreenStack'));
    const carrier = { kind: 'screen' as const, index: 0 };

    // Mounted whole, as an app starts: nothing above it was there.
    expect(carrierEntering(ancestry, carrier)).toBe(false);
    const above = ancestry.path[1] as FiberLike;
    above.alternate = { ...above, alternate: above };
    expect(carrierEntering(ancestry, carrier)).toBe(true);
    (ancestry.path[0] as FiberLike).alternate = null;
    expect(carrierEntering(ancestry, carrier)).toBe(true);
    (ancestry.path[0] as FiberLike).alternate = { ...(ancestry.path[0] as FiberLike) };
    expect(carrierEntering(ancestry, carrier)).toBe(false);
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
