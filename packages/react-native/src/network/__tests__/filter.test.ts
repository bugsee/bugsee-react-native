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
  body?: string | null;
  headers?: Record<string, string> | null;
  mechanism: string | null;
  type: string | null;
  websocketEvent: string | null;
  responseCode: number;
  errorDescription?: string | null;
  errorShortMessage?: string | null;
  statusText?: string | null;
  redirectedFromURL?: string | null;
  error?: Record<string, unknown> | null;
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
    }).toThrow(new TypeError('Bugsee.setNetworkFilter requires a function, got string'));
    emit('1');
    await flush();
    expect(repliedEvent(0)?.url).toBe('https://kept.example');
  });

  it('a partial object that omits body and headers replies null', async () => {
    Bugsee.setNetworkFilter(() => ({ url: 'https://redacted' }));
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('deleting body, or setting it undefined, replies null', async () => {
    Bugsee.setNetworkFilter((event) => {
      const next = { ...event };
      delete (next as { body?: string | null }).body;
      return next;
    });
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);

    native.replyNetworkFilter.mockClear();
    Bugsee.setNetworkFilter((event) => ({ ...event, body: undefined }));
    emit('2');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('2', null);
  });

  it('body null when the key was present is kept', async () => {
    Bugsee.setNetworkFilter((event) => ({ ...event, body: null }));
    emit('1', { ...ORIGINAL, body: 'secret' });
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    expect(payload).toContain('"body":null');
    expect(repliedEvent(0)?.url).toBe(ORIGINAL.url);
  });

  it('a spread that changes url and keeps every key the snapshot sent is kept', async () => {
    Bugsee.setNetworkFilter((event) => ({ ...event, url: 'https://redacted.example/path' }));
    emit('1');
    await flush();
    const parsed = repliedEvent(0);
    expect(parsed?.url).toBe('https://redacted.example/path');
    expect(parsed).toHaveProperty('body');
    expect(parsed).toHaveProperty('headers');
  });

  it('a spread of an event whose snapshot omitted body is kept without a body key', async () => {
    const { body: _body, ...withoutBody } = ORIGINAL;
    Bugsee.setNetworkFilter((event) => ({ ...event, url: 'wss://example/hot?redacted' }));
    native.emitNetworkFilterRequest({
      requestId: '1',
      eventJson: JSON.stringify(withoutBody),
    });
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.url).toBe('wss://example/hot?redacted');
    expect(Object.prototype.hasOwnProperty.call(parsed, 'body')).toBe(false);
    expect(payload).not.toContain('"body"');
  });

  it('subscribes to native requests once', () => {
    Bugsee.setNetworkFilter((event) => event);
    Bugsee.setNetworkFilter((event) => event);
    Bugsee.setNetworkFilter();
    Bugsee.setNetworkFilter((event) => event);
    expect(native.networkFilterRequestSubscribeCallCount()).toBe(1);
  });

  it('does not subscribe until a function is installed', () => {
    Bugsee.setNetworkFilter();
    Bugsee.setNetworkFilter(null);
    expect(native.networkFilterRequestSubscribeCallCount()).toBe(0);
    expect(native.setNetworkFilterEnabled).toHaveBeenLastCalledWith(false);
    Bugsee.setNetworkFilter((event) => event);
    expect(native.networkFilterRequestSubscribeCallCount()).toBe(1);
  });

  it('a cleared filter drops the event before the native request returns', async () => {
    Bugsee.setNetworkFilter((event) => event);
    Bugsee.setNetworkFilter();
    emit('1');
    expect(native.replyNetworkFilter).toHaveBeenCalledTimes(1);
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledTimes(1);
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('malformed event JSON drops the event before the native request returns', () => {
    Bugsee.setNetworkFilter((event) => event);
    native.emitNetworkFilterRequest({ requestId: '1', eventJson: '{' });
    expect(native.replyNetworkFilter).toHaveBeenCalledTimes(1);
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('omitting url replies null', async () => {
    Bugsee.setNetworkFilter((event) => {
      const next = { ...event };
      delete (next as { url?: string | null }).url;
      return next;
    });
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('omitting headers when the snapshot sent them replies null', async () => {
    Bugsee.setNetworkFilter((event) => {
      const next = { ...event };
      delete (next as { headers?: Record<string, string> | null }).headers;
      return next;
    });
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('a spread of an event whose snapshot omitted headers is kept without a headers key', async () => {
    const { headers: _headers, ...withoutHeaders } = ORIGINAL;
    Bugsee.setNetworkFilter((event) => ({ ...event, url: 'https://redacted.example/path' }));
    native.emitNetworkFilterRequest({
      requestId: '1',
      eventJson: JSON.stringify(withoutHeaders),
    });
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.url).toBe('https://redacted.example/path');
    expect(Object.prototype.hasOwnProperty.call(parsed, 'headers')).toBe(false);
  });

  it('a function replacement replies null', async () => {
    Bugsee.setNetworkFilter(() => {
      const result = function replacement() {
        return undefined;
      };
      const tagged = result as unknown as { url: string; body: null; headers: null };
      tagged.url = 'https://redacted.example';
      tagged.body = null;
      tagged.headers = null;
      return result;
    });
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('an array replacement replies null', async () => {
    Bugsee.setNetworkFilter(() => {
      const result = [] as unknown as { url: string; body: null; headers: null };
      result.url = 'https://redacted.example';
      result.body = null;
      result.headers = null;
      return result;
    });
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('body null from a snapshot that omitted body is left out of the reply', async () => {
    const { body: _body, ...withoutBody } = ORIGINAL;
    Bugsee.setNetworkFilter((event) => ({ ...event, body: event.body ?? null }));
    native.emitNetworkFilterRequest({
      requestId: '1',
      eventJson: JSON.stringify(withoutBody),
    });
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    expect(payload).not.toBeNull();
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.url).toBe(ORIGINAL.url);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'body')).toBe(false);
    expect(payload).not.toContain('"body"');
  });

  it('headers null from a snapshot that omitted headers is left out of the reply', async () => {
    const { headers: _headers, ...withoutHeaders } = ORIGINAL;
    Bugsee.setNetworkFilter((event) => ({ ...event, headers: event.headers ?? null }));
    native.emitNetworkFilterRequest({
      requestId: '1',
      eventJson: JSON.stringify(withoutHeaders),
    });
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    expect(payload).not.toBeNull();
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'headers')).toBe(false);
    expect(payload).not.toContain('"headers"');
  });

  it('echoes android fields the snapshot sent, including null', async () => {
    const event: NetworkEvent = {
      ...ORIGINAL,
      errorDescription: null,
      errorShortMessage: 'late',
      statusText: null,
    };
    Bugsee.setNetworkFilter((received) => ({ ...received }));
    emit('1', event);
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.errorDescription).toBeNull();
    expect(parsed.errorShortMessage).toBe('late');
    expect(parsed.statusText).toBeNull();
    expect(payload).toContain('"errorDescription":null');
    expect(payload).toContain('"statusText":null');
  });

  it('omitting an android field the snapshot sent replies null', async () => {
    const event: NetworkEvent = {
      ...ORIGINAL,
      errorDescription: 'gateway',
      errorShortMessage: null,
      statusText: 'OK',
    };
    Bugsee.setNetworkFilter((received) => {
      const next = { ...received };
      delete (next as { statusText?: string | null }).statusText;
      return next;
    });
    emit('1', event);
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });

  it('echoes ios fields the snapshot sent, including null', async () => {
    const event: NetworkEvent = {
      ...ORIGINAL,
      redirectedFromURL: null,
      error: { domain: 'NSURLErrorDomain', code: -1009 },
    };
    Bugsee.setNetworkFilter((received) => ({ ...received, url: 'https://redacted.example/path' }));
    emit('1', event);
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.url).toBe('https://redacted.example/path');
    expect(parsed.redirectedFromURL).toBeNull();
    expect(parsed.error).toEqual({ domain: 'NSURLErrorDomain', code: -1009 });
    expect(payload).toContain('"redirectedFromURL":null');
  });

  it('json null for an ios field the snapshot sent is echoed', async () => {
    const event: NetworkEvent = {
      ...ORIGINAL,
      redirectedFromURL: 'https://example/old',
      error: null,
    };
    Bugsee.setNetworkFilter((received) => ({ ...received, redirectedFromURL: null, error: null }));
    emit('1', event);
    await flush();
    const payload = native.replyNetworkFilter.mock.calls[0]?.[1] as string;
    expect(payload).toContain('"redirectedFromURL":null');
    expect(payload).toContain('"error":null');
  });

  it('a circular replacement replies null', async () => {
    Bugsee.setNetworkFilter(() => {
      const result: Record<string, unknown> = {
        url: 'https://redacted.example',
        body: null,
        headers: null,
      };
      result.self = result;
      return result;
    });
    emit('1');
    await flush();
    expect(native.replyNetworkFilter).toHaveBeenCalledTimes(1);
    expect(native.replyNetworkFilter).toHaveBeenCalledWith('1', null);
  });
});
