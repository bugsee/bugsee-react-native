import { encodeBridgeObject } from '../json';

describe('encodeBridgeObject', () => {
  // The reason this transport exists: iOS's TurboModule conversion of an
  // object argument drops every null member. As text, null is just "null".
  it('keeps a top-level null member as null', () => {
    expect(encodeBridgeObject({ nil: null, s: 'x' })).toBe('{"nil":null,"s":"x"}');
  });

  it('keeps nested null members, in objects and arrays', () => {
    expect(encodeBridgeObject({ attributes: { gone: null }, list: [null, 1] })).toBe(
      '{"attributes":{"gone":null},"list":[null,1]}',
    );
  });

  // Native parses an integral literal as an integer and anything else as a
  // double, so what the text says is what the SDK stores.
  it('writes integral numbers without a fraction and fractions as they are', () => {
    expect(encodeBridgeObject({ int: 3, big: 9007199254740991, frac: 1.5, neg: -7 })).toBe(
      '{"int":3,"big":9007199254740991,"frac":1.5,"neg":-7}',
    );
  });

  it('keeps booleans as booleans, not 1 and 0', () => {
    expect(encodeBridgeObject({ yes: true, no: false })).toBe('{"yes":true,"no":false}');
  });

  it('encodes an empty object as {}', () => {
    expect(encodeBridgeObject({})).toBe('{}');
  });

  // validateAttributes builds its map with no prototype so "__proto__" is an
  // ordinary key; the text must carry it like any other.
  it('carries "__proto__" as an ordinary key of a prototype-less object', () => {
    const value: Record<string, unknown> = Object.create(null);
    value.__proto__ = 'x';
    value.b = null;
    expect(encodeBridgeObject(value)).toBe('{"__proto__":"x","b":null}');
  });

  it('round-trips through JSON.parse to an equal value', () => {
    const value = { s: 'a"b\\c\nd', nested: { list: [1, 'two', { deep: false }], empty: {} } };
    expect(JSON.parse(encodeBridgeObject(value))).toEqual(value);
  });
});
