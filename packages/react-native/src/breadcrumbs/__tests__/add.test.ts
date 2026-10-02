jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';
import { jsonOf } from '../../__mocks__/native';

let native: typeof NativeMock;
let Bugsee: {
  addBreadcrumb(crumb: {
    category: string;
    level: string;
    message: string;
    type: string;
    data?: unknown;
    timestamp?: number;
  }): void;
};

beforeEach(() => {
  jest.resetModules();
  ({ native } = require('../../__mocks__/native'));
  Bugsee = require('../../index').default;
});

const crumb = {
  category: 'ui',
  level: 'info',
  message: 'tapped',
  type: 'navigation',
};

describe('addBreadcrumb', () => {
  it.each(['debug', 'info', 'warning', 'error', 'fatal'] as const)(
    'sends the level name %s',
    (level) => {
      Bugsee.addBreadcrumb({ ...crumb, level });
      expect(native.addBreadcrumb).toHaveBeenCalledWith(
        'ui',
        level,
        'tapped',
        'navigation',
        null,
      );
    },
  );

  it('does not require a timestamp and does not send one', () => {
    Bugsee.addBreadcrumb({ ...crumb, timestamp: 123 });
    expect(native.addBreadcrumb).toHaveBeenCalledWith(
      'ui',
      'info',
      'tapped',
      'navigation',
      null,
    );
  });

  it('sends data as JSON and treats null data as no data', () => {
    Bugsee.addBreadcrumb({ ...crumb, data: { id: 1, note: null } });
    expect(native.addBreadcrumb).toHaveBeenCalledWith(
      'ui',
      'info',
      'tapped',
      'navigation',
      jsonOf({ id: 1, note: null }),
    );

    native.addBreadcrumb.mockClear();
    Bugsee.addBreadcrumb({ ...crumb, data: null });
    expect(native.addBreadcrumb).toHaveBeenCalledWith(
      'ui',
      'info',
      'tapped',
      'navigation',
      null,
    );
  });

  it('accepts a null-prototype crumb and an empty string field', () => {
    const bare: Record<string, unknown> = Object.create(null);
    bare.category = '';
    bare.level = 'debug';
    bare.message = '';
    bare.type = '';
    Bugsee.addBreadcrumb(bare as typeof crumb);
    expect(native.addBreadcrumb).toHaveBeenCalledWith('', 'debug', '', '', null);
  });

  it('names the kind of value that is not a crumb object', () => {
    const add = Bugsee.addBreadcrumb as (crumb?: unknown) => void;
    expect(() => add(null)).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got null',
    );
    expect(() => add(undefined)).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got undefined',
    );
    expect(() => add('ui')).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got string',
    );
    expect(() => add(1)).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got number',
    );
    expect(() => add(true)).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got boolean',
    );
    expect(() => add(['ui'])).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got array',
    );
    expect(() => add(new Date(0))).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got object',
    );
    class Box {}
    expect(() => add(new Box())).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got object',
    );
    const child = Object.create(Object.create(null));
    expect(() => add(child)).toThrow(
      'Bugsee.addBreadcrumb requires a crumb object, got object',
    );
    expect(native.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('names which string field was rejected, including null', () => {
    const add = Bugsee.addBreadcrumb as (crumb?: unknown) => void;
    expect(() => add({ ...crumb, category: 1 })).toThrow(
      'Bugsee.addBreadcrumb category must be a string, got number',
    );
    expect(() => add({ ...crumb, category: null })).toThrow(
      'Bugsee.addBreadcrumb category must be a string, got null',
    );
    expect(() => add({ ...crumb, category: undefined })).toThrow(
      'Bugsee.addBreadcrumb category must be a string, got undefined',
    );
    expect(() => add({ ...crumb, message: false })).toThrow(
      'Bugsee.addBreadcrumb message must be a string, got boolean',
    );
    expect(() => add({ ...crumb, message: null })).toThrow(
      'Bugsee.addBreadcrumb message must be a string, got null',
    );
    expect(() => add({ ...crumb, type: 1 })).toThrow(
      'Bugsee.addBreadcrumb type must be a string, got number',
    );
    expect(() => add({ ...crumb, type: null })).toThrow(
      'Bugsee.addBreadcrumb type must be a string, got null',
    );
    expect(native.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('names a level that is not one of the five strings', () => {
    const add = Bugsee.addBreadcrumb as (crumb?: unknown) => void;
    expect(() => add({ ...crumb, level: 'verbose' })).toThrow(
      'Bugsee.addBreadcrumb level must be one of debug, info, warning, error, fatal, got verbose',
    );
    expect(() => add({ ...crumb, level: '' })).toThrow(
      'Bugsee.addBreadcrumb level must be one of debug, info, warning, error, fatal, got ',
    );
    expect(() => add({ ...crumb, level: 2 })).toThrow(
      'Bugsee.addBreadcrumb level must be one of debug, info, warning, error, fatal, got number',
    );
    expect(() => add({ ...crumb, level: null })).toThrow(
      'Bugsee.addBreadcrumb level must be one of debug, info, warning, error, fatal, got object',
    );
    expect(() => add({ ...crumb, level: undefined })).toThrow(
      'Bugsee.addBreadcrumb level must be one of debug, info, warning, error, fatal, got undefined',
    );
    expect(() => add({ ...crumb, level: false })).toThrow(
      'Bugsee.addBreadcrumb level must be one of debug, info, warning, error, fatal, got boolean',
    );
    expect(native.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('rejects data that is not a plain object, and does not send it', () => {
    const add = Bugsee.addBreadcrumb as (crumb?: unknown) => void;
    expect(() => add({ ...crumb, data: ['a'] })).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got array',
    );
    expect(() => add({ ...crumb, data: 'note' })).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got string',
    );
    expect(() => add({ ...crumb, data: new Date(0) })).toThrow(
      'Bugsee.addBreadcrumb data must be a plain object, got object',
    );
    expect(native.addBreadcrumb).not.toHaveBeenCalled();
  });
});
