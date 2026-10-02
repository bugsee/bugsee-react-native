// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';

let native: typeof NativeMock;
let Bugsee: {
  setLogFilter(callback?: ((line: string) => unknown) | null): void;
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

function emit(requestId: string, line: string): void {
  native.emitLogFilterRequest({ requestId, line });
}

describe('setLogFilter', () => {
  it('returns a replacement string to native', async () => {
    Bugsee.setLogFilter((line) => `redacted:${line}`);
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledTimes(1);
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', 'redacted:secret');
  });

  it('returns an asynchronous replacement string to native', async () => {
    Bugsee.setLogFilter((line) => Promise.resolve(`redacted:${line}`));
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', 'redacted:secret');
  });

  it('drops a line when the filter throws', async () => {
    Bugsee.setLogFilter(() => {
      throw new Error('boom');
    });
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledTimes(1);
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', null);
  });

  it('drops a line when the filter rejects', async () => {
    Bugsee.setLogFilter(() => Promise.reject(new Error('boom')));
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', null);
  });

  it('a never-settling callback drops rather than resolving with the original line', async () => {
    Bugsee.setLogFilter(() => new Promise(() => {}));
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).not.toHaveBeenCalled();
    const replied = native.replyLogFilter.mock.calls.map((call) => call[1]);
    expect(replied).not.toContain('secret');
  });

  it('drops a line when the filter returns null or undefined', async () => {
    Bugsee.setLogFilter(() => null);
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', null);

    native.replyLogFilter.mockClear();
    Bugsee.setLogFilter(() => undefined);
    emit('2', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledWith('2', null);
  });

  it('a later call replaces the callback', async () => {
    Bugsee.setLogFilter(() => 'first');
    Bugsee.setLogFilter(() => 'second');
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', 'second');
  });

  it('setLogFilter() with no callback clears it', () => {
    Bugsee.setLogFilter(() => 'kept');
    expect(native.setLogFilterEnabled).toHaveBeenLastCalledWith(true);
    Bugsee.setLogFilter();
    expect(native.setLogFilterEnabled).toHaveBeenLastCalledWith(false);
  });

  it('does not run the callback before the native request returns', () => {
    let ran = false;
    Bugsee.setLogFilter(() => {
      ran = true;
      return 'kept';
    });
    emit('1', 'secret');
    expect(ran).toBe(false);
    expect(native.replyLogFilter).not.toHaveBeenCalled();
  });

  it('subscribes to the native request once', () => {
    Bugsee.setLogFilter(() => 'a');
    Bugsee.setLogFilter(() => 'b');
    Bugsee.setLogFilter();
    Bugsee.setLogFilter(() => 'c');
    expect(native.logFilterRequestSubscribeCallCount()).toBe(1);
  });

  it('rejects a non-function and keeps the filter already installed', async () => {
    Bugsee.setLogFilter((line) => `kept:${line}`);
    const set = Bugsee.setLogFilter as (callback?: unknown) => void;
    expect(() => set(1)).toThrow(
      new TypeError('Bugsee.setLogFilter requires a function, got number'),
    );
    emit('1', 'secret');
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledTimes(1);
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', 'kept:secret');
  });

  it('does not subscribe until a function is installed', () => {
    Bugsee.setLogFilter();
    Bugsee.setLogFilter(null);
    expect(native.logFilterRequestSubscribeCallCount()).toBe(0);
    expect(native.setLogFilterEnabled).toHaveBeenLastCalledWith(false);
    Bugsee.setLogFilter(() => 'a');
    expect(native.logFilterRequestSubscribeCallCount()).toBe(1);
  });

  it('a cleared filter drops the line before the native request returns', async () => {
    Bugsee.setLogFilter(() => 'kept');
    Bugsee.setLogFilter();
    emit('1', 'secret');
    expect(native.replyLogFilter).toHaveBeenCalledTimes(1);
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', null);
    await flush();
    expect(native.replyLogFilter).toHaveBeenCalledTimes(1);
    expect(native.replyLogFilter).toHaveBeenCalledWith('1', null);
  });
});
