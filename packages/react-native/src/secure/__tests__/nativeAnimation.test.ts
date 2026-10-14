/**
 * `nativeAnimation.ts` bounds where native-driven transforms can draw a view,
 * from the `Animated` nodes in the props of the components that render its
 * ancestors. Every case it cannot bound must cover more, never less, and
 * never move a mask off the view.
 */
import { ancestryOfFiber, isAnimatedComponent, isHidden, isReanimatedComponent, measurePass } from '../ancestry';
import { followEventAttachments, nativeMotion, nodeBound, originOf, throughMotion } from '../nativeAnimation';
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

type Operation = 'add' | 'subtract' | 'multiply' | 'divide' | 'other';
const COMPUTE: Record<Operation, (x: number, y: number) => number> = {
  add: (x, y) => x + y,
  subtract: (x, y) => x - y,
  multiply: (x, y) => x * y,
  divide: (x, y) => x / y,
  other: (x, y) => Math.max(x, y) + 0.5,
};

/**
 * A stand-in for `Animated.add(a, b)` (or `operation`): React Native wraps a
 * number operand in a value, and computes the node's value from both.
 */
function binary(a: unknown, b: unknown, extra: Record<string, unknown> = {}, operation: Operation = 'add'): object {
  const operand = (x: unknown): { __getValue: () => unknown } =>
    (typeof x === 'number' ? value(x) : x) as { __getValue: () => unknown };
  const left = operand(a);
  const right = operand(b);
  return {
    __isNative: true,
    _a: left,
    _b: right,
    __getValue: () => COMPUTE[operation](left.__getValue() as number, right.__getValue() as number),
    ...extra,
  };
}

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

  it('N2: a still value seen animating before, with no listener, is unbounded where events are not followed', () => {
    // Its last animation's end is known; whether a native Animated.event drives it since is not.
    const node = value(0, timing(0, 10), 0, false);
    expect(nodeBound(node).running).toBe(true);

    node._animation = null;
    node._value = 10;
    expect(nodeBound(node).range).toBeUndefined();
  });

  describe('N2: native Animated.event attachments, followed', () => {
    /** React Native's `AnimatedEvent`, as far as attaching goes. */
    function eventClass(): {
      new (mapping: unknown[]): {
        _argMapping: unknown[];
        __attach: (...args: unknown[]) => unknown;
        __detach: (...args: unknown[]) => unknown;
      };
      attach: jest.Mock;
      detach: jest.Mock;
    } {
      const attach = jest.fn(() => 'attached');
      const detach = jest.fn(() => 'detached');
      class AnimatedEvent {
        static attach = attach;
        static detach = detach;
        constructor(readonly _argMapping: unknown[]) {}
        __attach(...args: unknown[]): unknown {
          return attach.apply(this, args as []);
        }
        __detach(...args: unknown[]): unknown {
          return detach.apply(this, args as []);
        }
      }
      return AnimatedEvent as never;
    }

    afterEach(() => {
      followEventAttachments(undefined);
    });

    const still = (): Value => value(0, null, 0, false);

    it('a still value no event drives is where it is, listened to or not', () => {
      expect(followEventAttachments(eventClass())).toBe(true);

      expect(nodeBound(still()).range).toEqual({ lo: 0, hi: 0 });
    });

    it('drag, spring back, drag again: unbounded throughout, until the event is detached', () => {
      const AnimatedEvent = eventClass();
      followEventAttachments(AnimatedEvent);
      const drag = still();
      // The gesture's Animated.event, attached as the Animated component mounts.
      const event = new AnimatedEvent([{ nativeEvent: { translationX: drag } }]);
      expect(event.__attach('view', 'onGestureEvent')).toBe('attached');
      expect(nodeBound(drag).range).toBeUndefined();

      // Released: a spring back, then still at its end, then dragged again.
      drag._animation = { _toValue: 0 };
      expect(nodeBound(drag).range).toBeUndefined();
      drag._animation = null;
      expect(nodeBound(drag).range).toBeUndefined();
      drag._animation = timing(0, 0);
      expect(nodeBound(drag)).toEqual({ range: undefined, running: true, roots: [drag] });
      drag._animation = null;
      expect(nodeBound(drag).range).toBeUndefined();

      expect(event.__detach('view', 'onGestureEvent')).toBe('detached');
      expect(nodeBound(drag).range).toEqual({ lo: 0, hi: 0 });
      // React Native's own methods ran, on the event, with what they were given.
      expect(AnimatedEvent.attach).toHaveBeenCalledWith('view', 'onGestureEvent');
      expect(AnimatedEvent.attach.mock.contexts[0]).toBe(event);
      expect(AnimatedEvent.detach).toHaveBeenCalledWith('view', 'onGestureEvent');
      expect(AnimatedEvent.detach.mock.contexts[0]).toBe(event);
    });

    it('finds every value of a mapping (an Animated.ValueXY\'s two), however nested, not too deep', () => {
      const AnimatedEvent = eventClass();
      followEventAttachments(AnimatedEvent);
      const [x, y, deep, tooDeep] = [still(), still(), still(), still()];
      const nest = (inner: unknown, levels: number): unknown =>
        levels === 0 ? inner : { a: nest(inner, levels - 1) };
      const nativeEvent = {
        offset: { x, y, __getValue: () => 0 },
        deep: nest(deep, 6),
        tooDeep: nest(tooDeep, 7),
        n: 1,
        none: null,
      };
      new AnimatedEvent([{ nativeEvent }]).__attach();

      expect([x, y, deep, tooDeep].map((node) => nodeBound(node).range)).toEqual([
        undefined,
        undefined,
        undefined,
        { lo: 0, hi: 0 },
      ]);
    });

    it('counts attachments: one detached leaves the value driven by the others', () => {
      const AnimatedEvent = eventClass();
      followEventAttachments(AnimatedEvent);
      const scroll = still();
      const first = new AnimatedEvent([{ nativeEvent: { y: scroll } }]);
      const second = new AnimatedEvent([{ nativeEvent: { y: scroll } }]);
      first.__attach();
      first.__attach();
      second.__attach();

      first.__detach();
      second.__detach();
      expect(nodeBound(scroll).range).toBeUndefined();
      first.__detach();
      expect(nodeBound(scroll).range).toEqual({ lo: 0, hi: 0 });
      // Another event on the value, detached more often than it was attached: the first still drives it.
      const other = new AnimatedEvent([{ nativeEvent: { y: scroll } }]);
      first.__attach();
      other.__attach();
      other.__detach();
      other.__detach();
      expect(nodeBound(scroll).range).toBeUndefined();
      first.__detach();
      // Detached more often than attached, or never attached, or with no mapping: nothing goes below none.
      first.__detach();
      new AnimatedEvent([{ nativeEvent: { y: scroll } }]).__detach();
      new AnimatedEvent(undefined as never).__attach();
      expect(nodeBound(scroll).range).toEqual({ lo: 0, hi: 0 });
    });

    it('loading, follows React Native\'s own AnimatedEvent; where it cannot be loaded, nothing', () => {
      const AnimatedEvent = eventClass();
      jest.isolateModules(() => {
        jest.doMock('react-native/Libraries/Animated/AnimatedEvent', () => ({ AnimatedEvent }));
        const isolated = require('../nativeAnimation') as { nodeBound: typeof nodeBound };
        const scroll = still();
        new AnimatedEvent([{ nativeEvent: { y: scroll } }]).__attach();

        expect(isolated.nodeBound(scroll).range).toBeUndefined();
        expect(isolated.nodeBound(still()).range).toEqual({ lo: 0, hi: 0 });
      });
      jest.isolateModules(() => {
        jest.doMock(
          'react-native/Libraries/Animated/AnimatedEvent',
          () => {
            throw new Error('moved');
          },
        );
        const isolated = require('../nativeAnimation') as { nodeBound: typeof nodeBound };

        expect(isolated.nodeBound(still()).range).toBeUndefined();
      });
    });

    it.each<[string, unknown]>([
      ['nothing', undefined],
      ['a class without attaching', class {}],
      ['a class that only attaches', class { __attach(): void {} }],
      ['a class that only detaches', class { __detach(): void {} }],
    ])('given %s, events are not followed: a still value is trusted only while listened to', (_, AnimatedEvent) => {
      followEventAttachments(eventClass());

      expect(followEventAttachments(AnimatedEvent)).toBe(false);
      expect(nodeBound(still()).range).toBeUndefined();
      expect(nodeBound(value(3)).range).toEqual({ lo: 3, hi: 3 });
    });
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

  it('add, subtract and multiply are each bounded by intervals over both operands', () => {
    const a = (): Value => value(1, timing(1, 2));

    expect(nodeBound(binary(a(), 3)).range).toEqual({ lo: 4, hi: 5 });
    expect(nodeBound(binary(a(), 3, {}, 'subtract')).range).toEqual({ lo: -2, hi: -1 });
    expect(nodeBound(binary(a(), 3, {}, 'multiply')).range).toEqual({ lo: 3, hi: 6 });
  });

  it('P3-a: a division that lost its own field is told by what it computes, and bounded as one', () => {
    // 4 / b, b from 2 down to 0.5 (now 2): 2..8, which add, subtract or multiply would bound at most at 8 - 0.5.
    const node = binary(value(4), value(2, timing(2, 0.5)), {}, 'divide');

    expect(nodeBound(node).range).toEqual({ lo: 2, hi: 8 });
  });

  it('P3-a: where several operations compute the same now, each is taken', () => {
    // x * 1 is x / 1 is x - 0... b is 1 now, from 1 to 0.5: x * b 1..4, x / b 2..8 (x 2..4).
    const node = binary(value(2, timing(2, 4)), value(1, timing(1, 0.5)), {}, 'multiply');

    expect(nodeBound(node).range).toEqual(expect.objectContaining({ lo: expect.any(Number), hi: 8 }));
  });

  it('P3-a: a binary node computing none of them is unbounded; one with a number operand too', () => {
    expect(nodeBound(binary(value(1), value(2), {}, 'other')).range).toBeUndefined();
    expect(nodeBound({ __isNative: true, _a: value(1), _b: 2, __getValue: () => 3 }).range).toBeUndefined();
    expect(nodeBound({ __isNative: true, _a: 1, _b: value(2), __getValue: () => 3 }).range).toBeUndefined();
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
    ['spaces around', '  left   top ', { x: at(0), y: at(0) }],
    ['a vertical keyword first', 'top 25%', { x: at(0.25), y: at(0) }],
    ['a horizontal keyword second', 'center left', { x: at(0), y: at(0.5) }],
    ['a right keyword second', '10px right', { x: at(1), y: at(0, 10) }],
    ['a length before its unit is all', 'x10px', undefined],
    ['a length with more after it', '10pxy', undefined],
    ['a fraction', '12.25%', { x: at(0.1225), y: at(0.5) }],
    ['a fraction with no digits after the point', '1.x', undefined],
    ['a plain number in a string', '10 20', { x: at(0, 10), y: at(0, 20) }],
    ['an unknown second word', 'left blah', undefined],
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
    ['a transform that is not a list', { transform: 'translateX(10px)' }],
  ])('an Animated component with %s moves nothing natively', (_, style) => {
    expect(nativeMotion(under(style))).toBeNull();
  });

  it('N1: a transform of values not native yet moves nothing, and its values are watched', () => {
    // The first animation with the native driver makes them native, and commits nothing.
    const node = { ...value(10), __isNative: false };
    const interpolatedNode = { ...interpolated(node, {}, linear), __isNative: false };

    expect(nativeMotion(under({ transform: [{ translateX: node }, { translateY: interpolatedNode }] }))).toEqual({
      levels: [],
      running: false,
      roots: [node, node],
    });
  });

  it('N1: nodes not native yet with nothing to watch keep the view measured every frame', () => {
    const unknown = { __isNative: false, __getValue: () => 0 };

    expect(nativeMotion(under({ transform: [{ translateX: unknown }] }))).toEqual({
      levels: [],
      running: true,
      roots: [],
    });
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

  it('P3-c: a function that comes twice takes the rendered value of its own place', () => {
    const transform = [{ translateX: value(10) }, { translateX: value(0, timing(0, 50)) }];

    expect(moved(under({ transform }, { transform: [{ translateX: 10 }, { translateX: 0 }] }))).toEqual(
      rect(10, 100, 250, 50),
    );
    // Rendered with other functions in its places: only the value it holds now is a base.
    expect(moved(under({ transform }, { transform: [{ translateY: 40 }, { translateX: 0 }] }))).toEqual(
      rect(10, 100, 250, 50),
    );
  });

  it('P3-b: inside a Reanimated level (unbounded anyway), an inner level keeps its own bound', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: Object.assign(() => null, { displayName: 'AnimatedComponent(View)' }),
          memoizedProps: { style: { transitionProperty: 'transform' } },
          children: [
            {
              tag: FiberTag.FunctionComponent,
              type: AnimatedView,
              memoizedProps: { style: { transform: [{ translateX: value(0, timing(0, 50)) }] } },
              children: [
                fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateX: 0 }] } }, [
                  view([self()]),
                ]),
              ],
            },
          ],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(moved(ancestry)).toEqual(rect(10, 100, 250, 50));
  });

  it('N1: one native node among nodes not native yet is a level', () => {
    const transform = [{ translateX: { ...value(0), __isNative: false } }, { translateY: value(0, timing(0, 20)) }];

    expect(moved(under({ transform }, { transform: [{ translateX: 0 }, { translateY: 0 }] }))).toEqual(
      rect(10, 100, 200, 70),
    );
  });

  /**
   * A view under an inner `Animated.View` translated by `inner`, inside one
   * scaled by `scale` (after a still translation, with `lifted`), rendered at `at`.
   */
  function scaledOuter(scale: unknown, at: number, inner: unknown, lifted = false): ReturnType<typeof ancestryOfFiber> {
    const lift = lifted ? [{ translateY: value(0) }] : [];
    const liftRendered = lifted ? [{ translateY: 0 }] : [];
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform: [...lift, { scale }] } },
          children: [
            fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [...liftRendered, { scale: at }] } }, [
              {
                tag: FiberTag.FunctionComponent,
                type: AnimatedView,
                memoizedProps: { style: { transform: [{ translateX: inner }] } },
                children: [
                  fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateX: 0 }] } }, [
                    view([self()]),
                  ]),
                ],
              },
            ]),
          ],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);
    return ancestry;
  }

  it('P3-b: inside a level the shadow tree scales up, an inner level is unbounded; scaled down, bounded', () => {
    const slide = (): Value => value(0, timing(0, 50));

    expect(moved(scaledOuter(value(2), 2, slide()))).toBeUndefined();
    expect(moved(scaledOuter(value(-1.5), -1.5, slide()))).toBeUndefined();
    // Not rendered with a scale: the one its value holds now is enough.
    expect(moved(scaledOuter(value(2), undefined as never, slide()))).toBeUndefined();
    expect(moved(scaledOuter(value(0.5), 0.5, slide()))).toEqual(rect(10, 100, 250, 50));
    expect(moved(scaledOuter(value(1), 1, slide()))).toEqual(rect(10, 100, 250, 50));
    // Scaled up after a translation: still scaled.
    expect(moved(scaledOuter(value(2), 2, slide(), true))).toBeUndefined();
    // The outer level itself is bounded either way.
    expect(nativeMotion(scaledOuter(value(2), 2, slide()))?.levels[1]?.move(SELF)).toBeDefined();
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

describe('mutation-tight bounds', () => {
  it('UNBOUNDED is exactly that: no range, not running, no roots', () => {
    expect(nodeBound('7')).toEqual({ range: undefined, running: false, roots: [] });
    expect(nodeBound({})).toEqual({ range: undefined, running: false, roots: [] });
  });

  it('a value missing one field it reads, the app listening, is still unbounded, with no roots', () => {
    const noValue = { __isNative: true, _offset: 0, _animation: null, __getValue: () => 0, hasListeners: () => true };
    const noOffset = { __isNative: true, _value: 0, _animation: null, __getValue: () => 0, hasListeners: () => true };

    expect(nodeBound(noValue)).toEqual({ range: undefined, running: false, roots: [] });
    expect(nodeBound(noOffset)).toEqual({ range: undefined, running: false, roots: [] });
  });

  it('a non-finite value keeps itself as a root to watch', () => {
    const node = value(Number.NaN);

    expect(nodeBound(node)).toEqual({ range: undefined, running: false, roots: [node] });
  });

  it('a value with no hasListeners at all, never seen animating, is unbounded', () => {
    const node = value(1, null, 0, false) as Partial<Value>;
    delete node.hasListeners;

    expect(nodeBound(node).range).toBeUndefined();
  });

  it('a spring keeps itself as a root; one with no easing too', () => {
    const spring = value(0, { _toValue: 1, _easing: linear });
    const nan = value(0, timing(0, 1, () => Number.NaN));

    expect(nodeBound(spring).roots).toEqual([spring]);
    expect(nodeBound(nan).roots).toEqual([nan]);
  });

  it('a value now outside its running animation\'s path is covered where it is too', () => {
    expect(nodeBound(value(50, timing(0, 10))).range).toEqual({ lo: 0, hi: 50 });
  });

  it('an easing that turns back is widened by a tenth of its span on each side', () => {
    // 0 -> 100 -> 50 over the animation: hull 0..100, which does not end at an end.
    const turn = (t: number): number => (t <= 0.5 ? 2 * t : 1.5 - t);

    expect(nodeBound(value(0, timing(0, 100, turn))).range).toEqual({ lo: -10, hi: 110 });
  });

  it('the widening is a tenth of the span, away from zero too', () => {
    const turn = (t: number): number => (t <= 0.5 ? 2 * t : 1.5 - t);

    expect(nodeBound(value(50, timing(50, 150, turn))).range).toEqual({ lo: 40, hi: 160 });
  });

  it('breakpoints outside what the input can take are not sampled', () => {
    const map = (x: number): number => (x < 0 || x > 1 ? 1000 : x);
    const node = interpolated(value(0, timing(0, 1)), { inputRange: [-5, 0, 0.5, 1, 5] }, map);

    expect(nodeBound(node).range).toEqual({ lo: 0, hi: 1 });
  });

  it('clamped with no outputs at all is not bounded by them', () => {
    const node = interpolated(value(0, null, 0, false), { outputRange: [], extrapolate: 'clamp' }, linear);

    expect(nodeBound(node).range).toBeUndefined();
  });

  it('a division by a range that stays below zero is bounded', () => {
    const node = binary(value(4), value(-2, timing(-2, -1)), { _warnedAboutDivideByZero: false });

    expect(nodeBound(node).range).toEqual({ lo: -4, hi: -2 });
  });

  it('a division by zero keeps both operands as roots', () => {
    const a = value(4);
    const b = value(0, timing(-1, 1));

    expect(nodeBound(binary(a, b, { _warnedAboutDivideByZero: false }))).toEqual({
      range: undefined,
      running: true,
      roots: [a, b],
    });
  });

  it('a spike at a breakpoint between samples is found, and widened', () => {
    const spike = (x: number): number => (x === 0.33 ? 100 : 0);
    const node = interpolated(value(0, timing(0, 1)), { inputRange: [0, 0.32, 0.33, 0.34, 1] }, spike);

    expect(nodeBound(node).range).toEqual({ lo: -10, hi: 110 });
  });

  it('a monotonic interpolation with breakpoints is not widened (samples in order)', () => {
    const node = interpolated(value(0, timing(0, 1)), { inputRange: [0, 0.5, 1] }, (x: number) => 100 * x);

    expect(nodeBound(node).range).toEqual({ lo: 0, hi: 100 });
  });

  it('clamped on the right only is not clamped', () => {
    const node = interpolated(value(0, null, 0, false), { outputRange: [0, 1], extrapolateRight: 'clamp' }, linear);

    expect(nodeBound(node).range).toBeUndefined();
  });

  it('clamped with an output that is not a number is not bounded by its outputs', () => {
    const node = interpolated(value(0, null, 0, false), { outputRange: [0, '1'], extrapolate: 'clamp' }, linear);

    expect(nodeBound(node).range).toBeUndefined();
  });

  it('a bounded input with no interpolation function is unbounded, without throwing', () => {
    expect(nodeBound(interpolated(value(0, timing(0, 1)), {}, undefined)).range).toBeUndefined();
  });

  it('an interpolation answering NaN for some inputs only is unbounded', () => {
    const partly = (x: number): number => (x > 0.5 ? Number.NaN : x);

    expect(nodeBound(interpolated(value(0, timing(0, 1)), {}, partly)).range).toBeUndefined();
  });

  it('add, subtract and multiply: the hull of every corner', () => {
    // a 2..4, b -0.5..1 (now -0.5, where no two of them agree).
    const a = (): Value => value(2, timing(2, 4));
    const b = (): Value => value(-0.5, timing(-0.5, 1));

    expect(nodeBound(binary(a(), b())).range).toEqual({ lo: 1.5, hi: 5 });
    expect(nodeBound(binary(a(), b(), {}, 'subtract')).range).toEqual({ lo: 1, hi: 4.5 });
    expect(nodeBound(binary(a(), b(), {}, 'multiply')).range).toEqual({ lo: -2, hi: 4 });
  });

  it('a division by a range touching zero at either end is unbounded; an unbounded divisor too', () => {
    const division = { _warnedAboutDivideByZero: false };

    expect(nodeBound(binary(value(4), value(0, timing(0, 1)), division)).range).toBeUndefined();
    expect(nodeBound(binary(value(4), value(-1, timing(-1, 0)), division)).range).toBeUndefined();
    expect(nodeBound(binary(value(4), value(4, null, 0, false), division)).range).toBeUndefined();
  });

  it('a binary node with an unbounded operand keeps both operands\' roots', () => {
    const a = value(1, null, 0, false);
    const b = value(2);

    expect(nodeBound(binary(a, b))).toEqual({ range: undefined, running: false, roots: [a, b] });
  });
});

const TX0 = [{ translateX: 0 }];
const TY0 = [{ translateY: 0 }];

describe('transform geometry', () => {
  /** The view (rect SELF) under an Animated host at `host`, with `extra` style on both. */
  function scaled(
    transform: unknown[],
    rendered: unknown[],
    host: WindowRect,
    extra: Record<string, unknown> = {},
  ): WindowRect | undefined {
    return moved(under({ transform, ...extra }, { transform: rendered, ...extra }, host));
  }

  it('scaleX and scaleY each scale their own axis, about a host that is not square', () => {
    // Host 0,0 400x800: centre 200,400.
    expect(scaled([{ scaleX: value(2) }], [{ scaleX: 1 }], rect(0, 0, 400, 800))).toEqual(rect(-180, 100, 400, 50));
    expect(scaled([{ scaleY: value(2) }], [{ scaleY: 1 }], rect(0, 0, 400, 800))).toEqual(rect(10, -200, 200, 350));
  });

  it('a scale inside a translation scales the translation too', () => {
    // Rendered: scale 2 after translateY 0; now translateY 10 inside: drawn 2 x 10 lower.
    expect(
      scaled([{ scale: 2 }, { translateY: value(10) }], [{ scale: 2 }, { translateY: 0 }], rect(0, 0, 400, 800)),
    ).toEqual(rect(10, 100, 200, 70));
  });

  it('an origin set in lengths, with a translation, pivots where the host is', () => {
    // Origin 10px,20px of a host laid out at 100,100 (drawn 50 to the right by translateX): pivot 110,120.
    const at = scaled(
      [{ translateX: 50 }, { scale: value(2) }],
      [{ translateX: 50 }, { scale: 1 }],
      rect(150, 100, 200, 200),
      { transformOrigin: '10px 20px' },
    );

    expect(at).toEqual(rect(-140, 80, 400, 100));
  });

  it('a rendered value missing for one step goes back from the current values alone', () => {
    expect(
      scaled([{ translateX: value(30) }, { translateY: value(5) }], [{ translateX: 10 }], rect(0, 0, 400, 800)),
    ).toEqual(rect(10, 100, 200, 50));
  });

  it.each(['rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY'])('%s of 0deg does nothing', (name) => {
    expect(
      moved(under({ transform: [{ translateX: value(5) }, { [name]: '0deg' }] }, { transform: [{ translateX: 0 }] })),
    ).toEqual(rect(10, 100, 205, 50));
  });

  it('an Animated component whose host is right below it, at the bottom of the path', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform: [{ translateX: value(5) }] } },
          children: [fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: TX0 } }, [self()])],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(moved(ancestry)).toEqual(rect(10, 100, 205, 50));
  });

  it('an Animated component with a composite between it and its host finds the host', () => {
    expect(
      moved(
        under({ transform: [{ scale: value(2) }] }, { transform: [{ scale: 1 }] }, rect(0, 0, 400, 400), (spec) =>
          composite([spec]),
        ),
      ),
    ).toEqual(rect(-180, 0, 400, 150));
  });

  it('an origin from the host the Animated component renders, not one above it', () => {
    const fiber = selfIn(
      root([
        fabricHost('RCTView', rect(0, 0, 400, 800), {}, [
          {
            tag: FiberTag.FunctionComponent,
            type: AnimatedView,
            memoizedProps: { style: { transform: [{ scale: value(2) }] } },
            children: [fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ scale: 1 }] } }, [self()])],
          },
        ]),
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(moved(ancestry)).toEqual(rect(-180, 0, 400, 150));
  });

  it('a translation inside a scale goes back with the scaled translation: the view where it is', () => {
    // Rendered and now the same: nothing moves.
    expect(
      scaled([{ scale: 2 }, { translateY: value(10) }], [{ scale: 2 }, { translateY: 10 }], rect(0, 0, 400, 800)),
    ).toEqual(SELF);
  });

  it('an Animated component with no props moves nothing', () => {
    const ancestry = under(undefined);
    (ancestry.path[ancestry.animated[0] as number] as FiberLike).memoizedProps = null;
    ancestry.resolved = undefined;

    expect(nativeMotion(ancestry)).toBeNull();
  });

  it('an object in a transform that is not a node is not native', () => {
    expect(nativeMotion(under({ transform: [{ translateX: { value: 1 } }] }))).toBeNull();
  });

  it('a level that cannot be read reports nothing running and nothing to watch', () => {
    const throwing = value(1);
    Object.defineProperty(throwing, '_animation', {
      get(): never {
        throw new Error('torn');
      },
    });
    const motion = nativeMotion(under({ transform: [{ translateX: throwing }] }, { transform: [{ translateX: 0 }] }));

    expect(motion).toEqual(expect.objectContaining({ running: false, roots: [] }));
  });

  /** The ancestry of a view under a Reanimated component styled `style`. */
  function underReanimated(style: unknown): ReturnType<typeof ancestryOfFiber> {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: Object.assign(() => null, { displayName: 'AnimatedComponent(View)' }),
          memoizedProps: { style },
          children: [view([self()])],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);
    return ancestry;
  }

  it.each<[string, unknown]>([
    ['a CSS transition (Reanimated 4)', { opacity: 1, transitionProperty: 'transform', transitionDuration: 300 }],
    ['a CSS animation (Reanimated 4)', [{ animationName: { from: {}, to: {} } }]],
    ['a shared value set inline', { opacity: { value: 1, _isReanimatedSharedValue: true } }],
    ['a shared value (by its modify) set inline', { opacity: { value: 1, modify: () => undefined } }],
    ['a shared value in its transform', { transform: [{ translateX: { value: 0, modify: () => undefined } }] }],
  ])('P3-d: %s moves the view: the whole surface', (_, style) => {
    const motion = nativeMotion(underReanimated(style));

    expect(motion?.levels).toHaveLength(1);
    expect(motion?.levels[0]?.move(SELF)).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['plain values', { opacity: 1, backgroundColor: null, transform: [{ translateX: 3 }, 'x', null] }],
    ['a transform that is not a list', { transform: 'none', modify: 1 }],
    ['an object that is not a shared value', { shadowOffset: { width: 1, height: 1 } }],
    ['a function with a modify', { opacity: Object.assign(() => 1, { modify: () => undefined }) }],
    ['a value marked shared with false', { opacity: { value: 1, _isReanimatedSharedValue: false, modify: 1 } }],
  ])('P3-d: a Reanimated component with %s moves nothing', (_, style) => {
    expect(nativeMotion(underReanimated(style))).toBeNull();
  });

  it('a Reanimated style list with a number (a registered style) in it moves nothing', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: Object.assign(() => null, { displayName: 'AnimatedComponent(View)' }),
          memoizedProps: { style: [7, { viewDescriptors: {}, initial: { value: {} } }] },
          children: [view([self()])],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(nativeMotion(ancestry)).toBeNull();
  });

  it('a Reanimated component with no props moves nothing', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: Object.assign(() => null, { displayName: 'AnimatedComponent(View)' }),
          children: [view([self()])],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    (ancestry.path[ancestry.animated[0] as number] as FiberLike).memoizedProps = null;
    isHidden(ancestry);

    expect(nativeMotion(ancestry)).toBeNull();
  });
});

