jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../exceptions/handlers', () => ({
  installExceptionHandlers: jest.fn(),
  setExceptionCaptureEnabled: jest.fn(),
  setCrashDetectionOptedOut: jest.fn(),
}));
jest.mock('../console/capture', () => ({ installConsoleCapture: jest.fn() }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import Bugsee from '../index';
import { native } from '../__mocks__/native';
import { createDefaultLaunchOptions } from '../options/createDefaultLaunchOptions';
import { resetUnknownOptionWarnings } from '../options/unknownKeys';

const TOKEN = '00000000-0000-4000-8000-000000000000';

describe('launch and relaunch name options the SDK would drop', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    native.reset();
    resetUnknownOptionWarnings();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('warns about a 6.x key in a plain map, and still launches with it', async () => {
    await Bugsee.launch(TOKEN, { ShakeToReport: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ShakeToReport');
    // Warn, never refuse: a key this build does not know may belong to a newer SDK.
    expect(native.launch).toHaveBeenCalledWith(TOKEN, { ShakeToReport: false });
  });

  it('warns on relaunch too', async () => {
    await Bugsee.relaunch({ typo: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('forwards triggerByShake = false untouched and says nothing', async () => {
    const options = createDefaultLaunchOptions('android');
    options.triggerByShake = false;
    await Bugsee.launch(TOKEN, options);
    expect(native.launch).toHaveBeenCalledWith(TOKEN, {
      'com.bugsee.option.reporting.triggers.shake': false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing for an empty map', async () => {
    await Bugsee.launch(TOKEN);
    expect(warn).not.toHaveBeenCalled();
  });
});
