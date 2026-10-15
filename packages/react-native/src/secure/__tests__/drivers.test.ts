/**
 * `drivers.ts` follows what drives native `Animated` values: the events
 * attached to them (through `AnimatedEvent` or `attachNativeEvent` directly)
 * and their being made native. Anything it cannot follow is trusted for
 * nothing.
 */
import { eventsOn, followDrivers, forgetDrivers, isNode, knownDriven, noteAnimating, whenMoved } from '../drivers';
import type { DriverSources } from '../drivers';

/** Fresh stand-ins for React Native's four sources, unpatched. */
function sources(): DriverSources & {
  eventClass: new (mapping: unknown) => {
    __attach: (...args: unknown[]) => unknown;
    __detach: (...args: unknown[]) => unknown;
  };
  implementation: { attachNativeEvent: jest.Mock };
  exported: { attachNativeEvent: jest.Mock };
  valueClass: new () => {
    _value: number;
    _animation: unknown;
    __isNative: boolean;
    __makeNative: () => void;
    __getValue: () => number;
    animate: (animation: unknown) => string;
    setValue: (to: number) => void;
    resetAnimation: () => void;
    setOffset: () => void;
    flattenOffset: () => void;
    extractOffset: () => void;
  };
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  class AnimatedEvent {
    constructor(readonly _argMapping: unknown) {}
    __attach(...args: unknown[]): unknown {
      calls.push(['attach', this, ...args]);
      return 'attached';
    }
    __detach(...args: unknown[]): unknown {
      calls.push(['detach', this, ...args]);
      return 'detached';
    }
  }
  class AnimatedValue {
    _value = 0;
    _animation: unknown = null;
    __isNative = false;
    __getValue(): number {
      return this._value;
    }
    animate(animation: unknown): string {
      calls.push(['animate', this, animation]);
      this._animation = animation;
      return 'animating';
    }
    setValue(to: number): void {
      calls.push(['setValue', this, to]);
      this._value = to;
    }
    resetAnimation(): void {
      calls.push(['resetAnimation', this]);
      this._value = 0;
    }
    setOffset(): void {
      calls.push(['setOffset', this]);
    }
    flattenOffset(): void {
      calls.push(['flattenOffset', this]);
    }
    extractOffset(): void {
      calls.push(['extractOffset', this]);
    }
    __makeNative(): void {
      calls.push(['makeNative', this]);
      this.__isNative = true;
    }
  }
  const handle = (): { detach: jest.Mock } => ({ detach: jest.fn(() => 'detached') });
  const attachNativeEvent = jest.fn(handle);
  return {
    eventClass: AnimatedEvent,
    implementation: { attachNativeEvent },
    exported: { attachNativeEvent },
    valueClass: AnimatedValue,
    calls,
  };
}

/** An `Animated.Value` stand-in. */
const value = (): object => ({ _value: 0, __getValue: () => 0 });

afterEach(() => {
  forgetDrivers();
});

