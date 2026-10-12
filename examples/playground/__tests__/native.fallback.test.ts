jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeView: () => { throw new Error('no view'); },
}));
import { PlaygroundNative } from '../modules/playground-native';

it('is a no-op that says so when the native module is missing', async () => {
  expect(PlaygroundNative.available).toBe(false);
  expect(() => PlaygroundNative.crash('segv')).toThrow('native module unavailable');
  await expect(PlaygroundNative.request('GET', 'https://example.com')).rejects.toThrow('native module unavailable');
});
