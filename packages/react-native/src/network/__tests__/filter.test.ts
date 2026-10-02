// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';

let native: typeof NativeMock;
let Bugsee: {
  setNetworkFilter(callback?: ((event: NetworkEvent) => unknown) | null): void;
};

interface NetworkEvent {
  id: string | null;
  url: string | null;
  method: string | null;
  body: string | null;
  headers: Record<string, string> | null;
  mechanism: string | null;
  type: string | null;
  websocketEvent: string | null;
  responseCode: number;
}

const ORIGINAL: NetworkEvent = {
  id: 'req-1',
  url: 'https://secret.example/token',
  method: 'GET',
  body: null,
  headers: { Authorization: 'secret' },
  mechanism: 'URLSession',
  type: 'before',
  websocketEvent: null,
  responseCode: 0,
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

function emit(requestId: string, event: NetworkEvent = ORIGINAL): void {
  native.emitNetworkFilterRequest({
    requestId,
    eventJson: JSON.stringify(event),
  });
}

function repliedEvent(call: number): NetworkEvent | null {
  const payload = native.replyNetworkFilter.mock.calls[call]?.[1];
  if (payload == null) {
    return null;
  }
  return JSON.parse(payload) as NetworkEvent;
}

describe('setNetworkFilter', () => {
  it('returns a legal replacement event to native', async () => {
    Bugsee.setNetworkFilter((event) => ({
      ...event,
      url: 'https://redacted.example/path',
    }));
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledTimes(1);
    expect(native.replyNetworkFilter.mock.calls[0]?.[0]).toBe('1');
    expect(repliedEvent(0)?.url).toBe('https://redacted.example/path');
    expect(repliedEvent(0)?.id).toBe('req-1');
  });

  it('answers on a later turn', async () => {
    Bugsee.setNetworkFilter((event) => ({ ...event, url: 'https://kept.example' }));
    emit('1');
    expect(native.replyNetworkFilter).not.toHaveBeenCalled();
    await flush();
    expect(repliedEvent(0)?.url).toBe('https://kept.example');
  });

  it('a promised replacement is what native receives', async () => {
    Bugsee.setNetworkFilter((event) =>
      Promise.resolve({ ...event, url: 'https://redacted.example/later' }),
    );
    emit('1');
    await flush();
    expect(repliedEvent(0)?.url).toBe('https://redacted.example/later');
  });

  it('a throw drops the event', async () => {
    Bugsee.setNetworkFilter(() => {
      throw new Error('boom');
    });
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledTimes(1);
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('a rejection drops the event', async () => {
    Bugsee.setNetworkFilter(() => Promise.reject(new Error('boom')));
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('a callback that never settles does not reply with the original event', async () => {
    Bugsee.setNetworkFilter(() => new Promise(() => {}));
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).not.toHaveBeenCalled();
    const replied = native.replyNetworkFilter.mock.calls.map(
      (call: [string, string | null]) => call[1],
    );
    expect(replied).not.toContain(JSON.stringify(ORIGINAL));
  });

  it('null and undefined drop the event', async () => {
    Bugsee.setNetworkFilter(() => null);
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);

    native.replyNetworkFilter.mockClear();
    Bugsee.setNetworkFilter(() => undefined);
    emit('2');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('2', null);
  });

  it('a string replacement drops the event', async () => {
    Bugsee.setNetworkFilter(() => 'https://not-an-event.example');
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('a later callback replaces the earlier one', async () => {
    Bugsee.setNetworkFilter(() => ({ ...ORIGINAL, url: 'https://first.example' }));
    Bugsee.setNetworkFilter((event) => ({ ...event, url: 'https://second.example' }));
    emit('1');
    await flush();
    expect(repliedEvent(0)?.url).toBe('https://second.example');
  });

  it('setNetworkFilter() with no callback clears it', () => {
    Bugsee.setNetworkFilter((event) => event);
    expect(native.setNetworkFilterEnabled).toHaveBeenLastCalledWith(true);
    Bugsee.setNetworkFilter();
    expect(native.setNetworkFilterEnabled).toHaveBeenLastCalledWith(false);
  });

  it('setNetworkFilter(null) clears it', () => {
    Bugsee.setNetworkFilter((event) => event);
    Bugsee.setNetworkFilter(null);
    expect(native.setNetworkFilterEnabled).toHaveBeenLastCalledWith(false);
  });

  it('a non-function throws and leaves the previous callback in place', async () => {
    Bugsee.setNetworkFilter((event) => ({ ...event, url: 'https://kept.example' }));
    expect(() => {
      Bugsee.setNetworkFilter('nope' as unknown as () => null);
    }).toThrow(TypeError);
    emit('1');
    await flush();
    expect(repliedEvent(0)?.url).toBe('https://kept.example');
  });

  it('subscribes to native requests once', () => {
    Bugsee.setNetworkFilter((event) => event);
    Bugsee.setNetworkFilter((event) => event);
    Bugsee.setNetworkFilter();
    Bugsee.setNetworkFilter((event) => event);
    expect(native.networkFilterRequestSubscribeCallCount()).toBe(1);
  });
});