describe('followDrivers', () => {
  it('follows events attached through an Animated component\'s props, until detached, per attachment', () => {
    const rn = sources();
    expect(followDrivers(rn)).toBe(true);
    const [x, y] = [value(), value()];
    const event = new rn.eventClass([{ nativeEvent: { contentOffset: { x, y } } }]);

    expect(event.__attach('scroller', 'onScroll')).toBe('attached');
    expect(eventsOn(x)).toEqual([
      { value: x, view: 'scroller', event: 'onScroll', path: ['nativeEvent', 'contentOffset', 'x'] },
    ]);
    event.__attach('scroller', 'onScroll');
    expect(eventsOn(y)).toHaveLength(2);
    expect(event.__detach('scroller', 'onScroll')).toBe('detached');
    expect(eventsOn(y)).toHaveLength(1);
    event.__detach('scroller', 'onScroll');
    expect(eventsOn(y)).toEqual([]);
    // React Native's own methods ran, on the event, with what they were given.
    expect(rn.calls.map(([name, self, ...args]) => [name, self === event, ...args])).toEqual([
      ['attach', true, 'scroller', 'onScroll'],
      ['attach', true, 'scroller', 'onScroll'],
      ['detach', true, 'scroller', 'onScroll'],
      ['detach', true, 'scroller', 'onScroll'],
    ]);
  });

  it('finds an Animated.ValueXY\'s two values, however nested, not too deep; never counts below none', () => {
    const rn = sources();
    followDrivers(rn);
    const [x, y, deep, tooDeep, other] = [value(), value(), value(), value(), value()];
    const nest = (inner: unknown, levels: number): unknown => (levels === 0 ? inner : { a: nest(inner, levels - 1) });
    const xy = { x, y, __getValue: () => ({ x: 0, y: 0 }) };
    const nativeEvent = { offset: xy, deep: nest(deep, 6), tooDeep: nest(tooDeep, 7), n: 1, none: null };
    new rn.eventClass([{ nativeEvent }]).__attach();

    expect([x, y, deep, tooDeep].map((node) => eventsOn(node)?.length)).toEqual([1, 1, 1, 0]);
    expect(eventsOn(x)?.[0]?.path).toEqual(['nativeEvent', 'offset', 'x']);
    expect(eventsOn(y)?.[0]?.path).toEqual(['nativeEvent', 'offset', 'y']);
    // Detached more often than attached, or never attached, or with no mapping: nothing goes below none.
    const twice = new rn.eventClass([{ nativeEvent: { y: other } }]);
    twice.__detach();
    new rn.eventClass(undefined).__attach();
    expect(eventsOn(other)).toEqual([]);
  });

  it('R3-1: follows attachNativeEvent on AnimatedImplementation (RN\'s ScrollView), until detached once', () => {
    const rn = sources();
    followDrivers(rn);
    const scrollY = value();
    const mapping = [{ nativeEvent: { contentOffset: { y: scrollY } } }];

    const handle = rn.implementation.attachNativeEvent('host', 'onScroll', mapping) as { detach: () => unknown };

    expect(eventsOn(scrollY)).toEqual([
      { value: scrollY, view: 'host', event: 'onScroll', path: ['nativeEvent', 'contentOffset', 'y'] },
    ]);
    // A second attachment, then the first detached twice: the second still drives it.
    const second = rn.implementation.attachNativeEvent('host', 'onScroll', mapping) as { detach: () => unknown };
    expect(handle.detach()).toBe('detached');
    handle.detach();
    expect(eventsOn(scrollY)).toHaveLength(1);
    second.detach();
    expect(eventsOn(scrollY)).toEqual([]);
  });

  it('follows the public Animated object too; one that holds the wrapper already is not wrapped again', () => {
    const rn = sources();
    const original = rn.exported.attachNativeEvent;
    followDrivers(rn);
    const scrollY = value();

    rn.exported.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: scrollY } }]);
    expect(eventsOn(scrollY)).toHaveLength(1);
    expect(original).toHaveBeenCalledTimes(1);

    // `Animated` spread from AnimatedImplementation after it was wrapped: the same wrapper, counted once.
    const spread = { ...rn.implementation };
    followDrivers({ ...rn, exported: spread });
    spread.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: scrollY } }]);
    expect(eventsOn(scrollY)).toHaveLength(2);
  });

  it('P3-2: wraps once; a second copy (Fast Refresh) shares what the first counted', () => {
    const rn = sources();
    followDrivers(rn);
    const attach = (rn.eventClass.prototype as { __attach: unknown }).__attach;
    const scrollY = value();
    new rn.eventClass([{ nativeEvent: { y: scrollY } }]).__attach();

    // The module evaluated again: its state starts empty, and it follows the same objects.
    forgetDrivers();
    expect(followDrivers(rn)).toBe(true);

    expect((rn.eventClass.prototype as { __attach: unknown }).__attach).toBe(attach);
    expect(eventsOn(scrollY)).toHaveLength(1);
    // Made native once, woken once: not wrapped twice.
    const node = new rn.valueClass();
    const woken = jest.fn();
    whenMoved(node, woken);
    node.__makeNative();
    expect(woken).toHaveBeenCalledTimes(1);
    rn.implementation.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: scrollY } }]);
    expect(eventsOn(scrollY)).toHaveLength(2);
    // Not enumerable: spreading the object copies no state.
    expect(Object.getOwnPropertySymbols({ ...rn.implementation })).toEqual([]);
  });

  it('a second React Native copy\'s AnimatedEvent joins what the rest already follow', () => {
    const rn = sources();
    followDrivers(rn);
    const scrollY = value();
    rn.implementation.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: scrollY } }]);

    followDrivers({ ...rn, eventClass: sources().eventClass });

    expect(eventsOn(scrollY)).toHaveLength(1);
  });

  it('a function an app set over the wrapper (calling it) is not wrapped again: each attachment counted once', () => {
    const rn = sources();
    followDrivers(rn);
    const ours = rn.implementation.attachNativeEvent;
    rn.implementation.attachNativeEvent = jest.fn((...args: unknown[]) => ours(...args));
    const scrollY = value();

    followDrivers(rn);
    rn.implementation.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: scrollY } }]);

    expect(eventsOn(scrollY)).toHaveLength(1);
  });

  it('forgotten (a test resetting it), nothing is followed', () => {
    followDrivers(sources());
    forgetDrivers();

    expect(eventsOn(value())).toBeUndefined();
    expect(() => noteAnimating(value())).not.toThrow();
    expect(knownDriven(value())).toBe(false);
  });

  it('P3-2: a mapping that cannot be read still attaches, and then no value is trusted', () => {
    const rn = sources();
    followDrivers(rn);
    const throwing = {
      get nativeEvent(): unknown {
        throw new Error('getter');
      },
    };

    expect(new rn.eventClass([throwing]).__attach('view', 'onScroll')).toBe('attached');
    expect(eventsOn(value())).toBeUndefined();
  });

  it('a mapping attachNativeEvent cannot read, or a handle it cannot wrap: still attached, never trusted', () => {
    const rn = sources();
    const original = rn.implementation.attachNativeEvent;
    followDrivers(rn);
    const scrollY = value();
    original.mockReturnValueOnce(Object.freeze({ detach: () => 'frozen' }));

    const frozen = rn.implementation.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: scrollY } }]);
    expect(frozen.detach()).toBe('frozen');
    expect(eventsOn(scrollY)).toHaveLength(1);
    original.mockReturnValueOnce(null);
    expect(rn.implementation.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: scrollY } }])).toBeNull();
    expect(eventsOn(scrollY)).toHaveLength(2);

    rn.implementation.attachNativeEvent('host', 'onScroll', null);
    expect(eventsOn(scrollY)).toHaveLength(2);
    rn.implementation.attachNativeEvent('host', 'onScroll', {
      get 0(): unknown {
        throw new Error('getter');
      },
    });
    expect(eventsOn(scrollY)).toBeUndefined();
  });

  it.each<[string, (rn: ReturnType<typeof sources>) => DriverSources]>([
    ['no AnimatedEvent', (rn) => ({ ...rn, eventClass: undefined })],
    ['an AnimatedEvent that does not detach', (rn) => ({ ...rn, eventClass: class { __attach(): void {} } })],
    ['no AnimatedImplementation.attachNativeEvent', (rn) => ({ ...rn, implementation: {} })],
    ['no AnimatedValue', (rn) => ({ ...rn, valueClass: null })],
    ['an AnimatedValue that is never made native', (rn) => ({ ...rn, valueClass: class {} })],
  ])('with %s, nothing is followed and nothing trusted', (_, from) => {
    const rn = sources();
    followDrivers(rn);

    expect(followDrivers(from(rn))).toBe(false);
    expect(eventsOn(value())).toBeUndefined();
    expect(knownDriven(new rn.valueClass())).toBe(false);
    expect(whenMoved(value(), () => undefined)).toBeUndefined();
  });

  it('without the public Animated object, the rest is still followed', () => {
    expect(followDrivers({ ...sources(), exported: undefined })).toBe(true);
  });
});

