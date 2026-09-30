import {
  encodeExceptionOptions,
  EXCEPTION_DOMAIN_MAX_LENGTH,
} from '../options';

describe('encodeExceptionOptions', () => {
  it('undefined and {} encode to null', () => {
    expect(encodeExceptionOptions(undefined)).toBeNull();
    expect(encodeExceptionOptions({})).toBeNull();
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

  it('rejects an empty domain, a domain over 256 characters and a non-string domain', () => {
    expect(() => encodeExceptionOptions({ domain: '' })).toThrow(RangeError);
    expect(() =>
      encodeExceptionOptions({ domain: 'x'.repeat(EXCEPTION_DOMAIN_MAX_LENGTH + 1) }),
    ).toThrow(RangeError);
    expect(() =>
      encodeExceptionOptions({ domain: 42 as unknown as string }),
    ).toThrow(TypeError);
  });

  it('rejects labels that are not an array of strings', () => {
    expect(() =>
      encodeExceptionOptions({ labels: 'x' as unknown as string[] }),
    ).toThrow(TypeError);
    expect(() =>
      encodeExceptionOptions({ labels: [1] as unknown as string[] }),
    ).toThrow(TypeError);
  });

  it('rejects a non-boolean includeVideo', () => {
    expect(() =>
      encodeExceptionOptions({ includeVideo: 1 as unknown as boolean }),
    ).toThrow(TypeError);
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
