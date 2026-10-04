// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { native } from '../../__mocks__/native';
import Bugsee from '../../index';
import { AttributeErrorCode, BugseeAttributeError } from '../errors';
import { BUNDLE_NUMBER_LIMIT, BUNDLE_NUMBER_LIMIT_DECIMAL } from '../../data/validate';

/** The largest IEEE-754 double strictly below 2^63 (the gap there is 2^11). */
const LARGEST_DOUBLE_BELOW_2_63 = 9223372036854774784;

beforeEach(() => native.reset());

describe('AttributeErrorCode', () => {
  it('is exactly the two stable strings', () => {
    expect(AttributeErrorCode).toEqual({
      BadArgument: 'E_ATTRIBUTE_BAD_ARGUMENT',
      Rejected: 'E_ATTRIBUTE_REJECTED',
    });
  });
});

describe('setAttribute', () => {
  it('a string goes to setAttributeString', async () => {
    native.setAttributeString.mockResolvedValueOnce(undefined);
    await Bugsee.setAttribute('k', 'v');
    expect(native.setAttributeString).toHaveBeenCalledWith('k', 'v');
    expect(native.setAttributeNumber).not.toHaveBeenCalled();
    expect(native.setAttributeBoolean).not.toHaveBeenCalled();
  });

  it('a number goes to setAttributeNumber', async () => {
    native.setAttributeNumber.mockResolvedValueOnce(undefined);
    await Bugsee.setAttribute('k', 42);
    expect(native.setAttributeNumber).toHaveBeenCalledWith('k', 42);
    expect(native.setAttributeString).not.toHaveBeenCalled();
    expect(native.setAttributeBoolean).not.toHaveBeenCalled();
  });

  it('a boolean goes to setAttributeBoolean', async () => {
    native.setAttributeBoolean.mockResolvedValueOnce(undefined);
    await Bugsee.setAttribute('k', true);
    expect(native.setAttributeBoolean).toHaveBeenCalledWith('k', true);
    expect(native.setAttributeString).not.toHaveBeenCalled();
    expect(native.setAttributeNumber).not.toHaveBeenCalled();
  });

  it('rejects NaN, Infinity and -Infinity with E_ATTRIBUTE_BAD_ARGUMENT before crossing', async () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const error = await Bugsee.setAttribute('k', bad).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BugseeAttributeError);
      expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
    }
    expect(native.setAttributeNumber).not.toHaveBeenCalled();
  });

  it('rejects ±2^63 and accepts ±9223372036854774784', async () => {
    for (const bad of [BUNDLE_NUMBER_LIMIT, -BUNDLE_NUMBER_LIMIT]) {
      const error = await Bugsee.setAttribute('k', bad).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BugseeAttributeError);
      expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
    }
    native.setAttributeNumber.mockResolvedValue(undefined);
    await Bugsee.setAttribute('k', LARGEST_DOUBLE_BELOW_2_63);
    await Bugsee.setAttribute('k', -LARGEST_DOUBLE_BELOW_2_63);
    expect(native.setAttributeNumber).toHaveBeenCalledWith('k', LARGEST_DOUBLE_BELOW_2_63);
    expect(native.setAttributeNumber).toHaveBeenCalledWith('k', -LARGEST_DOUBLE_BELOW_2_63);
  });

  it('accepts ±9007199254740991', async () => {
    native.setAttributeNumber.mockResolvedValue(undefined);
    await Bugsee.setAttribute('k', 9007199254740991);
    await Bugsee.setAttribute('k', -9007199254740991);
    expect(native.setAttributeNumber).toHaveBeenCalledWith('k', 9007199254740991);
    expect(native.setAttributeNumber).toHaveBeenCalledWith('k', -9007199254740991);
  });

  it('accepts a 1024-unit string and rejects 1025', async () => {
    native.setAttributeString.mockResolvedValue(undefined);
    await Bugsee.setAttribute('k', 'a'.repeat(1024));
    expect(native.setAttributeString).toHaveBeenCalledWith('k', 'a'.repeat(1024));

    const error = await Bugsee.setAttribute('k', 'a'.repeat(1025)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugseeAttributeError);
    expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
  });

  it('counts UTF-16 units, not code points', async () => {
    native.setAttributeString.mockResolvedValue(undefined);
    const emoji512 = '\u{1F600}'.repeat(512); // 1024 UTF-16 units, 512 code points
    await Bugsee.setAttribute('k', emoji512);
    expect(native.setAttributeString).toHaveBeenCalledWith('k', emoji512);

    const emoji513 = '\u{1F600}'.repeat(513); // 1026 UTF-16 units
    const error = await Bugsee.setAttribute('k', emoji513).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugseeAttributeError);
    expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
  });

  it('rejects null, undefined, an array, an object and a bigint, naming the type', async () => {
    const cases: [unknown, string][] = [
      [null, 'null'],
      [undefined, 'undefined'],
      [[1, 2], 'array'],
      [{}, 'Object'],
      [BigInt(1), 'bigint'],
    ];
    for (const [bad, label] of cases) {
      const error = await Bugsee.setAttribute('k', bad as unknown as string).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BugseeAttributeError);
      expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
      expect((error as Error).message).toBe(
        `attribute value must be a string, a number or a boolean, got ${label}`,
      );
    }
    expect(native.setAttributeString).not.toHaveBeenCalled();
    expect(native.setAttributeNumber).not.toHaveBeenCalled();
    expect(native.setAttributeBoolean).not.toHaveBeenCalled();
  });

  // The `?? 'object'` fallback: a value whose prototype chain never reaches
  // `Object.prototype` has no `.constructor` at all.
  it('names a constructor-less object as "object"', async () => {
    const noConstructor = Object.create(null) as object;
    const error = await Bugsee.setAttribute('k', noConstructor as unknown as string).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe(
      'attribute value must be a string, a number or a boolean, got object',
    );
  });

  it('rejects an empty or non-string name, naming the type', async () => {
    const cases: [unknown, string][] = [
      ['', 'string'],
      [42, 'number'],
      [null, 'null'],
      [undefined, 'undefined'],
    ];
    for (const [bad, label] of cases) {
      const error = await Bugsee.setAttribute(bad as unknown as string, 'v').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BugseeAttributeError);
      expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
      expect((error as Error).message).toBe(
        `attribute name must be a non-empty string, got ${label}`,
      );
    }
    expect(native.setAttributeString).not.toHaveBeenCalled();
  });

  it('names the exact message for a number outside the bundle bound', async () => {
    const error = await Bugsee.setAttribute('k', BUNDLE_NUMBER_LIMIT).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `attribute value must be a finite number smaller than ` +
        `2^63 (${BUNDLE_NUMBER_LIMIT_DECIMAL}) in magnitude`,
    );
  });

  // The rejected value itself must never appear in the message: a magnitude
  // this size only ever reaches JS as a float, and printing it -- via
  // `String`/template-literal conversion, or even `BUNDLE_NUMBER_LIMIT`
  // itself the same way -- silently rounds, e.g. `1e19` prints as
  // `10000000000000000000`, and 2^63 itself prints as
  // `9223372036854776000` rather than the true `9223372036854775808`.
  it('does not echo the rejected number, at any precision, in the message', async () => {
    const error = await Bugsee.setAttribute('k', 1e19).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).not.toContain('1e19');
    expect(message).not.toContain('10000000000000000000');
    expect(message).not.toContain('9223372036854776000');
    expect(message).toContain(BUNDLE_NUMBER_LIMIT_DECIMAL);
  });

  it('names the exact message for an over-long string', async () => {
    const error = await Bugsee.setAttribute('k', 'a'.repeat(1025)).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'attribute value must be at most 1024 UTF-16 units',
    );
  });

  it('a native E_ATTRIBUTE_REJECTED surfaces as BugseeAttributeError', async () => {
    native.setAttributeString.mockRejectedValueOnce({
      code: AttributeErrorCode.Rejected,
      message: 'too big',
    });
    const error = await Bugsee.setAttribute('k', 'v').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugseeAttributeError);
    expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.Rejected);
    expect((error as BugseeAttributeError).message).toBe('too big');
  });

  it('passes an already-BugseeAttributeError native rejection through unchanged', async () => {
    const original = new BugseeAttributeError(AttributeErrorCode.Rejected, 'already wrapped');
    native.setAttributeString.mockRejectedValueOnce(original);
    const error = await Bugsee.setAttribute('k', 'v').catch((e: unknown) => e);
    expect(error).toBe(original);
  });

  it('passes a native rejection with an unrecognized code through unchanged', async () => {
    const original = { code: 'E_SOMETHING_ELSE', message: 'nope' };
    native.setAttributeString.mockRejectedValueOnce(original);
    const error = await Bugsee.setAttribute('k', 'v').catch((e: unknown) => e);
    expect(error).toBe(original);
  });

  it('passes a rejection with no code (e.g. null) through unchanged', async () => {
    native.setAttributeString.mockRejectedValueOnce(null);
    const error: unknown = await Bugsee.setAttribute('k', 'v').catch((e: unknown) => e);
    expect(error).toBeNull();
  });

  it('falls back to the code as the message when the native rejection carries none', async () => {
    native.setAttributeString.mockRejectedValueOnce({ code: AttributeErrorCode.Rejected });
    const error = await Bugsee.setAttribute('k', 'v').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugseeAttributeError);
    expect((error as BugseeAttributeError).message).toBe(AttributeErrorCode.Rejected);
  });

  it('has the stable .name "BugseeAttributeError"', () => {
    const error = new BugseeAttributeError(AttributeErrorCode.BadArgument, 'msg');
    expect(error.name).toBe('BugseeAttributeError');
    expect(error).toBeInstanceOf(Error);
  });

  it('never throws synchronously', () => {
    // A synchronous throw here would not be a rejected promise, and a caller
    // awaiting it would never get the chance to catch it.
    expect(() => {
      const result = Bugsee.setAttribute(null as unknown as string, 'v');
      result.catch(() => {}); // avoid an unhandled rejection warning
    }).not.toThrow();
  });
});

