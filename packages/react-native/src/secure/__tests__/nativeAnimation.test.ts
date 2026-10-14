/**
 * `nativeAnimation.ts` bounds where native-driven `Animated` transforms can
 * draw a view, from the `Animated` nodes in the props of the components that
 * render its ancestors. Every case it cannot bound must cover more, never
 * less.
 */
import { ancestryOfFiber, isAnimatedComponent, isHidden } from '../ancestry';
import { nativeMotion, nodeRange } from '../nativeAnimation';
import { WHOLE_SURFACE } from '../transition';
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import type { FiberSpec } from '../../viewtree/__tests__/fakeFibers';
import { composite, fabricHost, fakeRenderer, rect, root, self, selfIn, view } from './fakeAncestors';
import type { FakeRenderer } from './fakeAncestors';

let renderer: FakeRenderer;
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  getPublicInstanceFromInternalInstanceHandle: (fiber: FiberLike) =>
    renderer.getPublicInstanceFromInternalInstanceHandle(fiber),
}));

beforeEach(() => {
  renderer = fakeRenderer();
});

const linear = (t: number): number => t;

interface Value {
  __isNative: boolean;
  _value: unknown;
  _offset: unknown;
  _animation: unknown;
  __getValue: () => unknown;
}

function value(at: unknown, animation: unknown = null, offset: unknown = 0): Value {
  const node: Value = {
    __isNative: true,
    _value: at,
    _offset: offset,
    _animation: animation,
    __getValue: () =>
      typeof node._value === 'number' && typeof node._offset === 'number' ? node._value + node._offset : node._value,
  };
  return node;
}

const timing = (from: unknown, to: unknown, easing: unknown = linear): object => ({
  _fromValue: from,
  _toValue: to,
  _easing: easing,
});

function interpolated(parent: object, inputRange: unknown, map: unknown): object {
  return {
    __isNative: true,
    _parent: parent,
    _config: { inputRange },
    _getInterpolation: map === undefined ? undefined : () => map,
    __getValue: () => 0,
  };
}

describe('nodeRange', () => {
  it('a still value is where it is, offset included', () => {
    expect(nodeRange(value(3, null, 2) as never)).toEqual({ lo: 5, hi: 5 });
  });

  it('a timing animation covers from its start to its end, offset included', () => {
    expect(nodeRange(value(0, timing(10, -20), 1) as never)).toEqual({ lo: -19, hi: 11 });
  });

  it('a timing animation reaches what its easing overshoots, both ways', () => {
    const back = (t: number): number => t * t * (2.2 * t - 1.2);
    const range = nodeRange(value(0, timing(0, 100, back)) as never) as { lo: number; hi: number };

    expect(range.lo).toBeLessThan(0);
    expect(range.hi).toBeCloseTo(100);
  });

  it('a value whose offset is not a number counts none', () => {
    const node = value(4, timing(0, 10));
    node.__getValue = () => 4;
    node._offset = undefined;

    expect(nodeRange(node as never)).toEqual({ lo: 0, hi: 10 });
  });

  it.each<[string, unknown]>([
    ['a non-finite value', value(Number.NaN)],
    ['a value whose offset makes it non-finite', value(1, null, Number.NaN)],
    ['a spring (no start)', value(0, { _toValue: 1, _easing: linear })],
    ['an animation with no end', value(0, { _fromValue: 0, _easing: linear })],
    ['an animation with no easing', value(0, { _fromValue: 0, _toValue: 1 })],
    ['an easing that answers NaN', value(0, timing(0, 1, () => Number.NaN))],
    ['a node with no value (Animated.add)', { __isNative: true, __getValue: () => 1 }],
  ])('cannot bound %s', (_, node) => {
    expect(nodeRange(node as never)).toBeUndefined();
  });

  it('an interpolation maps every value its input can take, its breakpoints included', () => {
    // A peak at 0.33, between the samples.
    const peak = (x: number): number => (x <= 0.33 ? (x / 0.33) * 100 : ((1 - x) / 0.67) * 100);
    const node = interpolated(value(0, timing(0, 1)), [0, 0.33, 1, 'x', 2], peak);

    expect(nodeRange(node as never)).toEqual({ lo: 0, hi: 100 });
  });

  it('a breakpoint outside what its input can take does not widen it', () => {
    const node = interpolated(value(0, timing(0, 1)), [-5, 0, 1, 5], (x: number) => x * 10);

    expect(nodeRange(node as never)).toEqual({ lo: 0, hi: 10 });
  });

  it('samples between where its input starts and ends, away from zero', () => {
    expect(nodeRange(interpolated(value(2, timing(2, 4)), [0, 10], (x: number) => x) as never)).toEqual({
      lo: 2,
      hi: 4,
    });
  });

  it('an interpolation with no config still samples its input', () => {
    const node = { ...interpolated(value(0, timing(0, 1)), [], (x: number) => x), _config: undefined };

    expect(nodeRange(node as never)).toEqual({ lo: 0, hi: 1 });
  });

  it('an interpolation with no breakpoints still samples its input', () => {
    expect(nodeRange(interpolated(value(0, timing(0, 2)), undefined, (x: number) => x * 10) as never)).toEqual({
      lo: 0,
      hi: 20,
    });
  });

  it.each<[string, unknown]>([
    ['an input it cannot bound', interpolated(value(0, { _toValue: 1 }), [0, 1], linear)],
    ['no interpolation function', interpolated(value(0), [0, 1], undefined)],
    ['a string output', interpolated(value(0), [0, 1], () => '10deg')],
    ['one output that is not finite', interpolated(value(0, timing(0, 1)), [0, 1], (x: number) => (x > 0.5 ? NaN : x))],
  ])('cannot bound an interpolation with %s', (_, node) => {
    expect(nodeRange(node as never)).toBeUndefined();
  });
});

