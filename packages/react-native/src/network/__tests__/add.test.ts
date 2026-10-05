// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { jsonOf, native } from '../../__mocks__/native';
import Bugsee from '../../index';
import type { NetworkFilterEvent } from '../filter';

beforeEach(() => native.reset());

describe('addNetworkEvent', () => {
  it('rejects a non-object before crossing', () => {
    for (const value of [null, undefined, 'https://x', 1, true]) {
      expect(() => Bugsee.addNetworkEvent(value as never)).toThrow(
        TypeError,
      );
      expect(() => Bugsee.addNetworkEvent(value as never)).toThrow(
        /Bugsee\.addNetworkEvent requires an object/,
      );
    }
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it('requires a string url and a string method', () => {
    expect(() =>
      Bugsee.addNetworkEvent({ url: 1, method: 'GET' } as never),
    ).toThrow(/string url/);
    expect(() =>
      Bugsee.addNetworkEvent({ url: 'https://x', method: 1 } as never),
    ).toThrow(/string method/);
    expect(() => Bugsee.addNetworkEvent({ method: 'GET' } as never)).toThrow(/string url/);
    expect(() => Bugsee.addNetworkEvent({ url: 'https://x' } as never)).toThrow(
      /string method/,
    );
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it('maps stage completed onto the native complete stage and stamps no timestamp', () => {
    Bugsee.addNetworkEvent({
      url: 'https://e2e.example/keep',
      method: 'GET',
      stage: 'completed',
    });
    expect(native.addNetworkEvent).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(native.addNetworkEvent.mock.calls[0]![0] as string) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      url: 'https://e2e.example/keep',
      method: 'GET',
      stage: 'complete',
    });
    expect(payload).not.toHaveProperty('timestamp');
  });

  it('rejects a stage name that does not map', () => {
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        stage: 'done',
      }),
    ).toThrow(TypeError);
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it('does not run the network filter in JS', () => {
    const filter = jest.fn((event: NetworkFilterEvent) => event);
    Bugsee.setNetworkFilter(filter);
    native.setNetworkFilterEnabled.mockClear();
    Bugsee.addNetworkEvent({
      url: 'https://e2e.example/keep',
      method: 'POST',
      stage: 'completed',
    });
    expect(filter).not.toHaveBeenCalled();
    expect(native.setNetworkFilterEnabled).not.toHaveBeenCalled();
    expect(native.replyNetworkFilter).not.toHaveBeenCalled();
    expect(native.addNetworkEvent).toHaveBeenCalledWith(
      jsonOf({
        url: 'https://e2e.example/keep',
        method: 'POST',
        stage: 'complete',
      }),
    );
  });

  it('forwards the fields a network filter is allowed to keep', () => {
    Bugsee.addNetworkEvent({
      url: 'https://e2e.example/keep',
      method: 'POST',
      stage: 'completed',
      body: 'secret',
      headers: { Authorization: 'Bearer x' },
      responseCode: 201,
      statusText: 'Created',
      errorDescription: 'none',
      errorShortMessage: 'ok',
      redirectedFromURL: 'https://e2e.example/from',
      error: { domain: 'test' },
    });
    expect(native.addNetworkEvent).toHaveBeenCalledWith(
      jsonOf({
        url: 'https://e2e.example/keep',
        method: 'POST',
        stage: 'complete',
        body: 'secret',
        headers: { Authorization: 'Bearer x' },
        responseCode: 201,
        statusText: 'Created',
        errorDescription: 'none',
        errorShortMessage: 'ok',
        redirectedFromURL: 'https://e2e.example/from',
        error: { domain: 'test' },
      }),
    );
  });

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    ['https://x', 'string'],
    [1, 'number'],
    [true, 'boolean'],
    [[], 'array'],
  ])('rejects %j and names the kind %s', (value, kind) => {
    expect(() => Bugsee.addNetworkEvent(value as never)).toThrow(
      `Bugsee.addNetworkEvent requires an object, got ${kind}`,
    );
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'undefined'],
    [null, 'object'],
    [1, 'number'],
  ])('rejects a url of %j', (url, kind) => {
    expect(() =>
      Bugsee.addNetworkEvent({ url, method: 'GET' } as never),
    ).toThrow(`Bugsee.addNetworkEvent requires a string url, got ${kind}`);
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'undefined'],
    [null, 'object'],
    [1, 'number'],
  ])('rejects a method of %j', (method, kind) => {
    expect(() =>
      Bugsee.addNetworkEvent({ url: 'https://e2e.example/keep', method } as never),
    ).toThrow(`Bugsee.addNetworkEvent requires a string method, got ${kind}`);
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it('treats an omitted stage as completed', () => {
    Bugsee.addNetworkEvent({
      url: 'https://e2e.example/keep',
      method: 'GET',
    });
    expect(native.addNetworkEvent).toHaveBeenCalledWith(
      jsonOf({
        url: 'https://e2e.example/keep',
        method: 'GET',
        stage: 'complete',
      }),
    );
  });

  it.each([
    ['complete', 'complete'],
    ['before', 'before'],
    ['started', 'before'],
    ['redirect', 'redirect'],
    ['error', 'error'],
    ['abort', 'abort'],
    ['aborted', 'abort'],
    ['cancel', 'abort'],
    ['timing', 'timing'],
    ['timings', 'timing'],
    ['websocket', 'websocket'],
  ])('maps stage %s onto %s', (stage, wire) => {
    Bugsee.addNetworkEvent({
      url: 'https://e2e.example/keep',
      method: 'GET',
      stage,
    });
    expect(native.addNetworkEvent).toHaveBeenCalledWith(
      jsonOf({
        url: 'https://e2e.example/keep',
        method: 'GET',
        stage: wire,
      }),
    );
  });

  it('rejects a stage that does not map without echoing it', () => {
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        stage: 'done',
      }),
    ).toThrow(new TypeError('Bugsee.addNetworkEvent stage must name a network stage'));
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        stage: 3 as never,
      }),
    ).toThrow(new TypeError('Bugsee.addNetworkEvent stage must name a network stage'));
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it('keeps an id and records null for an optional field that was passed', () => {
    Bugsee.addNetworkEvent({
      url: 'https://e2e.example/keep',
      method: 'GET',
      id: 'evt-1',
      body: null,
      headers: null,
      responseCode: 0,
      statusText: null,
      errorDescription: null,
      errorShortMessage: null,
      redirectedFromURL: null,
      error: null,
    });
    expect(native.addNetworkEvent).toHaveBeenCalledWith(
      jsonOf({
        url: 'https://e2e.example/keep',
        method: 'GET',
        stage: 'complete',
        id: 'evt-1',
        body: null,
        headers: null,
        responseCode: 0,
        statusText: null,
        errorDescription: null,
        errorShortMessage: null,
        redirectedFromURL: null,
        error: null,
      }),
    );
  });

  it('rejects a non-string optional field and a non-finite responseCode', () => {
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        body: 1 as never,
      }),
    ).toThrow('Bugsee.addNetworkEvent body must be a string or null, got number');
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        statusText: 1 as never,
      }),
    ).toThrow('Bugsee.addNetworkEvent statusText must be a string or null, got number');
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        errorDescription: true as never,
      }),
    ).toThrow(
      'Bugsee.addNetworkEvent errorDescription must be a string or null, got boolean',
    );
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        errorShortMessage: true as never,
      }),
    ).toThrow(
      'Bugsee.addNetworkEvent errorShortMessage must be a string or null, got boolean',
    );
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        redirectedFromURL: 1 as never,
      }),
    ).toThrow(
      'Bugsee.addNetworkEvent redirectedFromURL must be a string or null, got number',
    );
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        id: 1 as never,
      }),
    ).toThrow('Bugsee.addNetworkEvent id must be a string or null, got number');
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        responseCode: Number.NaN,
      }),
    ).toThrow(new TypeError('Bugsee.addNetworkEvent responseCode must be a finite number'));
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        responseCode: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(new TypeError('Bugsee.addNetworkEvent responseCode must be a finite number'));
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        responseCode: '201' as never,
      }),
    ).toThrow(new TypeError('Bugsee.addNetworkEvent responseCode must be a finite number'));
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it('rejects headers that are not an object of strings', () => {
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        headers: 'Bearer x' as never,
      }),
    ).toThrow(
      'Bugsee.addNetworkEvent headers must be an object or null, got string',
    );
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        headers: ['Bearer x'] as never,
      }),
    ).toThrow(
      'Bugsee.addNetworkEvent headers must be an object or null, got object',
    );
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        headers: { Authorization: 1 as never },
      }),
    ).toThrow(
      'Bugsee.addNetworkEvent headers.Authorization must be a string, got number',
    );
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });

  it('rejects an error that is not an object', () => {
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        error: 'nope' as never,
      }),
    ).toThrow('Bugsee.addNetworkEvent error must be an object or null, got string');
    expect(() =>
      Bugsee.addNetworkEvent({
        url: 'https://e2e.example/keep',
        method: 'GET',
        error: ['nope'] as never,
      }),
    ).toThrow('Bugsee.addNetworkEvent error must be an object or null, got object');
    expect(native.addNetworkEvent).not.toHaveBeenCalled();
  });
});
