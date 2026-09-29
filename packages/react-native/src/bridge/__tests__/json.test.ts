import { encodeBridgeObject, replaceLoneSurrogates } from '../json';

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

// iOS's NSJSONSerialization rejects the whole text when JSON.stringify writes
// a lone surrogate as `\ud800` (BGSRNJSONTests), so a summary cut mid-emoji
// would fail on iOS and pass on Android. Before the JSON transport, RN's own
// string conversion turned a lone surrogate into U+FFFD; this restores that,
// in JS, for every string -- key or value -- on both platforms.
describe('lone surrogates', () => {
  const HIGH = '\uD83D'; // the first half of 😀 (U+1F600)
  const LOW = '\uDE00'; // its second half
  const EMOJI = `${HIGH}${LOW}`;

  it('replaces a lone high surrogate with U+FFFD', () => {
    const text = encodeBridgeObject({ s: `a${HIGH}` });
    expect(text).toBe('{"s":"a\uFFFD"}');
    expect(JSON.parse(text)).toEqual({ s: 'a\uFFFD' });
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    expect(encodeBridgeObject({ s: `${LOW}b` })).toBe('{"s":"\uFFFDb"}');
  });

  it('leaves a valid surrogate pair alone', () => {
    const text = encodeBridgeObject({ s: `x${EMOJI}y` });
    expect(text).toBe(`{"s":"x${EMOJI}y"}`);
    expect(JSON.parse(text)).toEqual({ s: `x${EMOJI}y` });
  });

  it('replaces one in a key', () => {
    const text = encodeBridgeObject({ [`k${HIGH}`]: 1 });
    expect(text).toBe('{"k\uFFFD":1}');
    expect(JSON.parse(text)).toEqual({ 'k\uFFFD': 1 });
  });

  it('reaches strings nested in objects and arrays', () => {
    expect(
      encodeBridgeObject({ a: { b: [`${LOW}`, { [`${LOW}`]: `${HIGH}` }] } }),
    ).toBe('{"a":{"b":["\uFFFD",{"\uFFFD":"\uFFFD"}]}}');
  });

  // The escape JSON.stringify would otherwise write is exactly what iOS
  // rejects: none may survive into the text.
  it('leaves no \\u surrogate escape in the text', () => {
    const text = encodeBridgeObject({ [`${LOW}${HIGH}`]: [`${HIGH}${HIGH}${LOW}`, `${LOW}${LOW}`] });
    expect(text).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(text)).toEqual({ '\uFFFD\uFFFD': [`\uFFFD${EMOJI}`, '\uFFFD\uFFFD'] });
  });

  it('keeps "__proto__" an ordinary key while copying', () => {
    const value: Record<string, unknown> = Object.create(null);
    value.__proto__ = `x${HIGH}`;
    expect(encodeBridgeObject(value)).toBe('{"__proto__":"x\uFFFD"}');
  });

  it('keeps non-string values as they are', () => {
    expect(encodeBridgeObject({ n: 1.5, t: true, z: null, l: [0, false] })).toBe(
      '{"n":1.5,"t":true,"z":null,"l":[0,false]}',
    );
  });
});

describe('which normaliser runs', () => {
  const proto = String.prototype as { toWellFormed?: () => string };
  const original = proto.toWellFormed;

  afterEach(() => {
    if (original === undefined) {
      delete proto.toWellFormed;
    } else {
      proto.toWellFormed = original;
    }
  });

  it("uses the engine's toWellFormed when it has one", () => {
    const spy = jest.fn(function (this: string) {
      return `native:${this}`;
    });
    proto.toWellFormed = spy;
    expect(encodeBridgeObject({ s: 'x' })).toBe('{"native:s":"native:x"}');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // Hermes may lack it: the fallback must then do the whole job.
  it('falls back to replaceLoneSurrogates when the engine has none', () => {
    delete proto.toWellFormed;
    expect(encodeBridgeObject({ ['k\uD83D']: 'a\uDE00' })).toBe('{"k�":"a�"}');
  });
});

// The fallback for an engine without String.prototype.toWellFormed (ES2024):
// tested directly, since the engine running these tests has it.
describe('replaceLoneSurrogates', () => {
  it.each([
    ['', ''],
    ['plain', 'plain'],
    ['a\uD83D', 'a\uFFFD'],
    ['\uDE00b', '\uFFFDb'],
    ['\uD83D\uDE00', '\uD83D\uDE00'],
    ['\uD83D\uD83D\uDE00', '\uFFFD\uD83D\uDE00'],
    ['\uDE00\uD83D', '\uFFFD\uFFFD'],
    ['\uDBFF\uDFFF\uD800', '\uDBFF\uDFFF\uFFFD'],
    ['\uD7FF\uE000', '\uD7FF\uE000'],
    ['\uD800', '\uFFFD'],
    ['\uDBFF', '\uFFFD'],
    ['\uDC00', '\uFFFD'],
    ['\uDFFF', '\uFFFD'],
    ['\uD800\uDC00', '\uD800\uDC00'],
    ['\uD83Dz', '\uFFFDz'],
  ])('%j -> %j', (input, expected) => {
    expect(replaceLoneSurrogates(input)).toBe(expected);
  });

  it('agrees with toWellFormed where the engine has it', () => {
    const toWellFormed = (String.prototype as { toWellFormed?: () => string }).toWellFormed;
    if (toWellFormed === undefined) return;
    for (const input of ['a\uD83D', '\uDE00\uD83D\uDE00', '\uD800\uDC00\uDC00x']) {
      expect(replaceLoneSurrogates(input)).toBe(toWellFormed.call(input));
    }
  });
});
