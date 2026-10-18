import {
  encodeExceptionOptions,
  exceptionOptionsMessage,
  EXCEPTION_DOMAIN_MAX_LENGTH,
} from '../options';

describe('encodeExceptionOptions', () => {
  it('undefined and {} encode to null', () => {
    expect(encodeExceptionOptions(undefined)).toBeNull();
    expect(encodeExceptionOptions({})).toBeNull();
  });

  it('rejects a non-object options value', () => {
    expect(() => encodeExceptionOptions(null as unknown as undefined)).toThrow(
      new TypeError('ExceptionOptions must be a plain object'),
    );
    expect(() => encodeExceptionOptions(42 as unknown as undefined)).toThrow(
      new TypeError('ExceptionOptions must be a plain object'),
    );
    expect(() => encodeExceptionOptions('x' as unknown as undefined)).toThrow(
      new TypeError('ExceptionOptions must be a plain object'),
    );
    expect(() => encodeExceptionOptions([] as unknown as undefined)).toThrow(
      new TypeError('ExceptionOptions must be a plain object'),
    );
  });

  it('only the domain encodes', () => {
    expect(encodeExceptionOptions({ domain: 'auth' })).toBe('{"domain":"auth"}');
  });

  it('labels and includeVideo are no longer options: they are unknown keys', () => {
    expect(() => encodeExceptionOptions({ labels: ['a'] } as never)).toThrow(
      new TypeError('ExceptionOptions has unknown key "labels"'),
    );
    expect(() => encodeExceptionOptions({ includeVideo: true } as never)).toThrow(
      new TypeError('ExceptionOptions has unknown key "includeVideo"'),
    );
  });

  it('accepts a domain of exactly EXCEPTION_DOMAIN_MAX_LENGTH', () => {
    const domain = 'x'.repeat(EXCEPTION_DOMAIN_MAX_LENGTH);
    expect(encodeExceptionOptions({ domain })).toBe(
      JSON.stringify({ domain }),
    );
  });

  it('rejects an empty domain, a domain over 256 characters and a non-string domain', () => {
    expect(() => encodeExceptionOptions({ domain: '' })).toThrow(
      new RangeError('ExceptionOptions.domain must be non-empty'),
    );
    expect(() =>
      encodeExceptionOptions({ domain: 'x'.repeat(EXCEPTION_DOMAIN_MAX_LENGTH + 1) }),
    ).toThrow(
      new RangeError(
        `ExceptionOptions.domain must be at most ${EXCEPTION_DOMAIN_MAX_LENGTH} characters`,
      ),
    );
    expect(() =>
      encodeExceptionOptions({ domain: 42 as unknown as string }),
    ).toThrow(new TypeError('ExceptionOptions.domain must be a string'));
  });

  it('rejects an unknown key, naming it', () => {
    expect(() =>
      encodeExceptionOptions({ mergingRules: true } as never),
    ).toThrow(/mergingRules/);
    expect(() =>
      encodeExceptionOptions({ skipFrames: 2 } as never),
    ).toThrow(/skipFrames/);
  });

  it('no message contains the rejected value', () => {
    const secret = 'SECRET_DOMAIN_VALUE_xyz';
    try {
      encodeExceptionOptions({
        domain: { toString: () => secret } as unknown as string,
      });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
    const longSecret = `secret-${'z'.repeat(EXCEPTION_DOMAIN_MAX_LENGTH + 1)}`;
    try {
      encodeExceptionOptions({ domain: longSecret });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(longSecret);
    }
  });
});

describe('exceptionOptionsMessage', () => {
  it("is the message of an error encodeExceptionOptions threw: the package's own, field names only", () => {
    for (const bad of [{ domain: '' }, { domain: 3 }, { nope: 1 }, { labels: [1] }, 'x']) {
      let thrown: unknown;
      try {
        encodeExceptionOptions(bad as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(exceptionOptionsMessage(thrown)).toBe((thrown as Error).message);
    }
  });

  it('is only the class name of anything else, even an identical-looking error', () => {
    expect(exceptionOptionsMessage(new RangeError('ExceptionOptions.domain must be non-empty'))).toBe('RangeError');
    expect(exceptionOptionsMessage('s3cret')).toBe('string');
  });

  it('never throws, even for a Proxy whose getPrototypeOf trap throws', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          throw new Error('trap');
        },
      },
    );
    expect(exceptionOptionsMessage(hostile)).toBe('object');
  });
});

