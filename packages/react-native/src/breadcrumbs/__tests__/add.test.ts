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

  it('rejects a non-object, a bad level, and a non-object data value', () => {
    const add = Bugsee.addBreadcrumb as (crumb?: unknown) => void;
    expect(() => add(null)).toThrow(TypeError);
    expect(() => add({ ...crumb, level: 'verbose' })).toThrow(
      /level must be one of debug, info, warning, error, fatal, got verbose/,
    );
    expect(() => add({ ...crumb, category: 1 })).toThrow(
      /category must be a string, got number/,
    );
    expect(() => add({ ...crumb, data: new Date(0) })).toThrow(TypeError);
    expect(native.addBreadcrumb).not.toHaveBeenCalled();
  });
});