const AnimatedView = Object.assign(() => null, { displayName: 'Animated(View)' });

/** The ancestry of a view under an `Animated.View` styled `style`, over a host rendered with `rendered`. */
function under(
  style: unknown,
  rendered: unknown = {},
  hostRect: WindowRect = rect(0, 0, 400, 400),
  between: (spec: FiberSpec) => FiberSpec = (spec) => spec,
): ReturnType<typeof ancestryOfFiber> {
  const fiber = selfIn(
    root([
      {
        tag: FiberTag.FunctionComponent,
        type: AnimatedView,
        memoizedProps: { style },
        children: [between(fabricHost('RCTView', hostRect, { style: rendered }, [view([self()])]))],
      },
    ]),
  );
  const ancestry = ancestryOfFiber(fiber);
  isHidden(ancestry);
  return ancestry;
}

const SELF = rect(10, 100, 200, 50);

describe('isAnimatedComponent', () => {
  it.each<[string, unknown, boolean]>([
    ['a function named Animated(…)', Object.assign(() => null, { displayName: 'Animated(View)' }), true],
    ['a forwardRef named Animated(…)', { render: { displayName: 'Animated(Text)' } }, true],
    ['an object with its own name', { displayName: 'Animated(Image)' }, true],
    ['any other name', Object.assign(() => null, { displayName: 'View' }), false],
    ['no name', () => null, false],
    ['a non-string name', { displayName: 7 }, false],
    ['a host type', 'RCTView', false],
    ['no type', null, false],
  ])('%s: %s', (_, type, expected) => {
    expect(isAnimatedComponent({ type } as FiberLike)).toBe(expected);
  });
});

