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

beforeEach(() => native.reset());

describe('getHostLaunchOptions', () => {
  it('returns what native reports', async () => {
    native.getHostLaunchOptions.mockResolvedValue({
      'com.bugsee.option.reporting.triggers.shake': false,
    });
    await expect(Bugsee.getHostLaunchOptions()).resolves.toEqual({
      'com.bugsee.option.reporting.triggers.shake': false,
    });
  });
});

describe('relaunch', () => {
  const hosted = {
    'com.bugsee.option.reporting.triggers.shake': false,
    'com.bugsee.option.capture.logs.level': 2,
  };

  it('with no argument replays the options the app supplied, so nothing resets', async () => {
    native.getHostLaunchOptions.mockResolvedValue(hosted);
    await Bugsee.relaunch();
    expect(native.relaunch).toHaveBeenCalledWith(hosted);
  });

  it('with an argument sends exactly that and never asks for the host options', async () => {
    native.getHostLaunchOptions.mockResolvedValue(hosted);
    const next = { 'com.bugsee.option.capture.logs': false };
    await Bugsee.relaunch(next);
    expect(native.relaunch).toHaveBeenCalledWith(next);
    expect(native.getHostLaunchOptions).not.toHaveBeenCalled();
  });

  it('with an explicit empty map still resets to the SDK defaults', async () => {
    native.getHostLaunchOptions.mockResolvedValue(hosted);
    await Bugsee.relaunch({});
    expect(native.relaunch).toHaveBeenCalledWith({});
    expect(native.getHostLaunchOptions).not.toHaveBeenCalled();
  });

  it('sends an empty map when the app supplied nothing', async () => {
    native.getHostLaunchOptions.mockResolvedValue({});
    await Bugsee.relaunch();
    expect(native.relaunch).toHaveBeenCalledWith({});
  });

  it('does not relaunch when the host options cannot be read, rather than resetting every setting', async () => {
    native.getHostLaunchOptions.mockRejectedValue(new Error('x'));
    await expect(Bugsee.relaunch()).rejects.toThrow();
    expect(native.relaunch).not.toHaveBeenCalled();
  });
});

describe('platform-specific calls forward to native', () => {
  it('resetVideoCapturePermission', () => {
    Bugsee.resetVideoCapturePermission();
    expect(native.resetVideoCapturePermission).toHaveBeenCalledTimes(1);
  });

  it('addSecureActivity and removeSecureActivity pass the class name', () => {
    Bugsee.addSecureActivity('com.example.MainActivity');
    Bugsee.removeSecureActivity('com.example.MainActivity');
    expect(native.addSecureActivity).toHaveBeenCalledWith('com.example.MainActivity');
    expect(native.removeSecureActivity).toHaveBeenCalledWith('com.example.MainActivity');
  });

  it('isSecureActivity returns the native answer', async () => {
    native.isSecureActivity.mockResolvedValue(true);
    await expect(Bugsee.isSecureActivity('com.example.A')).resolves.toBe(true);
    expect(native.isSecureActivity).toHaveBeenCalledWith('com.example.A');
  });
});