describe('getAttribute', () => {
  it('unwraps {value} and maps {} to undefined', async () => {
    native.getAttribute.mockResolvedValueOnce({ value: 'hi' });
    await expect(Bugsee.getAttribute('k')).resolves.toBe('hi');

    native.getAttribute.mockResolvedValueOnce({});
    await expect(Bugsee.getAttribute('k')).resolves.toBeUndefined();
  });

  it('validates the name', async () => {
    const error = await Bugsee.getAttribute('').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugseeAttributeError);
    expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
    expect(native.getAttribute).not.toHaveBeenCalled();
  });

  // Defends against a malformed native result the same way `?.` reads:
  // gracefully, as absent, rather than throwing on `.value`.
  it('treats a null native result as absent', async () => {
    native.getAttribute.mockResolvedValueOnce(null as unknown as Record<string, unknown>);
    await expect(Bugsee.getAttribute('k')).resolves.toBeUndefined();
  });
});

describe('getAllAttributes', () => {
  it('maps a native {} to {}', async () => {
    native.getAllAttributes.mockResolvedValueOnce({});
    await expect(Bugsee.getAllAttributes()).resolves.toEqual({});
  });

  it('passes through a populated native map', async () => {
    native.getAllAttributes.mockResolvedValueOnce({ a: 1, b: 'x', c: true, d: ['x', 'y'] });
    await expect(Bugsee.getAllAttributes()).resolves.toEqual({
      a: 1,
      b: 'x',
      c: true,
      d: ['x', 'y'],
    });
  });

  it('drops an entry whose value does not normalize, without leaving it as an own key', async () => {
    native.getAllAttributes.mockResolvedValueOnce({
      a: 1,
      bad: {},
      // Not every element is a string, so the whole entry is dropped rather
      // than partially kept.
      mixedArray: [1, 'x'],
    });
    const result = await Bugsee.getAllAttributes();
    expect(result).toEqual({ a: 1 });
    expect(Object.prototype.hasOwnProperty.call(result, 'bad')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'mixedArray')).toBe(false);
  });

  it('returns an empty map for a non-object native result', async () => {
    native.getAllAttributes.mockResolvedValueOnce(null as unknown as Record<string, unknown>);
    await expect(Bugsee.getAllAttributes()).resolves.toEqual({});
  });

  // "__proto__" is a legal attribute name on both native SDKs. `JSON.parse`
  // (what the RN bridge's own deserialization behaves like) gives it as an
  // ordinary own property, not a prototype-chain write -- but a plain `{}`
  // result built with bracket assignment would still lose it silently to
  // `Object.prototype`'s own `__proto__` setter. `normalizeAttributesMap` is
  // built on `Object.create(null)` precisely so this key survives as an
  // ordinary own key instead.
  it('keeps an attribute literally named "__proto__" as an ordinary own key, not a prototype write', async () => {
    const raw = JSON.parse('{"__proto__":"mine","a":1}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true);
    native.getAllAttributes.mockResolvedValueOnce(raw);

    const result = await Bugsee.getAllAttributes();

    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(result.__proto__).toBe('mine');
    expect(result.a).toBe(1);
    // Not polluted: the result's own actual prototype is still whatever
    // `normalizeAttributesMap` built it with, not `"mine"`.
    expect(Object.getPrototypeOf(result)).not.toBe('mine');
  });

  // A string is `typeof 'string'`, not `'object'` -- if that half of the
  // guard were dropped, `Object.entries('oops')` would enumerate its indices
  // as own keys ({0: 'o', 1: 'o', ...}) instead of being rejected outright.
  it('returns an empty map for a string native result', async () => {
    native.getAllAttributes.mockResolvedValueOnce('oops' as unknown as Record<string, unknown>);
    await expect(Bugsee.getAllAttributes()).resolves.toEqual({});
  });
});

describe('clearAttribute', () => {
  it('forwards a valid name', async () => {
    native.clearAttribute.mockResolvedValueOnce(undefined);
    await Bugsee.clearAttribute('k');
    expect(native.clearAttribute).toHaveBeenCalledWith('k');
  });

  it('validates the name', async () => {
    const error = await Bugsee.clearAttribute('').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugseeAttributeError);
    expect((error as BugseeAttributeError).code).toBe(AttributeErrorCode.BadArgument);
    expect(native.clearAttribute).not.toHaveBeenCalled();
  });
});

describe('clearAllAttributes', () => {
  it('forwards', async () => {
    native.clearAllAttributes.mockResolvedValueOnce(undefined);
    await Bugsee.clearAllAttributes();
    expect(native.clearAllAttributes).toHaveBeenCalledTimes(1);
  });
});
