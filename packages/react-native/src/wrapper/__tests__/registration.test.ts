import { native } from '../../__mocks__/native';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', constants: { reactNativeVersion: { major: 0, minor: 87, patch: 1 } } },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import Bugsee, { PACKAGE_VERSION, WRAPPER_TYPE } from '../../index';

beforeEach(() => native.reset());

describe('registering the wrapper', () => {
  // The SDK reads the wrapper while composing a report's environment, so a
  // crash during start-up would otherwise produce a report that cannot say
  // which wrapper it came from.
  it('happens before launch, not after', async () => {
    const order: string[] = [];
    native.setWrapperInfo.mockImplementation(() => order.push('wrapper'));
    native.launch.mockImplementation(() => {
      order.push('launch');
      return Promise.resolve(true);
    });

    await Bugsee.launch('tok');
    expect(order).toEqual(['wrapper', 'launch']);
  });

  it('sends the type, version and context', async () => {
    await Bugsee.launch('tok');
    expect(native.setWrapperInfo).toHaveBeenCalledTimes(1);
    const identity = native.setWrapperInfo.mock.calls[0]?.[0];
    expect(identity).toMatchObject({
      type: WRAPPER_TYPE,
      version: PACKAGE_VERSION,
      context: expect.objectContaining({ 'react-native': '0.87.1' }),
    });
  });

  // relaunch restarts the SDK, which re-reads the wrapper.
  it('happens again on relaunch', async () => {
    await Bugsee.relaunch();
    expect(native.setWrapperInfo).toHaveBeenCalledTimes(1);
  });

  // A rejected token must not leave a wrapper registered for a session that
  // never starts.
  it('does not register when the token is refused', async () => {
    await expect(Bugsee.launch('  ')).rejects.toThrow();
    expect(native.setWrapperInfo).not.toHaveBeenCalled();
  });
});

describe('the reported version', () => {
  it('is the package version, not a copy of it', () => {
    const pkg = require('../../../package.json') as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
