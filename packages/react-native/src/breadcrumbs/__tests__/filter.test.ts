jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';
import { jsonOf } from '../../__mocks__/native';

let native: typeof NativeMock;
let Bugsee: {
  setBreadcrumbFilter(callback?: ((crumb: Record<string, unknown>) => unknown) | null): void;
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

  it('a never-settling callback does not reply with the original crumb', async () => {
    Bugsee.setBreadcrumbFilter(() => new Promise(() => {}));
    emit('1', snapshot);
    await flush();
    expect(native.replyBreadcrumbFilter).not.toHaveBeenCalled();
    const replied = native.replyBreadcrumbFilter.mock.calls.map((call) => call[1]);
    expect(replied).not.toContain(JSON.stringify(snapshot));
    expect(replied).not.toContain('secret');
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
  });
});
