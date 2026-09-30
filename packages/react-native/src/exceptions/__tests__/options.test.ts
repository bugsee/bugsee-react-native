import {
  encodeExceptionOptions,
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

  it('domain, labels and includeVideo encode in that order', () => {
    const encoded = encodeExceptionOptions({
      includeVideo: true,
      domain: 'auth',
      labels: ['a', 'b'],
    });
    expect(encoded).toBe(
      '{"domain":"auth","labels":["a","b"],"includeVideo":true}',
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

  it('rejects labels that are not an array of strings', () => {
    expect(() =>
      encodeExceptionOptions({ labels: 'x' as unknown as string[] }),
    ).toThrow(
      new TypeError('ExceptionOptions.labels must be an array of strings'),
    );
    expect(() =>
      encodeExceptionOptions({ labels: [1] as unknown as string[] }),
    ).toThrow(
      new TypeError('ExceptionOptions.labels must be an array of strings'),
    );
  });

  it('rejects a non-boolean includeVideo', () => {
    expect(() =>
      encodeExceptionOptions({ includeVideo: 1 as unknown as boolean }),
    ).toThrow(new TypeError('ExceptionOptions.includeVideo must be a boolean'));
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
    const labelSecret = 'SECRET_LABEL_VALUE';
    try {
      encodeExceptionOptions({ labels: [labelSecret, 1] as unknown as string[] });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(labelSecret);
    }
  });
});