describe('what a value is driven by', () => {
  it('made native while followed: known, until an event is attached; then unknown, until seen animating', () => {
    const rn = sources();
    followDrivers(rn);
    const node = new rn.valueClass();
    expect(knownDriven(node)).toBe(false);

    node.__makeNative();
    expect(knownDriven(node)).toBe(true);
    const event = new rn.eventClass([{ nativeEvent: { y: node } }]);
    event.__attach();
    expect(knownDriven(node)).toBe(false);
    event.__detach();
    expect(knownDriven(node)).toBe(false);
    noteAnimating(node);
    expect(knownDriven(node)).toBe(true);
  });

  it('made native before it was followed: not known', () => {
    const rn = sources();
    const early = new rn.valueClass();
    early.__makeNative();
    followDrivers(rn);
    // Made native again (another animation): it already was, so what drove it before is still not known.
    early.__makeNative();

    expect(knownDriven(early)).toBe(false);
  });

  it('B6, N1: wakes a watcher at once as JS moves its value, after React Native did, once a move', () => {
    const rn = sources();
    followDrivers(rn);
    const node = new rn.valueClass();
    const seen: unknown[] = [];
    whenMoved(node, () => seen.push([node._value, node._animation]));

    expect(node.animate('timing')).toBe('animating');
    node.setValue(5);
    node.resetAnimation();
    node.setOffset();
    node.flattenOffset();
    node.extractOffset();

    // Each woke it once, with what React Native's own method had just done.
    expect(seen).toEqual([[0, 'timing'], [5, 'timing'], [0, 'timing'], [0, 'timing'], [0, 'timing'], [0, 'timing']]);
    expect(rn.calls.map(([name]) => name)).toEqual([
      'animate',
      'setValue',
      'resetAnimation',
      'setOffset',
      'flattenOffset',
      'extractOffset',
    ]);
    // Set from JS: known from then on, as long as no event is attached.
    expect(knownDriven(node)).toBe(true);
  });

  it('a value no one watches is moved with nothing to wake', () => {
    const rn = sources();
    followDrivers(rn);

    expect(() => new rn.valueClass().animate('timing')).not.toThrow();
  });

  it('P3-1: woken as React Native makes a value native inside an attach, a view is woken again once counted', () => {
    const rn = sources();
    const original = rn.implementation.attachNativeEvent;
    // React Native's attachNativeEventImpl makes the mapped values native before it returns.
    type Mapping = Array<{ nativeEvent: { y: { __makeNative: () => void } } }>;
    original.mockImplementation((_view: unknown, _event: unknown, mapping: Mapping) => {
      mapping[0]?.nativeEvent.y.__makeNative();
      return { detach: jest.fn() };
    });
    followDrivers(rn);
    const node = new rn.valueClass();
    const seen: unknown[] = [];
    whenMoved(node, () => seen.push(eventsOn(node)?.length));

    rn.implementation.attachNativeEvent('host', 'onScroll', [{ nativeEvent: { y: node } }]);

    // Inside the attach, not counted yet; then counted, and woken again.
    expect(seen).toEqual([0, 1]);
  });

  it('P3-2: a value JS set while an event was attached is not trusted once the last event detaches', () => {
    const rn = sources();
    followDrivers(rn);
    const node = new rn.valueClass();
    const first = new rn.eventClass([{ nativeEvent: { y: node } }]);
    const second = new rn.eventClass([{ nativeEvent: { y: node } }]);
    first.__attach();
    second.__attach();
    node.setValue(0);
    first.__detach();
    // Still driven by the second: trusted or not, the event wins; known until the last one goes.
    expect(knownDriven(node)).toBe(true);

    second.__detach();

    expect(knownDriven(node)).toBe(false);
  });

  it('a value set from JS after its event left it is known again', () => {
    const rn = sources();
    followDrivers(rn);
    const node = new rn.valueClass();
    const event = new rn.eventClass([{ nativeEvent: { y: node } }]);
    event.__attach();
    event.__detach();
    expect(knownDriven(node)).toBe(false);

    node.setValue(3);

    expect(knownDriven(node)).toBe(true);
  });

  it('an AnimatedValue without the methods that move it is still followed by being made native', () => {
    const rn = sources();
    class Bare {
      __isNative = false;
      __makeNative(): void {
        this.__isNative = true;
      }
    }
    expect(followDrivers({ ...rn, valueClass: Bare })).toBe(true);
    // Nothing React Native lacks is added.
    expect(Object.getOwnPropertyNames(Bare.prototype).sort()).toEqual(['__makeNative', 'constructor']);
    const node = new Bare();
    const woken = jest.fn();
    whenMoved(node, woken);

    node.__makeNative();

    expect(woken).toHaveBeenCalledTimes(1);
    expect(knownDriven(node)).toBe(true);
  });

  it('P3-3: wakes a watcher the moment its value is made native, once, until it stops watching', () => {
    const rn = sources();
    followDrivers(rn);
    const node = new rn.valueClass();
    const woken = jest.fn();
    const failing = jest.fn(() => {
      throw new Error('watcher');
    });
    whenMoved(node, failing);
    const stop = whenMoved(node, woken) as () => void;

    node.__makeNative();
    node.__makeNative();
    expect(woken).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    // React Native's own method ran each time.
    expect(rn.calls.filter(([name]) => name === 'makeNative')).toHaveLength(2);

    const other = new rn.valueClass();
    const stopOther = whenMoved(other, woken) as () => void;
    stopOther();
    stop();
    other.__makeNative();
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it('a node is anything with __getValue', () => {
    expect(isNode({ __getValue: () => 0 })).toBe(true);
    expect([null, undefined, 3, {}].map(isNode)).toEqual([false, false, false, false]);
  });
});
