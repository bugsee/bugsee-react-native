jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

jest.mock('../../data/validate', () => {
  const actual = jest.requireActual('../../data/validate') as typeof import('../../data/validate');
  return {
    ...actual,
    copyEventParams(data: unknown) {
      if (
        data !== null &&
        typeof data === 'object' &&
        Object.prototype.hasOwnProperty.call(data, 'throwString')
      ) {
        throw 'not-an-error';
      }
      return actual.copyEventParams(data as never);
    },
  };
});

import { copyBreadcrumbData } from '../data';

describe('copyBreadcrumbData', () => {
  it('copies a plain object, including a null prototype, and drops undefined members', () => {
    const bare: Record<string, unknown> = Object.create(null);
    bare.a = 1;
    bare.b = undefined;
    const copy = copyBreadcrumbData(bare);
    expect(copy).toEqual({ a: 1 });
    expect(copy).not.toBe(bare);
    bare.a = 2;
    expect(copy).toEqual({ a: 1 });
  });

  it('names the kind of value that is not a plain object', () => {
    expect(() => copyBreadcrumbData(null)).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got null',
    );
    expect(() => copyBreadcrumbData(undefined)).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got undefined',
    );
    expect(() => copyBreadcrumbData('note')).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got string',
    );
    expect(() => copyBreadcrumbData(1)).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got number',
    );
    expect(() => copyBreadcrumbData(false)).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got boolean',
    );
    expect(() => copyBreadcrumbData(['a'])).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got array',
    );
    expect(() => copyBreadcrumbData(new Date(0))).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got object',
    );
    class Box {}
    expect(() => copyBreadcrumbData(new Box())).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got object',
    );
    expect(() => copyBreadcrumbData(Object.create(Object.create(null)))).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got object',
    );
  });

  it('rewrites every params path to data', () => {
    expect(() => copyBreadcrumbData({ when: new Date(0) })).toThrow(
      'data.when must be a plain object, an array, a string, a finite number, a boolean or null; got Date',
    );
    expect(() => copyBreadcrumbData({ params: new Date(0) })).toThrow(
      'data.data must be a plain object, an array, a string, a finite number, a boolean or null; got Date',
    );
    expect(() => copyBreadcrumbData({ n: Number.POSITIVE_INFINITY })).toThrow(
      'data.n must be a finite number',
    );
    expect(() => copyBreadcrumbData({ list: [undefined] })).toThrow(
      'data.list[0] must not be undefined',
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => copyBreadcrumbData(cycle)).toThrow('data.self is a cycle: it contains itself');
  });

  it('rethrows a non-Error unchanged', () => {
    try {
      copyBreadcrumbData({ throwString: true });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBe('not-an-error');
    }
  });
});
