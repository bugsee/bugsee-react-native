import {
  BUNDLE_NUMBER_LIMIT,
  BUNDLE_NUMBER_LIMIT_DECIMAL,
  EVENT_PARAMS_MAX_DEPTH,
  assertEventOrTraceName,
  assertTraceValue,
  copyEventParams,
  isWithinBundleNumberLimit,
} from '../validate';
import type { EventParams } from '../validate';

/** The largest IEEE-754 double strictly below 2^63 (the gap there is 2^11). */
const LARGEST_DOUBLE_BELOW_2_63 = 9223372036854774784;

/** Nests a leaf `depth` deep, counting the root as depth 1. */
function nested(depth: number): EventParams {
  let value: unknown = { leaf: true };
  for (let i = 1; i < depth; i += 1) {
    value = { child: value };
  }
  return value as EventParams;
}

/** `n` arrays stacked around a leaf, the outermost being the returned value. */
function nestedArrays(n: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < n; i += 1) {
    value = [value];
  }
  return value;
}

describe('copyEventParams', () => {
  it('accepts nested objects and arrays of JSON values', () => {
    const params: EventParams = {
      str: 'a',
      int: 3,
      frac: 1.5,
      neg: -7,
      yes: true,
      no: false,
      nil: null,
      list: [1, 'two', { deep: false }],
      nested: { a: { b: [1, 2, 3] } },
    };
    expect(copyEventParams(params)).toEqual({
      str: 'a',
      int: 3,
      frac: 1.5,
      neg: -7,
      yes: true,
      no: false,
      nil: null,
      list: [1, 'two', { deep: false }],
      nested: { a: { b: [1, 2, 3] } },
    });
  });

  it('omits undefined object members', () => {
    const params = { a: 1, b: undefined } as unknown as EventParams;
    const copy = copyEventParams(params);
    expect(copy).toEqual({ a: 1 });
    expect('b' in copy).toBe(false);
  });

  it('rejects NaN, Infinity and -Infinity, naming the path', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => copyEventParams({ a: { b: [0, bad] } } as unknown as EventParams))
        .toThrow(RangeError);
      expect(() => copyEventParams({ a: { b: [0, bad] } } as unknown as EventParams))
        .toThrow('params.a.b[1] must be a finite number');
      expect(() => copyEventParams({ a: { b: [0, bad] } } as unknown as EventParams))
        .not.toThrow(String(bad));
    }
  });

  it('rejects undefined inside an array, naming its index', () => {
    expect(() => copyEventParams({ list: [1, undefined, 3] } as unknown as EventParams))
      .toThrow(TypeError);
    expect(() => copyEventParams({ list: [1, undefined, 3] } as unknown as EventParams))
      .toThrow('params.list[1] must not be undefined');
  });

  it('names the accepted domain and the actual type when rejecting', () => {
    expect(() => copyEventParams({ a: () => {} } as unknown as EventParams)).toThrow(
      'params.a must be a plain object, an array, a string, a finite number, ' +
        'a boolean or null; got function',
    );
  });

  it('rejects functions, symbols and bigint, naming each type', () => {
    expect(() => copyEventParams({ a: () => {} } as unknown as EventParams))
      .toThrow(/got function$/);
    expect(() => copyEventParams({ a: Symbol('s') } as unknown as EventParams))
      .toThrow(/got symbol$/);
    expect(() => copyEventParams({ a: BigInt(1) } as unknown as EventParams))
      .toThrow(/got bigint$/);
  });

  it('rejects Date, Map, Set and Uint8Array, naming each constructor', () => {
    expect(() => copyEventParams({ a: new Date() } as unknown as EventParams)).toThrow(/got Date$/);
    expect(() => copyEventParams({ a: new Map() } as unknown as EventParams)).toThrow(/got Map$/);
    expect(() => copyEventParams({ a: new Set() } as unknown as EventParams)).toThrow(/got Set$/);
    expect(() => copyEventParams({ a: new Uint8Array(2) } as unknown as EventParams))
      .toThrow(/got Uint8Array$/);
  });

  it('rejects a class instance, naming its constructor', () => {
    class Foo {}
    expect(() => copyEventParams({ a: new Foo() } as unknown as EventParams)).toThrow(/got Foo$/);
  });

  it('falls back to "object" for a value with no constructor at all', () => {
    const protoWithNoConstructor = Object.create(null) as object;
    const noConstructor = Object.create(protoWithNoConstructor) as object;
    expect(() => copyEventParams({ a: noConstructor } as unknown as EventParams))
      .toThrow(/got object$/);
  });

  it('rejects a cycle in an object, naming the path that closes the loop', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => copyEventParams(obj as unknown as EventParams)).toThrow(TypeError);
    // The re-entry point, 'params.self' (where the loop is discovered) --
    // not the root, which is where the cycle originates but not where the
    // recursion re-detects the ancestor.
    expect(() => copyEventParams(obj as unknown as EventParams))
      .toThrow('params.self is a cycle: it contains itself');
  });

  it('rejects a cycle in an array, naming the path that closes the loop', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => copyEventParams({ list: arr } as unknown as EventParams)).toThrow(TypeError);
    expect(() => copyEventParams({ list: arr } as unknown as EventParams))
      .toThrow('params.list[1] is a cycle: it contains itself');
  });

  it('accepts the same object used twice without treating it as a cycle', () => {
    const shared = { x: 1 };
    expect(copyEventParams({ a: shared, b: shared } as unknown as EventParams))
      .toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('accepts the same array used twice without treating it as a cycle', () => {
    const shared = [1, 2];
    expect(copyEventParams({ a: shared, b: shared } as unknown as EventParams))
      .toEqual({ a: [1, 2], b: [1, 2] });
  });

  it('rejects nesting deeper than 16 and accepts exactly 16', () => {
    expect(() => copyEventParams(nested(EVENT_PARAMS_MAX_DEPTH))).not.toThrow();
    expect(() => copyEventParams(nested(EVENT_PARAMS_MAX_DEPTH + 1))).toThrow(RangeError);
  });

  it('names the path and the limit when object nesting exceeds the maximum', () => {
    const expectedPath = 'params' + '.child'.repeat(EVENT_PARAMS_MAX_DEPTH);
    expect(() => copyEventParams(nested(EVENT_PARAMS_MAX_DEPTH + 1)))
      .toThrow(`${expectedPath} nests deeper than the maximum of ${EVENT_PARAMS_MAX_DEPTH}`);
  });

  it('rejects array nesting deeper than 16 and accepts exactly 16', () => {
    // 'list' itself is depth 2, so a stack of (MAX - 1) more arrays reaches
    // depth MAX exactly; one more tips it past the limit.
    expect(() => copyEventParams({ list: nestedArrays(EVENT_PARAMS_MAX_DEPTH - 1) } as unknown as EventParams))
      .not.toThrow();
    expect(() => copyEventParams({ list: nestedArrays(EVENT_PARAMS_MAX_DEPTH) } as unknown as EventParams))
      .toThrow(RangeError);
  });

  it('names the path and the limit when array nesting exceeds the maximum', () => {
    const expectedPath = 'params.list' + '[0]'.repeat(EVENT_PARAMS_MAX_DEPTH - 1);
    expect(() => copyEventParams({ list: nestedArrays(EVENT_PARAMS_MAX_DEPTH) } as unknown as EventParams))
      .toThrow(`${expectedPath} nests deeper than the maximum of ${EVENT_PARAMS_MAX_DEPTH}`);
  });

  it('rejects params that are not a plain object, naming the type', () => {
    class Foo {}
    expect(() => copyEventParams([] as unknown as EventParams)).toThrow(TypeError);
    expect(() => copyEventParams([] as unknown as EventParams))
      .toThrow('Bugsee.event requires params to be a plain object, got array');
    expect(() => copyEventParams(null as unknown as EventParams)).toThrow(TypeError);
    expect(() => copyEventParams(null as unknown as EventParams))
      .toThrow('Bugsee.event requires params to be a plain object, got null');
    expect(() => copyEventParams(new Foo() as unknown as EventParams)).toThrow(TypeError);
    expect(() => copyEventParams(new Foo() as unknown as EventParams))
      .toThrow('Bugsee.event requires params to be a plain object, got Foo');
  });

  // `undefined` isn't caught by the `=== null` arm of `isPlainObject`'s guard
  // clause, so this pins that the primitive-type check in front of it is
  // load-bearing: without it, `Object.getPrototypeOf(undefined)` throws its
  // own uncontrolled TypeError instead of this one.
  it('rejects undefined params with the same message as any other bad type', () => {
    expect(() => copyEventParams(undefined as unknown as EventParams))
      .toThrow('Bugsee.event requires params to be a plain object, got undefined');
  });

  // Primitives coerce through `Object.getPrototypeOf` to their boxed
  // prototype (`String.prototype`, etc.), which is how they end up rejected
  // even without the primitive-type check above -- but they must still be
  // rejected, with the friendly message, not a native TypeError.
  it('rejects primitive params (string, number, boolean)', () => {
    expect(() => copyEventParams('x' as unknown as EventParams))
      .toThrow('Bugsee.event requires params to be a plain object, got string');
    expect(() => copyEventParams(42 as unknown as EventParams))
      .toThrow('Bugsee.event requires params to be a plain object, got number');
    expect(() => copyEventParams(true as unknown as EventParams))
      .toThrow('Bugsee.event requires params to be a plain object, got boolean');
  });

  it('accepts an object with a null prototype', () => {
    const params = Object.create(null) as Record<string, unknown>;
    params.a = 1;
    expect(copyEventParams(params as unknown as EventParams)).toEqual({ a: 1 });
  });

  // A plain `{}` copy loses this key: `result['__proto__'] = value` hits
  // Object.prototype's accessor instead of creating an own property, and the
  // key silently vanishes both from the copy and from its JSON encoding.
  it('keeps an own "__proto__" key, including in its JSON encoding', () => {
    const params = JSON.parse('{"__proto__":{"x":1},"s":"a"}') as EventParams;
    const copy = copyEventParams(params) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(true);
    expect(copy.__proto__).toEqual({ x: 1 });
    expect(copy.s).toBe('a');
    const encoded = JSON.stringify(copy);
    expect(encoded).toContain('"__proto__":{"x":1}');
    expect(encoded).toContain('"s":"a"');
  });

  it('rejects a number at or beyond BUNDLE_NUMBER_LIMIT (2^63), both signs', () => {
    expect(() => copyEventParams({ n: BUNDLE_NUMBER_LIMIT } as unknown as EventParams))
      .toThrow(RangeError);
    expect(() => copyEventParams({ n: BUNDLE_NUMBER_LIMIT } as unknown as EventParams))
      .toThrow(`params.n must be smaller than 2^63 (${BUNDLE_NUMBER_LIMIT_DECIMAL}) in magnitude`);
    expect(() => copyEventParams({ n: -BUNDLE_NUMBER_LIMIT } as unknown as EventParams))
      .toThrow(RangeError);
  });

  // `BUNDLE_NUMBER_LIMIT` is a `number` -- printing it (or the rejected value)
  // via `String`/template-literal conversion rounds: `String(BUNDLE_NUMBER_LIMIT)`
  // reads `9223372036854776000`, not the true `9223372036854775808`.
  it('does not echo the rejected number, at any precision, in the message', () => {
    expect(() => copyEventParams({ n: 1e19 } as unknown as EventParams)).toThrow(RangeError);
    expect(() => copyEventParams({ n: 1e19 } as unknown as EventParams)).not.toThrow('1e19');
    expect(() => copyEventParams({ n: 1e19 } as unknown as EventParams))
      .not.toThrow('10000000000000000000');
    expect(() => copyEventParams({ n: BUNDLE_NUMBER_LIMIT } as unknown as EventParams))
      .not.toThrow('9223372036854776000');
  });

  it('accepts the largest double below BUNDLE_NUMBER_LIMIT, both signs', () => {
    expect(copyEventParams({ n: LARGEST_DOUBLE_BELOW_2_63 } as unknown as EventParams))
      .toEqual({ n: LARGEST_DOUBLE_BELOW_2_63 });
    expect(copyEventParams({ n: -LARGEST_DOUBLE_BELOW_2_63 } as unknown as EventParams))
      .toEqual({ n: -LARGEST_DOUBLE_BELOW_2_63 });
  });

  it('returns a copy: mutating the input afterwards does not change it', () => {
    const params: Record<string, unknown> = { nested: { a: 1 }, list: [1, 2] };
    const copy = copyEventParams(params as unknown as EventParams);
    (params.nested as Record<string, unknown>).a = 999;
    (params.list as number[]).push(3);
    expect(copy).toEqual({ nested: { a: 1 }, list: [1, 2] });
  });
});

