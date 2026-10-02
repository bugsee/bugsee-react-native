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
});
