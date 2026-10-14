/**
 * `nativeAnimation.ts` bounds where native-driven transforms can draw a view,
 * from the `Animated` nodes in the props of the components that render its
 * ancestors. Every case it cannot bound must cover more, never less, and
 * never move a mask off the view.
 */
import { ancestryOfFiber, isAnimatedComponent, isHidden, isReanimatedComponent, measurePass } from '../ancestry';
import { nativeMotion, nodeBound, originOf, throughMotion } from '../nativeAnimation';
import { WHOLE_SURFACE } from '../transition';
import { FiberTag } from '../../viewtree/fiber';
import type { FiberLike, WindowRect } from '../../viewtree/fiber';
import type { FiberSpec } from '../../viewtree/__tests__/fakeFibers';
import { composite, fabricHost, fakeRenderer, rect, root, scrollView, self, selfIn, view } from './fakeAncestors';
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
  _tracking: unknown;
  __getValue: () => unknown;
  hasListeners: () => boolean;
}

/** A native `Animated.Value`; `synced`: JS holds its native value (the app listens). */
function value(at: unknown, animation: unknown = null, offset: unknown = 0, synced = true): Value {
  const node: Value = {
    __isNative: true,
    _value: at,
    _offset: offset,
    _animation: animation,
    _tracking: null,
    __getValue: () =>
      typeof node._value === 'number' && typeof node._offset === 'number' ? node._value + node._offset : node._value,
    hasListeners: () => synced,
  };
  return node;
}

const timing = (from: unknown, to: unknown, easing: unknown = linear): object => ({
  _fromValue: from,
  _toValue: to,
  _easing: easing,
});

function interpolated(parent: unknown, config: Record<string, unknown>, map: unknown): object {
  return {
    __isNative: true,
    _parent: parent,
    _config: config,
    _getInterpolation: map === undefined ? undefined : () => map,
    __getValue: () => 0,
  };
}

const binary = (a: unknown, b: unknown, extra: Record<string, unknown> = {}): object => ({
  __isNative: true,
  _a: a,
  _b: b,
  __getValue: () => 0,
  ...extra,
});