describe('isWithinBundleNumberLimit', () => {
  it('true for a finite number strictly under 2^63, both signs', () => {
    expect(isWithinBundleNumberLimit(0)).toBe(true);
    expect(isWithinBundleNumberLimit(LARGEST_DOUBLE_BELOW_2_63)).toBe(true);
    expect(isWithinBundleNumberLimit(-LARGEST_DOUBLE_BELOW_2_63)).toBe(true);
  });

  it('false at the bound and beyond, both signs', () => {
    expect(isWithinBundleNumberLimit(BUNDLE_NUMBER_LIMIT)).toBe(false);
    expect(isWithinBundleNumberLimit(-BUNDLE_NUMBER_LIMIT)).toBe(false);
    expect(isWithinBundleNumberLimit(BUNDLE_NUMBER_LIMIT * 2)).toBe(false);
  });

  it('false for a non-finite number', () => {
    expect(isWithinBundleNumberLimit(NaN)).toBe(false);
    expect(isWithinBundleNumberLimit(Infinity)).toBe(false);
    expect(isWithinBundleNumberLimit(-Infinity)).toBe(false);
  });

  it('false for a non-number', () => {
    expect(isWithinBundleNumberLimit('42')).toBe(false);
    expect(isWithinBundleNumberLimit(null)).toBe(false);
    expect(isWithinBundleNumberLimit(undefined)).toBe(false);
    expect(isWithinBundleNumberLimit(true)).toBe(false);
  });
});