describe('nativeMotion', () => {
  it('nothing Animated above the view: nothing to do', () => {
    const ancestry = ancestryOfFiber(selfIn(root([view([self()])])));

    expect(nativeMotion(SELF, ancestry)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['no style', undefined],
    ['a style without a transform', { opacity: value(1) }],
    ['a transform of plain numbers', { transform: [{ translateX: 10 }] }],
    ['a JS-driven transform', { transform: [{ translateX: { ...value(10), __isNative: false } }] }],
    ['a transform that is not a list', { transform: 'translateX(10px)' }],
    ['a transform function with no value', { transform: [{ translateX: null }] }],
    ['a value that only says it is native', { transform: [{ translateX: { __isNative: true } }] }],
    ['a transform entry that is a number', { transform: [{ translateX: value(1) }, 5] }],
    // React Native rejects it before anything is drawn.
    ['a transform entry that is not an object', { transform: [{ translateX: value(1) }, null] }],
  ])('an Animated component with %s moves nothing natively', (_, style) => {
    expect(nativeMotion(SELF, under(style))).toBeNull();
  });

  it('an Animated component with no props moves nothing', () => {
    const ancestry = under(undefined);
    (ancestry.path[ancestry.animated[0] as number] as FiberLike).memoizedProps = null;
    ancestry.resolved = undefined;

    expect(nativeMotion(SELF, ancestry)).toBeNull();
  });

  it('a rendered transform without that function covers the whole span either way', () => {
    const ancestry = under(
      { transform: [{ translateX: value(0, timing(0, 50)) }] },
      { transform: [{ translateY: 0 }] },
    );

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(-40, 100, 300, 50));
  });


  it('moves the view by the translations a still value adds to what was rendered', () => {
    const ancestry = under({ transform: [{ translateX: value(30) }, { translateY: value(-5) }] }, {
      transform: [{ translateX: 10 }, { translateY: 0 }],
    });

    expect(nativeMotion(SELF, ancestry)).toEqual({
      rect: rect(30, 95, 200, 50),
      above: ancestry.animated[0],
    });
  });

  it('adds up translations of one axis, static ones included', () => {
    const ancestry = under(
      { transform: [{ translateY: value(5) }, { translateY: 20 }, { translateY: value(7) }] },
      { transform: [{ translateY: 0 }] },
    );

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(10, 112, 200, 50));
  });

  it('without the rendered value, covers the whole span either way', () => {
    const ancestry = under({ transform: [{ translateX: value(10, timing(10, 50)) }] }, { transform: 'none' });

    expect(nativeMotion(SELF, ancestry)).toEqual({
      rect: rect(-30, 100, 280, 50),
      above: ancestry.animated[0],
    });
  });


  it('scales each axis about the transformed view’s centre', () => {
    const ancestry = under(
      { transform: [{ scaleX: value(1, timing(1, 2)) }, { scaleY: value(3) }] },
      { transform: [{ scaleX: 1 }, { scaleY: 1.5 }] },
      rect(0, 0, 400, 400),
    );

    // x 10..210 about 200, by 1 to 2: as far as -180..220; y 100..150 about 200, by 2: 0..100.
    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(-180, 0, 400, 100));
  });

  it('a scale down to nothing shrinks the view to the centre', () => {
    const ancestry = under({ transform: [{ scale: value(0, timing(0, 1)) }] }, { transform: [{ scale: 1 }] });

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(10, 100, 200, 100));
  });

  it('a uniform scale scales both axes', () => {
    const ancestry = under({ transform: [{ scale: value(2) }] }, { transform: [{ scale: 1 }] });

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(-180, 0, 400, 100));
  });

  it('a static scale next to a native one moves nothing more', () => {
    const ancestry = under(
      { transform: [{ scaleX: 2 }, { scaleY: value(1) }] },
      { transform: [{ scaleX: 2 }, { scaleY: 1 }] },
    );

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(SELF);
  });

  it.each<[string, unknown, unknown]>([
    ['a rotation', { transform: [{ rotate: value(1) }] }, {}],
    [
      'a scale mixed with a rotation',
      { transform: [{ scale: value(1) }, { rotate: '10deg' }] },
      { transform: [{ scale: 1 }] },
    ],
    ['a translation mixed with a rotation', { transform: [{ translateX: value(1) }, { rotate: '10deg' }] }, {}],
    ['a translation it cannot bound', { transform: [{ translateX: value(0, { _toValue: 1 }) }] }, {}],
    ['a scale it cannot bound', { transform: [{ scale: value(0, { _toValue: 1 }) }] }, { transform: [{ scale: 1 }] }],
    ['a scale without the rendered value', { transform: [{ scale: value(2) }] }, {}],
    ['a scale rendered at zero', { transform: [{ scale: value(2) }] }, { transform: [{ scale: 0 }] }],
    [
      'a scale that can go negative',
      { transform: [{ scale: value(0, timing(1, -1)) }] },
      { transform: [{ scale: 1 }] },
    ],
  ])('covers the whole surface for %s', (_, style, rendered) => {
    const ancestry = under(style, rendered);

    expect(nativeMotion(SELF, ancestry)).toEqual(
      expect.objectContaining({ rect: WHOLE_SURFACE, above: ancestry.animated[0] }),
    );
  });

  it('covers the whole surface for a scale about a view that cannot be measured', () => {
    const ancestry = under({ transform: [{ scale: value(2) }] }, { transform: [{ scale: 1 }] }, rect(0, 0, 0, 0));

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(WHOLE_SURFACE);
  });

  it('covers the whole surface when reading the transform throws', () => {
    const throwing = value(1);
    Object.defineProperty(throwing, '_animation', {
      get(): never {
        throw new Error('torn');
      },
    });
    const ancestry = under({ transform: [{ translateX: throwing }] }, { transform: [{ translateX: 0 }] });

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(WHOLE_SURFACE);
  });

  it('transforms nested Animated components from the nearest out', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform: [{ translateY: value(100) }] } },
          children: [
            fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateY: 0 }] } }, [
              {
                tag: FiberTag.FunctionComponent,
                type: AnimatedView,
                memoizedProps: { style: { transform: [{ translateX: value(5) }] } },
                children: [
                  fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateX: 0 }] } }, [self()]),
                ],
              },
            ]),
          ],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(nativeMotion(SELF, ancestry)).toEqual({
      rect: rect(15, 200, 200, 50),
      above: ancestry.animated[1],
    });
  });

  it('an Animated component right above the view transforms the view itself', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform: [{ translateX: value(5) }] } },
          children: [{ ...self(), memoizedProps: { style: { transform: [{ translateX: 0 }] } } }],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(15, 100, 200, 50));
  });

  it('reads the stored path when the committed tree cannot be resolved', () => {
    const ancestry = under({ transform: [{ translateX: value(5) }] }, { transform: [{ translateX: 0 }] });
    ancestry.resolved = undefined;

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(15, 100, 200, 50));
  });

  it('an Animated component inside a composite between hosts is found', () => {
    const ancestry = under(
      { transform: [{ translateX: value(5) }] },
      { transform: [{ translateX: 0 }] },
      undefined,
      (spec) => composite([spec]),
    );

    expect(nativeMotion(SELF, ancestry)?.rect).toEqual(rect(15, 100, 200, 50));
  });
});
