jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';
import { jsonOf } from '../../__mocks__/native';

let native: typeof NativeMock;
let Bugsee: {
  setBreadcrumbFilter(callback?: ((crumb: Record<string, unknown>) => unknown) | null): void;
  addBreadcrumb(crumb: {
    category: string;
    level: string;
    message: string;
    type: string;
  }): void;
};

beforeEach(() => {
  jest.resetModules();
  ({ native } = require('../../__mocks__/native'));
  Bugsee = require('../../index').default;
});

/** Drains the microtask queue the filter's reply is scheduled on. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function emit(requestId: string, crumb: Record<string, unknown>): void {
  native.emitBreadcrumbFilterRequest({
    requestId,
    crumbJson: JSON.stringify(crumb),
  });
}

const snapshot = {
  category: 'ui',
  level: 'info',
  message: 'secret',
  type: 'navigation',
  timestamp: 50,
};

describe('setBreadcrumbFilter', () => {
  it('sends a keep that echoes the writable keys, with level as its name', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'secret',
        type: 'navigation',
        level: 'info',
      }),
    );
    const replied = native.replyBreadcrumbFilter.mock.calls[0]?.[1] as string;
    expect(JSON.parse(replied)).not.toHaveProperty('timestamp');
  });

  it('shows the callback the level name, and a rewrite is what is sent back', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => {
      expect(crumb.level).toBe('info');
      expect(crumb.timestamp).toBe(50);
      return { ...crumb, message: 'redacted', level: 'error' };
    });
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'redacted',
        type: 'navigation',
        level: 'error',
      }),
    );
  });

  it('keeps data, clears it with null, and does not add a key the snapshot omitted', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, data: { id: 1 } }));
    emit('1', { ...snapshot, data: { id: 7 } });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'secret',
        type: 'navigation',
        level: 'info',
        data: { id: 1 },
      }),
    );

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, data: null }));
    emit('2', { ...snapshot, data: { id: 7 } });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '2',
      jsonOf({
        category: 'ui',
        message: 'secret',
        type: 'navigation',
        level: 'info',
        data: null,
      }),
    );

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, data: { leaked: true } }));
    emit('3', snapshot);
    await flush();
    const replied = native.replyBreadcrumbFilter.mock.calls[0]?.[1] as string;
    expect(JSON.parse(replied)).not.toHaveProperty('data');
  });

  it('drops a crumb when a writable key is missing or undefined', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => {
      const next = { ...crumb };
      delete next.message;
      return next;
    });
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, category: undefined }));
    emit('2', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => {
      const next = { ...crumb };
      delete next.data;
      return next;
    });
    emit('3', { ...snapshot, data: { id: 1 } });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('3', null);
  });

  it('drops a crumb when the filter throws', async () => {
    Bugsee.setBreadcrumbFilter(() => {
      throw new Error('boom');
    });
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);
  });

  it('drops a crumb when the filter rejects', async () => {
    Bugsee.setBreadcrumbFilter(() => Promise.reject(new Error('boom')));
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);
  });

  it('drops a crumb when the filter returns null, undefined, or a non-object', async () => {
    Bugsee.setBreadcrumbFilter(() => null);
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter(() => undefined);
    emit('2', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter(() => 'secret');
    emit('3', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('3', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter(() => 1);
    emit('4', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('4', null);
  });

  it('a never-settling callback does not reply, and the next crumb still can', async () => {
    Bugsee.setBreadcrumbFilter(() => new Promise(() => {}));
    emit('hang', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).not.toHaveBeenCalled();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, message: 'later' }));
    emit('2', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '2',
      jsonOf({
        category: 'ui',
        message: 'later',
        type: 'navigation',
        level: 'info',
      }),
    );
    expect(native.replyBreadcrumbFilter.mock.calls.map((call) => call[0])).not.toContain('hang');
  });

  it('a later call replaces the callback', async () => {
    Bugsee.setBreadcrumbFilter(() => ({ ...snapshot, level: 'debug' }));
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, message: 'second' }));
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'second',
        type: 'navigation',
        level: 'info',
      }),
    );
  });

  it('setBreadcrumbFilter() and null clear it', () => {
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(true);
    Bugsee.setBreadcrumbFilter();
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(false);
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    Bugsee.setBreadcrumbFilter(null);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(false);
  });

  it('does not run the callback before the native request returns', () => {
    let ran = false;
    Bugsee.setBreadcrumbFilter((crumb) => {
      ran = true;
      return crumb;
    });
    emit('1', snapshot);
    expect(ran).toBe(false);
    expect(native.replyBreadcrumbFilter).not.toHaveBeenCalled();
  });

  it('subscribes once, and before the native filter is installed', () => {
    const original = native.onBreadcrumbFilterRequest.bind(native);
    native.onBreadcrumbFilterRequest = (listener) => {
      expect(native.setBreadcrumbFilterEnabled).not.toHaveBeenCalled();
      return original(listener);
    };
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenCalledWith(true);
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    Bugsee.setBreadcrumbFilter();
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    expect(native.breadcrumbFilterRequestSubscribeCallCount()).toBe(1);
  });

  it('rejects a non-function and keeps the filter already installed', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, message: 'kept' }));
    const set = Bugsee.setBreadcrumbFilter as (callback?: unknown) => void;
    expect(() => set(1)).toThrow(
      new TypeError('Bugsee.setBreadcrumbFilter requires a function, got number'),
    );
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'kept',
        type: 'navigation',
        level: 'info',
      }),
    );
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe until a function is installed', () => {
    Bugsee.setBreadcrumbFilter();
    Bugsee.setBreadcrumbFilter(null);
    expect(native.breadcrumbFilterRequestSubscribeCallCount()).toBe(0);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(false);
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    expect(native.breadcrumbFilterRequestSubscribeCallCount()).toBe(1);
  });

  it('a cleared filter drops the crumb before the native request returns', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    Bugsee.setBreadcrumbFilter();
    emit('1', snapshot);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
  });

  it('redacts a crumb added on the same turn as the clear, and drops any other', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => ({
      ...crumb,
      message: String(crumb.message).replace('SECRET', 'REDACTED'),
    }));
    Bugsee.addBreadcrumb({
      category: 'ui',
      level: 'info',
      message: 'probe SECRET',
      type: 'user',
    });
    Bugsee.setBreadcrumbFilter(null);
    emit('1', { ...snapshot, message: 'probe SECRET', type: 'user' });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'probe REDACTED',
        type: 'user',
        level: 'info',
      }),
    );
    const replied = native.replyBreadcrumbFilter.mock.calls[0]?.[1] as string;
    expect(replied).not.toContain('SECRET');

    native.replyBreadcrumbFilter.mockClear();
    emit('2', { ...snapshot, message: 'probe SECRET', type: 'user' });
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);

    native.replyBreadcrumbFilter.mockClear();
    emit('3', snapshot);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('3', null);
  });

  it('drops a snapshot whose level is not a name', async () => {
    let ran = false;
    Bugsee.setBreadcrumbFilter((crumb) => {
      ran = true;
      return crumb;
    });
    emit('1', { ...snapshot, level: 2 });
    await flush();
    expect(ran).toBe(false);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);

    native.replyBreadcrumbFilter.mockClear();
    ran = false;
    emit('2', { ...snapshot, level: 'verbose' });
    await flush();
    expect(ran).toBe(false);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);

    native.replyBreadcrumbFilter.mockClear();
    ran = false;
    emit('3', { ...snapshot, level: '' });
    await flush();
    expect(ran).toBe(false);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('3', null);
  });

  it('drops a snapshot that is not a JSON object, without calling the filter', async () => {
    let ran: boolean;
    Bugsee.setBreadcrumbFilter(() => {
      ran = true;
      return {};
    });
    for (const [id, json] of [
      ['bad', '{'],
      ['empty', ''],
      ['null', 'null'],
      ['array', '[]'],
      ['number', '1'],
      ['string', '"ui"'],
      ['bool', 'true'],
    ] as const) {
      native.replyBreadcrumbFilter.mockClear();
      ran = false;
      native.emitBreadcrumbFilterRequest({ requestId: id, crumbJson: json });
      await flush();
      expect(ran).toBe(false);
      expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
      expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(id, null);
    }
  });

  it('drops a snapshot whose string field is not a string, without calling the filter', async () => {
    let ran: boolean;
    Bugsee.setBreadcrumbFilter(() => {
      ran = true;
      return {};
    });
    for (const [id, crumb] of [
      ['category', { ...snapshot, category: 1 }],
      ['message', { ...snapshot, message: null }],
      ['type', { ...snapshot, type: false }],
    ] as const) {
      native.replyBreadcrumbFilter.mockClear();
      ran = false;
      emit(id, crumb);
      await flush();
      expect(ran).toBe(false);
      expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(id, null);
    }
  });

  it('keeps a crumb that omits a key, and does not let the callback add it back', async () => {
    const seen: Array<Record<string, unknown>> = [];
    Bugsee.setBreadcrumbFilter((crumb) => {
      seen.push(crumb);
      return { ...crumb, category: 'injected', message: 'injected', type: 'injected', level: 'error', data: { leaked: true } };
    });

    emit('no-category', { level: 'info', message: 'secret', type: 'navigation' });
    await flush();
    expect(seen[0]).not.toHaveProperty('category');
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      'no-category',
      jsonOf({ message: 'injected', type: 'injected', level: 'error' }),
    );

    native.replyBreadcrumbFilter.mockClear();
    emit('no-message', { category: 'ui', level: 'warning', type: 'navigation' });
    await flush();
    expect(seen[1]).not.toHaveProperty('message');
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      'no-message',
      jsonOf({ category: 'injected', type: 'injected', level: 'error' }),
    );

    native.replyBreadcrumbFilter.mockClear();
    emit('no-type', { category: 'ui', level: 'fatal', message: 'secret' });
    await flush();
    expect(seen[2]).not.toHaveProperty('type');
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      'no-type',
      jsonOf({ category: 'injected', message: 'injected', level: 'error' }),
    );

    native.replyBreadcrumbFilter.mockClear();
    emit('level-only', { level: 'debug' });
    await flush();
    expect(seen[3]).toEqual({ level: 'debug' });
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('level-only', jsonOf({ level: 'error' }));
  });

  it('shows a numeric timestamp, including 0, and ignores one that is not a number', async () => {
    const seen: unknown[] = [];
    Bugsee.setBreadcrumbFilter((crumb) => {
      seen.push(crumb.timestamp);
      return crumb;
    });
    emit('zero', { ...snapshot, timestamp: 0 });
    await flush();
    expect(seen).toEqual([0]);

    native.replyBreadcrumbFilter.mockClear();
    emit('text', { ...snapshot, timestamp: '50' });
    await flush();
    expect(seen[1]).toBeUndefined();
    expect(seen).toHaveLength(2);

    native.replyBreadcrumbFilter.mockClear();
    emit('absent', { category: 'ui', level: 'info', message: 'secret', type: 'navigation' });
    await flush();
    expect(seen[2]).toBeUndefined();
    const replied = native.replyBreadcrumbFilter.mock.calls[0]?.[1] as string;
    expect(JSON.parse(replied)).not.toHaveProperty('timestamp');
  });

  it('drops a keep whose level or string field is not valid', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, level: 'verbose' }));
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, level: 2 }));
    emit('2', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => {
      const next = { ...crumb };
      delete next.level;
      return next;
    });
    emit('3', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('3', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, category: 1, message: null, type: false }));
    emit('4', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('4', null);
  });

  it('drops a keep whose data is undefined or not a plain object', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, data: undefined }));
    emit('1', { ...snapshot, data: { id: 1 } });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, data: new Date(0) }));
    emit('2', { ...snapshot, data: { id: 1 } });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, data: ['a'] }));
    emit('3', { ...snapshot, data: { id: 1 } });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('3', null);
  });

  it('drops an array or a function returned as the keep', async () => {
    Bugsee.setBreadcrumbFilter(() => [] as unknown as object);
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);

    native.replyBreadcrumbFilter.mockClear();
    Bugsee.setBreadcrumbFilter(() => (function keep() {}) as unknown as object);
    emit('2', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);
  });

  it('uses the callback that was current when the request arrived', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, message: 'first' }));
    emit('1', snapshot);
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, message: 'second' }));
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'first',
        type: 'navigation',
        level: 'info',
      }),
    );
    native.replyBreadcrumbFilter.mockClear();
    emit('2', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '2',
      jsonOf({
        category: 'ui',
        message: 'second',
        type: 'navigation',
        level: 'info',
      }),
    );
  });

  it('swallows a reply the bridge rejects, and still answers the next crumb', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    native.replyBreadcrumbFilter.mockImplementationOnce(() => {
      throw new Error('bridge is gone');
    });
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
    emit('2', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(2);
    expect(native.replyBreadcrumbFilter).toHaveBeenLastCalledWith(
      '2',
      jsonOf({
        category: 'ui',
        message: 'secret',
        type: 'navigation',
        level: 'info',
      }),
    );
  });

  it('keeps a crumb that has no level, and does not invent one', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => ({ ...crumb, level: 'error' }));
    emit('no-level', { category: 'ui', message: 'secret', type: 'navigation' });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      'no-level',
      jsonOf({ category: 'ui', message: 'secret', type: 'navigation' }),
    );
  });

  it('drops a keep whose level or data is inherited rather than own', async () => {
    const levelProto = { level: 'error' };
    const levelKeep: Record<string, unknown> = Object.create(levelProto);
    levelKeep.category = 'ui';
    levelKeep.message = 'secret';
    levelKeep.type = 'navigation';
    Bugsee.setBreadcrumbFilter(() => levelKeep);
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);

    native.replyBreadcrumbFilter.mockClear();
    const dataProto = { data: { id: 9 } };
    const dataKeep: Record<string, unknown> = Object.create(dataProto);
    dataKeep.category = 'ui';
    dataKeep.message = 'secret';
    dataKeep.type = 'navigation';
    dataKeep.level = 'info';
    Bugsee.setBreadcrumbFilter(() => dataKeep);
    emit('2', { ...snapshot, data: { id: 1 } });
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('2', null);
  });

  it('rejects a non-function of every other kind and leaves the installed filter', () => {
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    const set = Bugsee.setBreadcrumbFilter as (callback?: unknown) => void;
    expect(() => set({ nope: true })).toThrow(
      'Bugsee.setBreadcrumbFilter requires a function, got object',
    );
    expect(() => set(Symbol('filter'))).toThrow(
      'Bugsee.setBreadcrumbFilter requires a function, got symbol',
    );
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenCalledTimes(1);
    expect(native.breadcrumbFilterRequestSubscribeCallCount()).toBe(1);
  });
});
