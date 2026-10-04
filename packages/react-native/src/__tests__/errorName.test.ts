import { errorName } from '../errorName';

describe('errorName', () => {
  it('is the class name of an Error, never its message', () => {
    expect(errorName(new TypeError('s3cret'))).toBe('TypeError');
    class AppFailure extends Error {
      override name = 'AppFailure';
    }
    expect(errorName(new AppFailure('s3cret'))).toBe('AppFailure');
  });

  it('falls back to Error when the name is missing or not a string', () => {
    const blank = new Error('s3cret');
    blank.name = '';
    expect(errorName(blank)).toBe('Error');
    const odd = new Error('s3cret');
    (odd as { name: unknown }).name = 42;
    expect(errorName(odd)).toBe('Error');
  });

  it('is the type of anything thrown that is not an Error', () => {
    expect(errorName('s3cret')).toBe('string');
    expect(errorName(42)).toBe('number');
    expect(errorName({ message: 's3cret' })).toBe('object');
    expect(errorName(undefined)).toBe('undefined');
    expect(errorName(null)).toBe('null');
  });
});