describe('nodeBound', () => {
  it('a number is itself; anything else that is not a node is unbounded', () => {
    expect(nodeBound(7)).toEqual({ range: { lo: 7, hi: 7 }, running: false, roots: [] });
    expect(nodeBound('7').range).toBeUndefined();
    expect(nodeBound(null).range).toBeUndefined();
  });

  it('a still value JS provably holds is where it is, offset included', () => {
    const node = value(3, null, 2);

    expect(nodeBound(node)).toEqual({ range: { lo: 5, hi: 5 }, running: false, roots: [node] });
  });

  it('a still value nobody animated from JS, with no listener, is unbounded (an Animated.event may drive it)', () => {
    const node = value(3, null, 0, false);

    expect(nodeBound(node)).toEqual({ range: undefined, running: false, roots: [node] });
  });

  it('a still value seen animating before is where it is', () => {
    const node = value(0, timing(0, 10), 0, false);
    expect(nodeBound(node).running).toBe(true);

    node._animation = null;
    node._value = 10;
    expect(nodeBound(node).range).toEqual({ lo: 10, hi: 10 });
  });

  it('a timing animation covers from its start to its end, offset included, and runs', () => {
    expect(nodeBound(value(0, timing(10, -20), 1))).toEqual(
      expect.objectContaining({ range: { lo: -19, hi: 11 }, running: true }),
    );
  });

  it('an easing that turns back is widened: a peak can fall between samples', () => {
    const back = (t: number): number => t * t * (2.2 * t - 1.2);
    const range = nodeBound(value(0, timing(0, 100, back))).range as { lo: number; hi: number };

    expect(range.lo).toBeLessThan(-10);
    expect(range.hi).toBeGreaterThan(100);
  });

  it.each<[string, unknown]>([
    ['renamed fields', { __isNative: true, _val: 0, _offset: 0, _animation: null, __getValue: () => 0 }],
    ['no _offset', { __isNative: true, _value: 0, _animation: null, __getValue: () => 0 }],
    ['no _value', { __isNative: true, _offset: 0, _animation: null, __getValue: () => 0 }],
  ])('a value with %s is unbounded', (_, node) => {
    expect(nodeBound(node).range).toBeUndefined();
  });

  it.each<[string, Value]>([
    ['a non-finite value', value(Number.NaN)],
    ['a non-finite offset', value(1, null, Number.NaN)],
    ['a tracked value', Object.assign(value(1), { _tracking: {} })],
  ])('%s is unbounded', (_, node) => {
    expect(nodeBound(node).range).toBeUndefined();
  });

  it.each<[string, Value]>([
    ['a spring (no start)', value(0, { _toValue: 1, _easing: linear })],
    ['an animation with no easing', value(0, { _fromValue: 0, _toValue: 1 })],
    ['an easing that answers NaN', value(0, timing(0, 1, () => Number.NaN))],
  ])('%s runs, unbounded', (_, node) => {
    expect(nodeBound(node)).toEqual(expect.objectContaining({ range: undefined, running: true }));
  });

  it('an interpolation maps every value its input can take, breakpoints included', () => {
    const peak = (x: number): number => (x <= 0.33 ? (x / 0.33) * 100 : ((1 - x) / 0.67) * 100);
    const node = interpolated(value(0, timing(0, 1)), { inputRange: [0, 0.33, 1, 'x', -1, 2] }, peak);

    const range = nodeBound(node).range as { lo: number; hi: number };
    expect(range.lo).toBeLessThanOrEqual(0);
    expect(range.hi).toBeGreaterThanOrEqual(100);
  });

  it('an interpolation with no config at all still maps its input', () => {
    const node = { ...interpolated(value(2, timing(2, 4)), {}, (x: number) => x * 2), _config: undefined };

    expect(nodeBound(node).range).toEqual({ lo: 4, hi: 8 });
  });

  it('a monotonic interpolation is not widened', () => {
    expect(nodeBound(interpolated(value(2, timing(2, 4)), {}, (x: number) => x)).range).toEqual({ lo: 2, hi: 4 });
  });

  it('an interpolation clamped at both ends is within its outputs, whatever its input', () => {
    const unknown = value(0, null, 0, false);
    const clamped = interpolated(unknown, { outputRange: [0, -60, 20], extrapolate: 'clamp' }, (x: number) => x);
    const sides = interpolated(
      unknown,
      { outputRange: [5, 9], extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      undefined,
    );

    expect(nodeBound(clamped).range).toEqual({ lo: -60, hi: 20 });
    expect(nodeBound(sides).range).toEqual({ lo: 5, hi: 9 });
  });

  it.each<[string, Record<string, unknown>]>([
    ['clamped on one side only', { outputRange: [0, 1], extrapolateLeft: 'clamp' }],
    ['with string outputs', { outputRange: ['0deg', '9deg'], extrapolate: 'clamp' }],
    ['with no outputs', { extrapolate: 'clamp' }],
  ])('an interpolation of an unbounded input %s is unbounded', (_, config) => {
    expect(nodeBound(interpolated(value(0, null, 0, false), config, linear)).range).toBeUndefined();
  });

  it('an interpolation answering something that is not a number falls back to its clamp, or nothing', () => {
    const input = value(0, timing(0, 1));

    expect(nodeBound(interpolated(input, {}, () => '1deg')).range).toBeUndefined();
    expect(nodeBound(interpolated(input, { outputRange: [0, 4], extrapolate: 'clamp' }, () => 'x')).range).toEqual({
      lo: 0,
      hi: 4,
    });
  });

  it('diffClamp is within its bounds, whatever its input; its input still counts as running', () => {
    const input = value(0, timing(0, 500));

    expect(nodeBound({ __isNative: true, _a: input, _min: 0, _max: 60, __getValue: () => 0 })).toEqual(
      expect.objectContaining({ range: { lo: 0, hi: 60 }, running: true }),
    );
    expect(nodeBound({ __isNative: true, _a: input, _min: 'x', _max: 60, __getValue: () => 0 }).range).toBeUndefined();
  });

  it('modulo is between 0 and its modulus', () => {
    const input = value(0, null, 0, false);

    const negative = { __isNative: true, _a: input, _modulus: -8, __getValue: () => 0 };
    expect(nodeBound(negative).range).toEqual({ lo: -8, hi: 0 });
    expect(nodeBound({ __isNative: true, _a: input, _modulus: null, __getValue: () => 0 }).range).toBeUndefined();
  });

  it('add, subtract and multiply are bounded by intervals over both operands', () => {
    expect(nodeBound(binary(value(1, timing(1, 2)), 3)).range).toEqual({ lo: -2, hi: 6 });
  });

  it('a division is bounded unless its divisor can be zero; an unbounded operand is unbounded', () => {
    const division = { _warnedAboutDivideByZero: false };

    expect(nodeBound(binary(value(4), value(2, timing(2, 4)), division)).range).toEqual({ lo: 1, hi: 2 });
    expect(nodeBound(binary(value(4), value(0, timing(-1, 1)), division)).range).toBeUndefined();
    expect(nodeBound(binary(value(4, null, 0, false), 2)).range).toBeUndefined();
  });

  it('computes a node once per measure pass', () => {
    const getter = jest.fn(() => 1);
    const node = { ...value(1), __getValue: getter };
    measurePass(() => {
      nodeBound(node);
      nodeBound(node);
    });

    expect(getter).toHaveBeenCalledTimes(1);
  });
});

describe('originOf', () => {
  const style = (transformOrigin: unknown): unknown => ({ style: { transformOrigin } });
  const at = (fraction: number, length = 0): object => ({ fraction, length });

  it.each<[string, unknown, object | undefined]>([
    ['unset: the centre', undefined, { x: at(0.5), y: at(0.5) }],
    ['keywords', 'top left', { x: at(0), y: at(0) }],
    ['keywords the CSS way round', 'right bottom', { x: at(1), y: at(1) }],
    ['one vertical keyword', 'bottom', { x: at(0.5), y: at(1) }],
    ['one horizontal keyword', 'left', { x: at(0), y: at(0.5) }],
    ['percentages and lengths', '25% 10px', { x: at(0.25), y: at(0, 10) }],
    ['an array, with a z', [5, '50%', 3], { x: at(0, 5), y: at(0.5) }],
    ['a calc()', 'calc(50% - 2px) top', undefined],
    ['words it does not know', 'middle top', undefined],
    ['four values', '1 2 3 4', undefined],
    ['an empty array', [], undefined],
    ['an object', { x: 1 }, undefined],
    ['an array with an object', [{}, 1], undefined],
  ])('%s', (_, origin, expected) => {
    expect(originOf(style(origin))).toEqual(expected);
  });

  it('props without a style: the centre', () => {
    expect(originOf(null)).toEqual({ x: at(0.5), y: at(0.5) });
  });
});

describe('isAnimatedComponent and isReanimatedComponent', () => {
  it.each<[string, unknown, boolean, boolean]>([
    ['a function named Animated(…)', Object.assign(() => null, { displayName: 'Animated(View)' }), true, false],
    ['a forwardRef named Animated(…)', { render: { displayName: 'Animated(Text)' } }, true, false],
    ['a Reanimated component', Object.assign(() => null, { displayName: 'AnimatedComponent(View)' }), true, true],
    ['any other name', Object.assign(() => null, { displayName: 'View' }), false, false],
    ['no name', () => null, false, false],
    ['a non-string name', { displayName: 7 }, false, false],
    ['a host type', 'RCTView', false, false],
    ['no type', null, false, false],
  ])('%s', (_, type, animated, reanimated) => {
    expect(isAnimatedComponent({ type } as FiberLike)).toBe(animated);
    expect(isReanimatedComponent({ type } as FiberLike)).toBe(reanimated);
  });
});

const AnimatedView = Object.assign(() => null, { displayName: 'Animated(View)' });

/** The ancestry of a view under an `Animated.View` styled `style`, over a host rendered with `rendered`. */
function under(
  style: unknown,
  rendered: unknown = {},
  hostRect: WindowRect | null = rect(0, 0, 400, 400),
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

/** Where the first level moves SELF, or `undefined`. */
function moved(ancestry: ReturnType<typeof ancestryOfFiber>): WindowRect | undefined {
  return nativeMotion(ancestry)?.levels[0]?.move(SELF);
}

describe('nativeMotion', () => {
  it('nothing Animated above the view: nothing to do', () => {
    expect(nativeMotion(ancestryOfFiber(selfIn(root([view([self()])]))))).toBeNull();
  });

  it.each<[string, unknown]>([
    ['no style', undefined],
    ['a style without a transform', { opacity: value(1) }],
    ['a transform of plain numbers', { transform: [{ translateX: 10 }] }],
    ['a JS-driven transform', { transform: [{ translateX: { ...value(10), __isNative: false } }] }],
    ['a transform that is not a list', { transform: 'translateX(10px)' }],
  ])('an Animated component with %s moves nothing natively', (_, style) => {
    expect(nativeMotion(under(style))).toBeNull();
  });

  it('a node without the native flag at all is taken as native', () => {
    const node = value(5) as Partial<Value>;
    delete node.__isNative;

    expect(moved(under({ transform: [{ translateX: node }] }, { transform: [{ translateX: 0 }] }))).toEqual(
      rect(10, 100, 205, 50),
    );
  });

  it('joins where the view is with every place the value can take it, from either value in the shadow tree', () => {
    // Rendered at 10, now at 30: the shadow tree holds 10 (moved +20) or 30 (where measured).
    expect(moved(under({ transform: [{ translateX: value(30) }] }, { transform: [{ translateX: 10 }] }))).toEqual(
      rect(10, 100, 220, 50),
    );
  });

  it('without the rendered value, uses the current one alone', () => {
    expect(moved(under({ transform: [{ translateX: value(30, timing(30, 50)) }] }, {}))).toEqual(
      rect(10, 100, 220, 50),
    );
  });

  it('composes a translation after a scale, about the centre', () => {
    const ancestry = under(
      { transform: [{ translateY: value(0, timing(0, -20)) }, { scale: 2 }] },
      { transform: [{ translateY: 0 }, { scale: 2 }] },
    );

    // Measured at twice the size; its frame (half) carried back to twice, and up by up to 20.
    expect(moved(ancestry)).toEqual(rect(10, 80, 200, 70));
  });

  it('a node bounded but not readable now is measured from the rendered value alone', () => {
    const clamp = { __isNative: true, _a: value(0, null, 0, false), _min: 0, _max: 10, __getValue: () => Number.NaN };

    expect(moved(under({ transform: [{ translateX: clamp }] }, { transform: [{ translateX: 0 }] }))).toEqual(
      rect(10, 100, 210, 50),
    );
  });

  it('a static rotation of nothing alongside is fine; any other is unbounded', () => {
    expect(
      moved(under({ transform: [{ translateX: value(5) }, { rotate: '0deg' }] }, { transform: [{ translateX: 0 }] })),
    ).toEqual(rect(10, 100, 205, 50));
    expect(
      moved(under({ transform: [{ translateX: value(5) }, { rotate: '9deg' }] }, { transform: [{ translateX: 0 }] })),
    ).toBeUndefined();
  });

  it.each<[string, unknown, unknown]>([
    ['a translation it cannot bound', { transform: [{ translateX: value(0, null, 0, false) }] }, {}],
    ['an entry that is not an object', { transform: [{ translateX: value(1) }, null] }, {}],
    ['a scale to nothing in the shadow tree', { transform: [{ scale: value(0) }] }, { transform: [{ scale: 0 }] }],
  ])('%s is unbounded', (_, style, rendered) => {
    expect(moved(under(style, rendered))).toBeUndefined();
  });

  it('a host that cannot be measured is unbounded', () => {
    expect(moved(under({ transform: [{ scale: value(2) }] }, { transform: [{ scale: 1 }] }, null))).toBeUndefined();
  });

  it('reading the transform throws: unbounded', () => {
    const throwing = value(1);
    Object.defineProperty(throwing, '_animation', {
      get(): never {
        throw new Error('torn');
      },
    });

    expect(moved(under({ transform: [{ translateX: throwing }] }, { transform: [{ translateX: 0 }] }))).toBeUndefined();
  });

  it('a move that throws is unbounded', () => {
    renderer.getPublicInstanceFromInternalInstanceHandle = () => {
      throw new Error('gone');
    };

    expect(moved(under({ transform: [{ translateX: value(1) }] }, { transform: [{ translateX: 0 }] }))).toBeUndefined();
  });

  it('reports running animations and the native values to watch', () => {
    const still = value(1);
    const moving = value(0, timing(0, 5));
    const motion = nativeMotion(under({ transform: [{ translateX: still }, { translateY: moving }] }));

    expect(motion?.running).toBe(true);
    expect(motion?.roots).toEqual([still, moving]);
  });

  it('nested Animated components, nearest first; one right above the view transforms the view itself', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform: [{ translateY: value(100) }] } },
          children: [
            fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateY: 0 }] } }, [
              composite([
                {
                  tag: FiberTag.FunctionComponent,
                  type: AnimatedView,
                  memoizedProps: { style: { transform: [{ translateX: value(5) }] } },
                  children: [{ ...self(), memoizedProps: { style: { transform: [{ translateX: 0 }] } } }],
                },
              ]),
            ]),
          ],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);
    renderer.getPublicInstanceFromInternalInstanceHandle = (target) => ({
      measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) => {
        const at = (target.stateNode as { rect?: WindowRect } | null)?.rect ?? SELF;
        callback(at.x, at.y, at.width, at.height);
      },
    });
    const motion = nativeMotion(ancestry);

    expect(motion?.levels.map((level) => level.index)).toEqual(ancestry.animated);
    expect(throughMotion(SELF, ancestry, motion!).drawn).toEqual(rect(10, 100, 205, 150));
  });

  it('reads the stored path when the committed tree cannot be resolved', () => {
    const ancestry = under({ transform: [{ translateX: value(5) }] }, { transform: [{ translateX: 0 }] });
    ancestry.resolved = undefined;

    expect(moved(ancestry)).toEqual(rect(10, 100, 205, 50));
  });

  it('a Reanimated component with no animated transform is no level', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: Object.assign(() => null, { displayName: 'AnimatedComponent(View)' }),
          memoizedProps: { style: [{ viewDescriptors: {}, initial: { value: { opacity: 0 } } }] },
          children: [view([self()])],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(nativeMotion(ancestry)).toBeNull();
  });
});

describe('throughMotion', () => {
  it('an unbounded level draws the view anywhere: the whole surface, cut by the clippers above', () => {
    const wrapped = ancestryOfFiber(
      selfIn(
        root([
          scrollView(rect(0, 50, 400, 300), [
            {
              tag: FiberTag.FunctionComponent,
              type: AnimatedView,
              memoizedProps: { style: { transform: [{ rotate: value(1) }] } },
              children: [view([self()])],
            },
          ]),
        ]),
      ),
    );
    isHidden(wrapped);

    const { drawn, visible } = throughMotion(SELF, wrapped, nativeMotion(wrapped)!);
    expect(drawn).toEqual(WHOLE_SURFACE);
    expect(visible).toEqual(rect(0, 50, 400, 300));
  });

  it('a view cut away inside the transform is drawn nowhere, however it moves', () => {
    const ancestry = under(
      { transform: [{ translateY: value(0, timing(0, 300)) }] },
      { transform: [{ translateY: 0 }] },
      undefined,
      (spec) => scrollView(rect(0, 0, 400, 50), [spec]),
    );

    expect(throughMotion(SELF, ancestry, nativeMotion(ancestry)!).visible).toBeNull();
  });
});