describe('assertEventOrTraceName', () => {
  it('rejects an empty or non-string name (both kinds)', () => {
    expect(() => assertEventOrTraceName('event', '')).toThrow(RangeError);
    expect(() => assertEventOrTraceName('event', 42)).toThrow(TypeError);
    expect(() => assertEventOrTraceName('trace', '')).toThrow(RangeError);
    expect(() => assertEventOrTraceName('trace', null)).toThrow(TypeError);
  });

  it('accepts a non-empty string name', () => {
    expect(() => assertEventOrTraceName('event', 'ok')).not.toThrow();
  });

  it('names the entry point and the non-empty rule in the empty-name message', () => {
    expect(() => assertEventOrTraceName('event', ''))
      .toThrow('Bugsee.event requires a non-empty name');
    expect(() => assertEventOrTraceName('trace', ''))
      .toThrow('Bugsee.trace requires a non-empty name');
  });

  it('names the entry point and the actual type in the wrong-type message', () => {
    expect(() => assertEventOrTraceName('event', 42))
      .toThrow('Bugsee.event requires name to be a string, got number');
    expect(() => assertEventOrTraceName('trace', undefined))
      .toThrow('Bugsee.trace requires name to be a string, got undefined');
    expect(() => assertEventOrTraceName('trace', null))
      .toThrow('Bugsee.trace requires name to be a string, got null');
  });
});