describe('throughMotion, clippers', () => {
  it('a clipper above is applied after the move: a view moved into it is seen there', () => {
    const fiber = selfIn(
      root([
        scrollView(rect(0, 0, 400, 150), [
          {
            tag: FiberTag.FunctionComponent,
            type: AnimatedView,
            memoizedProps: { style: { transform: [{ translateY: value(0, timing(0, -100)) }] } },
            children: [fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: TY0 } }, [self()])],
          },
        ]),
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);
    const low = rect(10, 200, 200, 50);

    expect(throughMotion(low, ancestry, nativeMotion(ancestry)!).visible).toEqual(rect(10, 100, 200, 50));
  });

  it('a clipper right above the view, inside the transform, is applied before the move', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform: [{ translateY: value(0, timing(0, 300)) }] } },
          children: [
            fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateY: 0 }] } }, [
              scrollView(rect(0, 0, 400, 130), [self()]),
            ]),
          ],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(throughMotion(SELF, ancestry, nativeMotion(ancestry)!).visible).toEqual(rect(10, 100, 200, 330));
  });

  it('cut away inside a nested transform, nothing is seen whatever the outer one does', () => {
    const fiber = selfIn(
      root([
        {
          tag: FiberTag.FunctionComponent,
          type: AnimatedView,
          memoizedProps: { style: { transform: [{ translateY: value(0, timing(0, 300)) }] } },
          children: [
            fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateY: 0 }] } }, [
              {
                tag: FiberTag.FunctionComponent,
                type: AnimatedView,
                memoizedProps: { style: { transform: [{ translateX: value(0, timing(0, 5)) }] } },
                children: [
                  fabricHost('RCTView', rect(0, 0, 400, 400), { style: { transform: [{ translateX: 0 }] } }, [
                    scrollView(rect(0, 0, 400, 50), [self()]),
                  ]),
                ],
              },
            ]),
          ],
        },
      ]),
    );
    const ancestry = ancestryOfFiber(fiber);
    isHidden(ancestry);

    expect(throughMotion(SELF, ancestry, nativeMotion(ancestry)!).visible).toBeNull();
  });
});
