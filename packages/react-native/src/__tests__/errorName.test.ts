import { errorName } from '../errorName';

/**
 * The result, or 'threw' -- never the thrown value itself, which Jest would
 * try to describe by reading the same hostile `name` that threw.
 */
function outcome(run: () => string): string {
  try {
    return run();
  } catch {
    return 'threw';
  }
}

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

  // Called from catch blocks that isolate one failure from the rest
  // (measureLoop, the report dispatcher, the view-tree reply), so it must
  // never throw itself.
  it('never throws: a throwing name getter reads as Error', () => {
    class Weird extends Error {
      override get name(): string {
        throw this;
      }
    }
    expect(outcome(() => errorName(new Weird('s3cret')))).toBe('Error');
  });

  it('never throws: a Proxy whose getPrototypeOf trap throws reads as its type', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          throw new Error('trap');
        },
      },
    );
    expect(outcome(() => errorName(hostile))).toBe('object');
  });
});