describe('assertTraceValue', () => {
  it('trace accepts a string, a finite number and a boolean', () => {
    expect(() => assertTraceValue('s')).not.toThrow();
    expect(() => assertTraceValue(42)).not.toThrow();
    expect(() => assertTraceValue(0.25)).not.toThrow();
    expect(() => assertTraceValue(true)).not.toThrow();
    expect(() => assertTraceValue(false)).not.toThrow();
  });

  it('trace rejects null, undefined, NaN, Infinity and objects', () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, {}]) {
      expect(() => assertTraceValue(bad)).toThrow();
    }
    expect(() => assertTraceValue(NaN)).toThrow(RangeError);
    expect(() => assertTraceValue(null)).toThrow(TypeError);
    expect(() => assertTraceValue({})).toThrow(TypeError);
  });

  it('names the problem for a non-finite value, without echoing it', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => assertTraceValue(bad)).toThrow('Bugsee.trace requires a finite number');
      expect(() => assertTraceValue(bad)).not.toThrow(String(bad));
    }
  });

  it('names the actual type for a value outside the domain', () => {
    expect(() => assertTraceValue(null))
      .toThrow('Bugsee.trace requires a string, a finite number or a boolean, got null');
    expect(() => assertTraceValue(undefined))
      .toThrow('Bugsee.trace requires a string, a finite number or a boolean, got undefined');
    expect(() => assertTraceValue({}))
      .toThrow('Bugsee.trace requires a string, a finite number or a boolean, got Object');
  });

  it('rejects a number at or beyond BUNDLE_NUMBER_LIMIT (2^63), both signs', () => {
    expect(() => assertTraceValue(BUNDLE_NUMBER_LIMIT)).toThrow(RangeError);
    expect(() => assertTraceValue(BUNDLE_NUMBER_LIMIT)).toThrow(
      `Bugsee.trace requires a number smaller than 2^63 (${BUNDLE_NUMBER_LIMIT_DECIMAL}) in magnitude`,
    );
    expect(() => assertTraceValue(-BUNDLE_NUMBER_LIMIT)).toThrow(RangeError);
  });

  it('does not echo the rejected number, at any precision, in the message', () => {
    expect(() => assertTraceValue(1e19)).toThrow(RangeError);
    expect(() => assertTraceValue(1e19)).not.toThrow('1e19');
    expect(() => assertTraceValue(1e19)).not.toThrow('10000000000000000000');
    expect(() => assertTraceValue(BUNDLE_NUMBER_LIMIT)).not.toThrow('9223372036854776000');
  });

  it('accepts the largest double below BUNDLE_NUMBER_LIMIT, both signs', () => {
    expect(() => assertTraceValue(LARGEST_DOUBLE_BELOW_2_63)).not.toThrow();
    expect(() => assertTraceValue(-LARGEST_DOUBLE_BELOW_2_63)).not.toThrow();
  });
});
