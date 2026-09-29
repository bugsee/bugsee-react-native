// The package entry exports the options model, which reads Platform.OS, so
// importing it loads `react-native` -- which jest cannot parse.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { native } from '../../__mocks__/native';
import Bugsee from '../../index';

beforeEach(() => native.reset());

describe('setUserIdentifier', () => {
  it('forwards a non-empty string', () => {
    Bugsee.setUserIdentifier('user-1');
    expect(native.setUserIdentifier).toHaveBeenCalledWith('user-1');
    expect(native.clearUserIdentifier).not.toHaveBeenCalled();
  });

  it("setUserIdentifier('') clears instead", () => {
    Bugsee.setUserIdentifier('');
    expect(native.clearUserIdentifier).toHaveBeenCalledTimes(1);
    expect(native.setUserIdentifier).not.toHaveBeenCalled();
  });

  it('rejects a non-string with TypeError before crossing', () => {
    for (const bad of [42, null, undefined, {}, []]) {
      expect(() => Bugsee.setUserIdentifier(bad as unknown as string)).toThrow(TypeError);
    }
    expect(native.setUserIdentifier).not.toHaveBeenCalled();
    expect(native.clearUserIdentifier).not.toHaveBeenCalled();
  });

  it('names the type in the TypeError message', () => {
    expect(() => Bugsee.setUserIdentifier(42 as unknown as string)).toThrow(
      'Bugsee.setUserIdentifier requires a string, got number',
    );
    expect(() => Bugsee.setUserIdentifier(null as unknown as string)).toThrow(
      'Bugsee.setUserIdentifier requires a string, got null',
    );
  });
});

describe('getUserIdentifier', () => {
  it('maps {} and {value: ""} to undefined', async () => {
    native.getUserIdentifier.mockResolvedValueOnce({});
    await expect(Bugsee.getUserIdentifier()).resolves.toBeUndefined();

    native.getUserIdentifier.mockResolvedValueOnce({ value: '' });
    await expect(Bugsee.getUserIdentifier()).resolves.toBeUndefined();
  });

  it('unwraps a non-empty value', async () => {
    native.getUserIdentifier.mockResolvedValueOnce({ value: 'user-1' });
    await expect(Bugsee.getUserIdentifier()).resolves.toBe('user-1');
  });

  it('treats a null native result as absent', async () => {
    native.getUserIdentifier.mockResolvedValueOnce(null as unknown as Record<string, unknown>);
    await expect(Bugsee.getUserIdentifier()).resolves.toBeUndefined();
  });
});

describe('clearUserIdentifier', () => {
  it('forwards', () => {
    Bugsee.clearUserIdentifier();
    expect(native.clearUserIdentifier).toHaveBeenCalledTimes(1);
  });
});
